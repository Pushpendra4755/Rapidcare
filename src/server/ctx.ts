import { gpsFreshness, hospitalFreshness } from '../lib/freshness';
import type { RoutingProvider } from '../lib/routing';
import type {
  Ambulance, AppNotification, AuditLog, Hospital, HospitalResourceStatus, Incident, NotificationType, Role, Session,
  TimelineEvent, TimelineType,
} from '../lib/types';
import { ACTIVE_INCIDENT_STATUSES } from '../lib/types';
import { ApiError, Bus, RateLimiter, iso, type Clock } from './core';
import type { Db, StoredAmbulance, StoredUser } from './db';

export interface Actor { id: string | null; label: string; role: Role | 'SYSTEM' }
export const SYSTEM: Actor = { id: null, label: 'System', role: 'SYSTEM' };

export interface NotifyTarget {
  role?: Role; hospitalId?: string; ambulanceId?: string; userId?: string;
}

export interface EmitRef { incidentId?: string | null; hospitalId?: string | null; ambulanceId?: string | null }

/**
 * Shared context for all backend modules: store, clock, realtime bus, routing provider, sessions.
 * Everything that mutates state goes through here so auditing, timelines and realtime events are uniform.
 */
export class Ctx {
  sessions = new Map<string, Session>();
  limiter: RateLimiter;
  bus = new Bus();
  /** Ambulances currently fed by a real device GPS (not the simulator). */
  deviceGps = new Set<string>();
  flags = {
    gpsLost: new Set<string>(),
    capacityStale: new Set<string>(),
    capacity30: new Set<string>(),
    critEscalated: new Set<string>(),
    lastTop: new Map<string, string | null>(),
    lastEtaNotified: new Map<string, number>(),
    sensitiveSeen: new Map<string, number>(),
  };

  constructor(
    public db: Db,
    public clock: Clock,
    public routing: RoutingProvider,
    public demoMode: boolean,
  ) {
    this.limiter = new RateLimiter(clock);
  }

  now() { return this.clock.now(); }
  nowIso() { return iso(this.clock.now()); }
  id(kind: string, prefix: string) { this.db.seq[kind] = (this.db.seq[kind] ?? 0) + 1; return `${prefix}_${this.db.seq[kind]}`; }

  // ---------------------------------------------------------------- audit (append-only)
  audit(actor: Actor, actionType: string, entityType: string, entityId: string, previousValue: unknown, newValue: unknown) {
    const entry: AuditLog = Object.freeze({
      id: this.id('aud', 'aud'), actorUserId: actor.id, actorLabel: `${actor.label}${actor.role === 'SYSTEM' ? '' : ` (${actor.role})`}`,
      actionType, entityType, entityId,
      previousValue: previousValue === undefined ? null : JSON.parse(JSON.stringify(previousValue)),
      newValue: newValue === undefined ? null : JSON.parse(JSON.stringify(newValue)),
      createdAt: this.nowIso(),
    });
    this.db.audit.push(entry);
    if (this.db.audit.length > 5000) this.db.audit.splice(0, 500);
  }

  /** Log sensitive-data access at most once per actor/entity per 10 minutes to keep the log useful. */
  auditSensitive(actor: Actor, entityType: string, entityId: string, what: string) {
    const key = `${actor.id}|${entityType}|${entityId}|${what}`;
    const last = this.flags.sensitiveSeen.get(key) ?? 0;
    if (this.now() - last < 10 * 60_000) return;
    this.flags.sensitiveSeen.set(key, this.now());
    this.audit(actor, 'SENSITIVE_DATA_ACCESS', entityType, entityId, null, { accessed: what });
  }

  // ---------------------------------------------------------------- timeline (immutable)
  timeline(incidentId: string, type: TimelineType, actor: string, message: string, meta?: TimelineEvent['meta']) {
    const ev = Object.freeze({
      id: this.id('tl', 'tl'), incidentId, at: this.nowIso(), type, actor, message, meta: meta ? Object.freeze({ ...meta }) : undefined,
    }) as TimelineEvent;
    this.db.timeline.push(ev);
    return ev;
  }

  // ---------------------------------------------------------------- notifications
  notify(
    to: NotifyTarget,
    o: { type: NotificationType; title: string; message: string; severity?: AppNotification['severity']; requiresAck?: boolean; incidentId?: string | null },
  ): AppNotification {
    const n: AppNotification = {
      id: this.id('ntf', 'ntf'), recipientUserId: to.userId ?? null, recipientHospitalId: to.hospitalId ?? null,
      recipientAmbulanceId: to.ambulanceId ?? null, recipientRole: to.role ?? null, incidentId: o.incidentId ?? null,
      type: o.type, title: o.title, message: o.message, severity: o.severity ?? 'INFO', requiresAck: o.requiresAck ?? false,
      status: 'SENT', sentAt: this.nowIso(), readAt: null, acknowledgedAt: null,
    };
    this.db.notifications.push(n);
    if (this.db.notifications.length > 600) {
      const keep = this.db.notifications.filter((x) => x.status !== 'ACKNOWLEDGED').slice(-400);
      this.db.notifications = keep;
    }
    this.emit('notification', { hospitalId: to.hospitalId, ambulanceId: to.ambulanceId, incidentId: n.incidentId });
    return n;
  }

  // ---------------------------------------------------------------- realtime
  emit(kind: string, ref: EmitRef = {}) {
    const t = this.now();
    this.bus.publish('dispatcher:operations', kind, ref.incidentId ?? ref.hospitalId ?? ref.ambulanceId ?? null, t);
    if (ref.hospitalId) this.bus.publish(`hospital:${ref.hospitalId}`, kind, ref.incidentId ?? null, t);
    if (ref.ambulanceId) this.bus.publish(`ambulance:${ref.ambulanceId}`, kind, ref.incidentId ?? null, t);
    if (ref.incidentId) this.bus.publish(`incident:${ref.incidentId}`, kind, ref.incidentId, t);
  }

  // ---------------------------------------------------------------- lookups
  hospital(id: string): Hospital {
    const h = this.db.hospitals.find((x) => x.id === id);
    if (!h) throw new ApiError(404, 'NOT_FOUND', 'Hospital not found.');
    return h;
  }
  ambulanceRaw(id: string): StoredAmbulance {
    const a = this.db.ambulances.find((x) => x.id === id);
    if (!a) throw new ApiError(404, 'NOT_FOUND', 'Ambulance not found.');
    return a;
  }
  incident(id: string): Incident {
    const i = this.db.incidents.find((x) => x.id === id);
    if (!i) throw new ApiError(404, 'NOT_FOUND', 'Incident not found.');
    return i;
  }
  userById(id: string): StoredUser | undefined { return this.db.users.find((u) => u.id === id); }

  statusView(hospitalId: string): HospitalResourceStatus {
    const raw = this.db.resourceStatus[hospitalId];
    const h = this.hospital(hospitalId);
    const f = hospitalFreshness(raw?.lastVerifiedAt ?? null, this.now(), this.db.config, h.status === 'ONLINE');
    if (!raw) {
      return {
        hospitalId, availableErBeds: 0, availableIcuBeds: 0, availableVentilators: 0, availableTraumaBays: 0, availableIsolationBeds: 0,
        acceptanceStatus: 'UNAVAILABLE', operationalNotes: '', lastVerifiedAt: null, updatedBy: 'system', updatedAt: this.nowIso(),
        dataSource: 'DEMO_SEED', ...f,
      };
    }
    return { ...raw, ...f };
  }

  ambulanceView(a: StoredAmbulance): Ambulance {
    const f = gpsFreshness(a.lastLocationAt, this.now(), a.locationSharing, this.db.config);
    return { ...a, gpsFreshness: f.freshness, gpsAgeSeconds: f.ageSeconds == null ? null : Math.round(f.ageSeconds) };
  }

  isActive(inc: Incident) { return ACTIVE_INCIDENT_STATUSES.includes(inc.status); }

  activeIncidentOfAmbulance(ambulanceId: string): Incident | undefined {
    return this.db.incidents.find((i) => i.assignedAmbulanceId === ambulanceId && this.isActive(i));
  }

  activeRequestFor(incidentId: string) {
    const reqs = this.db.requests.filter((r) => r.incidentId === incidentId);
    return [...reqs].reverse().find((r) => ['PENDING', 'INFO_REQUESTED', 'ACCEPTED', 'NO_RESPONSE'].includes(r.status));
  }

  workload(excludeIncidentId?: string): Record<string, number> {
    const w: Record<string, number> = {};
    for (const r of this.db.requests) {
      if (!['PENDING', 'INFO_REQUESTED', 'ACCEPTED'].includes(r.status)) continue;
      if (r.incidentId === excludeIncidentId) continue;
      const inc = this.db.incidents.find((i) => i.id === r.incidentId);
      if (!inc || !this.isActive(inc) || inc.status === 'HANDED_OVER') continue;
      w[r.hospitalId] = (w[r.hospitalId] ?? 0) + 1;
    }
    return w;
  }
}

export function actorOf(user: StoredUser): Actor {
  return { id: user.id, label: user.fullName, role: user.role };
}
