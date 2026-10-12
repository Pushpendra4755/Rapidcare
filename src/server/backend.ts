import { CAPABILITIES, COUNTED_RESOURCES, EMERGENCY_TYPES, RESOURCES, type AcceptanceStatus, type AuditLog, type Capability, type Hospital, type PrepItem, type Role, type ServiceArea, type Session, type SystemConfig, type User } from '../lib/types';
import { isValidLatLng } from '../lib/geo';
import { MockRoutingProvider, type RoutingProvider } from '../lib/routing';
import { ApiError, Check, createClock, randomToken, sha256Hex, type BusEvent, type Clock } from './core';
import { Ctx, SYSTEM, actorOf } from './ctx';
import type { Db, StoredUser } from './db';
import { refreshRecommendations } from './ops';
import { buildSeed, DEMO_DOMAIN, DEMO_PASSWORD, zoneOf } from './seed';
import { housekeeping, simTick } from './sim';
import {
  acknowledgeRequest, ambulanceAction, assignAmbulance, closeIncident, confirmAvailability, confirmHandover, createIncident,
  escalateIncident, need, previewRoute, recordPhoneCall, replyToInfoRequest, respondToRequest, sendHospitalRequest,
  setAcceptanceStatus, setCapabilities, updateCapacity, updateLocation, updatePrep, type AmbulanceAction, type CreateIncidentInput,
  type RespondInput, type SendRequestOptions,
} from './workflows';
import { buildSnapshot, publicUser, redactForCrew, redactForHospital, routeView, type IncidentDetail, type Snapshot } from './views';

export interface BackendOptions { clock?: Clock; routing?: RoutingProvider; demoMode?: boolean; seed?: Db }

type Kind = 'read' | 'write';

/**
 * RapidCare backend facade. Every method authenticates a session token, rate-limits, authorises the role
 * and (for tenant-scoped data) the exact hospital/ambulance, validates input, writes audit rows and emits
 * realtime events. The browser demo runs this in-process; supabase/schema.sql expresses the same rules as RLS.
 */
export class RapidCareBackend {
  readonly ctx: Ctx;
  private constructor(ctx: Ctx) { this.ctx = ctx; }

  static async create(o: BackendOptions = {}): Promise<RapidCareBackend> {
    const clock = o.clock ?? createClock();
    const routing = o.routing ?? new MockRoutingProvider();
    const db = o.seed ?? buildSeed(clock.now());
    const ctx = new Ctx(db, clock, routing, o.demoMode ?? true);
    const be = new RapidCareBackend(ctx);
    await be.recomputeAll();
    return be;
  }

  private async recomputeAll() {
    for (const inc of this.ctx.db.incidents) if (this.ctx.isActive(inc)) await refreshRecommendations(this.ctx, inc.id);
  }

  // ------------------------------------------------------------------ session / auth
  private auth(token: string | null | undefined, kind: Kind = 'read'): { user: StoredUser; session: Session } {
    const s = token ? this.ctx.sessions.get(token) : undefined;
    if (!s) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in.');
    const now = this.ctx.now();
    if (s.expiresAt < now) { this.ctx.sessions.delete(s.token); throw new ApiError(401, 'SESSION_EXPIRED', 'Your session has expired. Please sign in again.'); }
    const user = this.ctx.userById(s.userId);
    if (!user || !user.active) { this.ctx.sessions.delete(s.token); throw new ApiError(401, 'UNAUTHENTICATED', 'Account is not active.'); }
    this.ctx.limiter.check(`api:${s.token}:${kind}`, kind === 'read' ? 900 : 120, 60_000);
    s.expiresAt = now + this.ctx.db.config.sessionIdleMinutes * 60_000; // sliding idle expiry
    return { user, session: s };
  }

  private newSession(user: StoredUser): Session {
    const s: Session = { token: randomToken(), userId: user.id, role: user.role, expiresAt: this.ctx.now() + this.ctx.db.config.sessionIdleMinutes * 60_000 };
    this.ctx.sessions.set(s.token, s);
    this.ctx.audit(actorOf(user), 'LOGIN', 'session', user.id, null, { role: user.role });
    return s;
  }

  login(email: string, password: string): { session: Session; user: User } {
    const c = new Check();
    const e = c.email(email);
    const p = c.str(password, 'password', { min: 1, max: 200, label: 'Password' });
    c.done();
    this.ctx.limiter.check(`login:${e}`, 5, 60_000);
    const u = this.ctx.db.users.find((x) => x.email === e);
    const ok = !!u && u.active && sha256Hex(u.salt + p) === u.passwordHash;
    if (!ok) {
      this.ctx.audit(SYSTEM, 'LOGIN_FAILED', 'session', e, null, { reason: 'invalid credentials' });
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }
    return { session: this.newSession(u!), user: publicUser(u!) };
  }

  demoLogin(role: Role): { session: Session; user: User } {
    if (!this.ctx.demoMode) throw new ApiError(403, 'DEMO_DISABLED', 'Demo login is disabled.');
    const emails: Record<Role, string> = {
      ADMIN: `admin@${DEMO_DOMAIN}`, DISPATCHER: `dispatcher@${DEMO_DOMAIN}`, HOSPITAL_STAFF: `hospital@${DEMO_DOMAIN}`, AMBULANCE_CREW: `crew@${DEMO_DOMAIN}`,
    };
    const u = this.ctx.db.users.find((x) => x.email === emails[role]);
    if (!u || !u.active) throw new ApiError(404, 'NOT_FOUND', 'Demo account unavailable.');
    return { session: this.newSession(u), user: publicUser(u) };
  }

  /** Demo-only: sign in as a specific seeded hospital/ambulance account (role switcher). */
  demoLoginAs(userId: string) {
    if (!this.ctx.demoMode) throw new ApiError(403, 'DEMO_DISABLED', 'Demo login is disabled.');
    const u = this.ctx.userById(userId);
    if (!u || !u.active || !u.email.endsWith(`@${DEMO_DOMAIN}`)) throw new ApiError(404, 'NOT_FOUND', 'Demo account unavailable.');
    return { session: this.newSession(u), user: publicUser(u) };
  }

  demoAccounts() {
    if (!this.ctx.demoMode) return [];
    return this.ctx.db.users.filter((u) => u.email.endsWith(`@${DEMO_DOMAIN}`) && u.active).map((u) => ({ id: u.id, name: u.fullName, role: u.role, hospitalId: u.hospitalId, ambulanceId: u.ambulanceId }));
  }

  logout(token: string) {
    const s = this.ctx.sessions.get(token);
    if (!s) return;
    const u = this.ctx.userById(s.userId);
    if (u) this.ctx.audit(actorOf(u), 'LOGOUT', 'session', u.id, null, null);
    this.ctx.sessions.delete(token);
  }

  /** Placeholder: always responds identically to avoid account enumeration. No email is sent in demo mode. */
  requestPasswordReset(email: string) {
    const c = new Check();
    const e = c.email(email);
    c.done();
    this.ctx.limiter.check(`reset:${e}`, 3, 60_000);
    this.ctx.audit(SYSTEM, 'PASSWORD_RESET_REQUESTED', 'user', e, null, null);
    return { message: 'If an account exists for that email, reset instructions would be sent. (Placeholder — email delivery is not configured in demo mode.)' };
  }

  me(token: string): { user: User; expiresAt: number } {
    const { user, session } = this.auth(token);
    return { user: publicUser(user), expiresAt: session.expiresAt };
  }

  // ------------------------------------------------------------------ realtime
  /**
   * Subscribe to a channel. Authorisation is enforced here:
   *  dispatcher:operations -> ADMIN, DISPATCHER;  hospital:{id} -> that hospital's staff (+ADMIN, DISPATCHER);
   *  ambulance:{id} -> that crew (+ADMIN, DISPATCHER);  incident:{id} -> dispatch/admin, the hospital it was sent to, the assigned crew.
   * Events carry no data; clients re-fetch their own role-scoped snapshot.
   */
  subscribe(token: string, channel: string, handler: (e: BusEvent) => void): () => void {
    const { user } = this.auth(token);
    const dispatch = user.role === 'ADMIN' || user.role === 'DISPATCHER';
    const [kind, id] = channel.split(':');
    let ok = false;
    if (channel === 'dispatcher:operations') ok = dispatch;
    else if (kind === 'hospital') ok = dispatch || (user.role === 'HOSPITAL_STAFF' && user.hospitalId === id);
    else if (kind === 'ambulance') ok = dispatch || (user.role === 'AMBULANCE_CREW' && user.ambulanceId === id);
    else if (kind === 'incident') {
      const inc = this.ctx.db.incidents.find((i) => i.id === id);
      ok = !!inc && (dispatch
        || (user.role === 'HOSPITAL_STAFF' && this.ctx.db.requests.some((r) => r.incidentId === id && r.hospitalId === user.hospitalId))
        || (user.role === 'AMBULANCE_CREW' && inc.assignedAmbulanceId === user.ambulanceId));
    }
    if (!ok) throw new ApiError(403, 'FORBIDDEN_CHANNEL', 'You are not permitted to subscribe to this channel.');
    return this.ctx.bus.subscribe(channel, handler);
  }

  // ------------------------------------------------------------------ reads
  getSnapshot(token: string): Snapshot {
    const { user, session } = this.auth(token);
    return buildSnapshot(this.ctx, user, session.expiresAt);
  }

  getIncidentDetail(token: string, incidentId: string): IncidentDetail {
    const { user } = this.auth(token);
    const ctx = this.ctx;
    const inc = ctx.incident(incidentId);
    const dispatch = user.role === 'ADMIN' || user.role === 'DISPATCHER';
    const actor = actorOf(user);
    let incident = inc;
    let timeline = ctx.db.timeline.filter((t) => t.incidentId === inc.id);
    let requests = ctx.db.requests.filter((r) => r.incidentId === inc.id);
    if (user.role === 'HOSPITAL_STAFF') {
      if (!requests.some((r) => r.hospitalId === user.hospitalId)) throw new ApiError(403, 'FORBIDDEN', 'This incident was not sent to your hospital.');
      requests = requests.filter((r) => r.hospitalId === user.hospitalId);
      incident = redactForHospital(inc);
      timeline = timeline.filter((t) => !['PICKUP_ADDED', 'OVERRIDE', 'RECOMMENDATIONS_GENERATED'].includes(t.type)).map((t) => ({ ...t, meta: undefined }));
      ctx.auditSensitive(actor, 'incident', inc.id, 'incident detail');
    } else if (user.role === 'AMBULANCE_CREW') {
      if (inc.assignedAmbulanceId !== user.ambulanceId) throw new ApiError(403, 'FORBIDDEN', 'This incident is not assigned to your ambulance.');
      incident = redactForCrew(inc);
      timeline = timeline.filter((t) => !['OVERRIDE', 'RECOMMENDATIONS_GENERATED'].includes(t.type));
      requests = [];
      ctx.auditSensitive(actor, 'incident', inc.id, 'incident detail');
    } else if (!dispatch) throw new ApiError(403, 'FORBIDDEN', 'Not permitted.');
    const amb = inc.assignedAmbulanceId ? ctx.db.ambulances.find((a) => a.id === inc.assignedAmbulanceId) : undefined;
    const trail = ctx.db.locationHistory.filter((p) => p.incidentId === inc.id).slice(-400);
    return {
      incident, timeline, etaHistory: dispatch ? (ctx.db.etaHistory[inc.id] ?? []) : [],
      requests: requests.map((r) => ({ ...r, hospitalName: ctx.hospital(r.hospitalId).name })),
      recommendations: dispatch ? (ctx.db.recommendations[inc.id] ?? []) : [],
      notifications: dispatch ? ctx.db.notifications.filter((n) => n.incidentId === inc.id).slice(-40) : [],
      trail: dispatch || user.role === 'AMBULANCE_CREW' ? trail : [], route: user.role === 'HOSPITAL_STAFF' ? null : routeView(ctx, inc.id),
      ambulance: amb && user.role !== 'HOSPITAL_STAFF' ? ctx.ambulanceView(amb) : null,
      hospitalName: inc.selectedHospitalId ? ctx.hospital(inc.selectedHospitalId).name : null,
    };
  }

  /** Printable summary. Demo data only. Access is audited as sensitive. */
  getIncidentReport(token: string, incidentId: string) {
    const { user } = this.auth(token);
    need(user, 'DISPATCHER', 'ADMIN');
    const ctx = this.ctx;
    const inc = ctx.incident(incidentId);
    ctx.audit(actorOf(user), 'REPORT_EXPORTED', 'incident', inc.id, null, { code: inc.incidentCode });
    const tl = ctx.db.timeline.filter((t) => t.incidentId === inc.id);
    const at = (type: string) => tl.find((t) => t.type === type)?.at ?? null;
    const diff = (a: string | null, b: string | null) => (a && b ? Math.round((Date.parse(b) - Date.parse(a)) / 1000) : null);
    const reqs = ctx.db.requests.filter((r) => r.incidentId === inc.id);
    const amb = inc.assignedAmbulanceId ? ctx.db.ambulances.find((a) => a.id === inc.assignedAmbulanceId) : null;
    return {
      generatedAt: ctx.nowIso(), incident: inc, ambulanceCode: amb?.code ?? null,
      hospital: inc.selectedHospitalId ? ctx.hospital(inc.selectedHospitalId).name : null,
      timeline: tl, etaHistory: ctx.db.etaHistory[inc.id] ?? [],
      requests: reqs.map((r) => ({ ...r, hospitalName: ctx.hospital(r.hospitalId).name })),
      overrides: tl.filter((t) => t.type === 'OVERRIDE'),
      metrics: {
        responseSec: diff(at('INCIDENT_CREATED'), at('ARRIVED_PICKUP')),
        alertToDecisionSec: diff(at('ALERT_SENT'), tl.find((t) => t.type === 'HOSPITAL_ACCEPTED' || t.type === 'HOSPITAL_DECLINED')?.at ?? null),
        transportSec: diff(at('PATIENT_ONBOARD'), at('AMBULANCE_ARRIVED')),
        handoverSec: diff(at('AMBULANCE_ARRIVED'), at('HANDOVER_COMPLETED')),
        totalSec: diff(at('INCIDENT_CREATED'), at('INCIDENT_CLOSED')),
      },
      outcome: inc.status,
      disclaimer: 'Demo data only. Not a medical record.',
    };
  }

  getPlayback(token: string, incidentId: string) {
    const { user } = this.auth(token);
    need(user, 'ADMIN');
    const ctx = this.ctx;
    const inc = ctx.incident(incidentId);
    return {
      incident: inc, timeline: ctx.db.timeline.filter((t) => t.incidentId === inc.id), trail: ctx.db.locationHistory.filter((p) => p.incidentId === inc.id),
      etaHistory: ctx.db.etaHistory[inc.id] ?? [], hospitals: ctx.db.hospitals,
    };
  }

  // ------------------------------------------------------------------ incidents (dispatch)
  async createIncident(token: string, input: CreateIncidentInput) { const { user } = this.auth(token, 'write'); return createIncident(this.ctx, user, input); }
  async assignAmbulance(token: string, incidentId: string, ambulanceId: string, o: { confirmReassign?: boolean } = {}) { const { user } = this.auth(token, 'write'); return assignAmbulance(this.ctx, user, incidentId, ambulanceId, o); }
  async refreshRecommendations(token: string, incidentId: string) { const { user } = this.auth(token, 'write'); need(user, 'DISPATCHER', 'ADMIN'); await refreshRecommendations(this.ctx, incidentId, { log: true }); return this.ctx.db.recommendations[incidentId] ?? []; }
  async previewRoute(token: string, incidentId: string, hospitalId: string) { const { user } = this.auth(token); return previewRoute(this.ctx, user, incidentId, hospitalId); }
  async sendHospitalRequest(token: string, incidentId: string, hospitalId: string, o: SendRequestOptions = {}) { const { user } = this.auth(token, 'write'); return sendHospitalRequest(this.ctx, user, incidentId, hospitalId, o); }
  async markPatientOnboard(token: string, incidentId: string) {
    const { user } = this.auth(token, 'write');
    const inc = this.ctx.incident(incidentId);
    if (!inc.assignedAmbulanceId) throw new ApiError(409, 'NO_AMBULANCE', 'No ambulance is assigned.');
    return ambulanceAction(this.ctx, user, inc.assignedAmbulanceId, 'PATIENT_ONBOARD');
  }
  replyToInfoRequest(token: string, requestId: string, message: string) { const { user } = this.auth(token, 'write'); return replyToInfoRequest(this.ctx, user, requestId, message); }
  async recordPhoneCall(token: string, requestId: string, outcome: 'ACCEPTED' | 'DECLINED' | 'NO_ANSWER' | 'CALL_BACK_LATER', note = '') { const { user } = this.auth(token, 'write'); return recordPhoneCall(this.ctx, user, requestId, outcome, note); }
  async escalateIncident(token: string, incidentId: string, note = '') { const { user } = this.auth(token, 'write'); return escalateIncident(this.ctx, user, incidentId, note); }
  closeIncident(token: string, incidentId: string, o: { cancel?: boolean; reason?: string } = {}) {
    const { user } = this.auth(token, 'write');
    need(user, 'DISPATCHER', 'ADMIN');
    return closeIncident(this.ctx, actorOf(user), incidentId, o);
  }

  // ------------------------------------------------------------------ hospital staff
  acknowledgeRequest(token: string, requestId: string) { const { user } = this.auth(token, 'write'); return acknowledgeRequest(this.ctx, user, requestId); }
  async respondToRequest(token: string, requestId: string, input: RespondInput) { const { user } = this.auth(token, 'write'); return respondToRequest(this.ctx, user, requestId, input); }
  updatePrep(token: string, requestId: string, item: PrepItem, value: boolean) { const { user } = this.auth(token, 'write'); return updatePrep(this.ctx, user, requestId, item, value); }
  confirmHandover(token: string, requestId: string) { const { user } = this.auth(token, 'write'); return confirmHandover(this.ctx, user, requestId); }
  async updateCapacity(token: string, hospitalId: string, patch: Record<string, unknown>, confirmed: boolean, notes?: string) { const { user } = this.auth(token, 'write'); return updateCapacity(this.ctx, user, hospitalId, patch, confirmed, notes); }
  confirmAvailability(token: string, hospitalId: string) { const { user } = this.auth(token, 'write'); return confirmAvailability(this.ctx, user, hospitalId); }
  async setAcceptanceStatus(token: string, hospitalId: string, status: AcceptanceStatus, note?: string) { const { user } = this.auth(token, 'write'); return setAcceptanceStatus(this.ctx, user, hospitalId, status, note); }
  async setCapabilities(token: string, hospitalId: string, patch: Partial<Record<Capability, boolean>>) { const { user } = this.auth(token, 'write'); return setCapabilities(this.ctx, user, hospitalId, patch); }

  // ------------------------------------------------------------------ ambulance crew
  async ambulanceAction(token: string, ambulanceId: string, action: AmbulanceAction, payload: { source?: 'SIMULATED' | 'DEVICE'; manual?: boolean } = {}) { const { user } = this.auth(token, 'write'); return ambulanceAction(this.ctx, user, ambulanceId, action, payload); }
  updateLocation(token: string, ambulanceId: string, loc: { lat: number; lng: number; accuracyMeters?: number; speedKmph?: number; headingDegrees?: number }, kind: 'GPS' | 'MAP_PIN' | 'LAST_KNOWN' = 'GPS') { const { user } = this.auth(token, 'write'); return updateLocation(this.ctx, user, ambulanceId, loc, kind); }
  contactDispatcher(token: string, message: string) {
    const { user } = this.auth(token, 'write');
    need(user, 'AMBULANCE_CREW', 'HOSPITAL_STAFF');
    const c = new Check();
    const m = c.str(message, 'message', { min: 3, max: 200, label: 'Message' });
    c.done();
    const inc = user.ambulanceId ? this.ctx.activeIncidentOfAmbulance(user.ambulanceId) : undefined;
    this.ctx.notify({ role: 'DISPATCHER' }, { type: 'INFO', title: `${user.role === 'AMBULANCE_CREW' ? 'Crew' : 'Hospital'} contact request`, message: `${user.fullName}: ${m}`, severity: 'CRITICAL', requiresAck: true, incidentId: inc?.id ?? null });
    if (inc) this.ctx.timeline(inc.id, 'NOTE', user.fullName, `Crew contacted dispatcher: ${m}`);
    this.ctx.audit(actorOf(user), 'CONTACT_DISPATCHER', 'user', user.id, null, { message: m });
    return { ok: true };
  }

  // ------------------------------------------------------------------ notifications
  acknowledgeNotification(token: string, id: string) {
    const { user } = this.auth(token, 'write');
    const n = this.ctx.db.notifications.find((x) => x.id === id);
    if (!n) throw new ApiError(404, 'NOT_FOUND', 'Notification not found.');
    const mine = n.recipientUserId === user.id || (n.recipientRole && (n.recipientRole === user.role || (user.role === 'ADMIN' && n.recipientRole === 'DISPATCHER')))
      || (n.recipientHospitalId && n.recipientHospitalId === user.hospitalId) || (n.recipientAmbulanceId && n.recipientAmbulanceId === user.ambulanceId);
    if (!mine) throw new ApiError(403, 'FORBIDDEN', 'Not your notification.');
    n.status = 'ACKNOWLEDGED'; n.acknowledgedAt = this.ctx.nowIso(); n.readAt ??= n.acknowledgedAt;
    this.ctx.emit('notification', { hospitalId: n.recipientHospitalId, ambulanceId: n.recipientAmbulanceId, incidentId: n.incidentId });
    return n;
  }
  acknowledgeAll(token: string) {
    const { user } = this.auth(token, 'write');
    const snap = buildSnapshot(this.ctx, user, 0);
    for (const n of snap.notifications) if (n.status !== 'ACKNOWLEDGED' && n.requiresAck) this.acknowledgeNotification(token, n.id);
  }
  markRead(token: string, id: string) {
    const { user } = this.auth(token, 'write');
    const snap = buildSnapshot(this.ctx, user, 0);
    const n = snap.notifications.find((x) => x.id === id);
    if (n) { const raw = this.ctx.db.notifications.find((x) => x.id === id)!; raw.readAt ??= this.ctx.nowIso(); if (raw.status === 'SENT') raw.status = 'READ'; }
  }

  // ------------------------------------------------------------------ admin
  getAuditLogs(token: string, f: { q?: string; action?: string; limit?: number } = {}): AuditLog[] {
    const { user } = this.auth(token);
    need(user, 'ADMIN');
    this.ctx.auditSensitive(actorOf(user), 'audit_log', 'all', 'audit log viewed');
    let rows = [...this.ctx.db.audit].reverse();
    if (f.action) rows = rows.filter((r) => r.actionType === f.action);
    if (f.q) { const q = f.q.toLowerCase(); rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)); }
    return rows.slice(0, Math.min(f.limit ?? 300, 1000));
  }

  getAnalytics(token: string) {
    const { user } = this.auth(token);
    need(user, 'ADMIN', 'DISPATCHER');
    const ctx = this.ctx;
    const db = ctx.db;
    const active = db.incidents.filter((i) => ctx.isActive(i));
    const byType: Record<string, number> = {};
    for (const t of EMERGENCY_TYPES) byType[t] = active.filter((i) => i.emergencyType === t).length;
    const perHospital = db.hospitals.map((h) => {
      const rs = db.requests.filter((r) => r.hospitalId === h.id);
      return { hospitalId: h.id, name: h.name, accepted: rs.filter((r) => r.status === 'ACCEPTED').length, declined: rs.filter((r) => r.status === 'DECLINED').length, noResponse: rs.filter((r) => r.status === 'NO_RESPONSE').length, total: rs.length };
    });
    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
    const ack = db.requests.filter((r) => r.acknowledgedAt).map((r) => (Date.parse(r.acknowledgedAt!) - Date.parse(r.sentAt)) / 1000);
    const resp: number[] = []; const hand: number[] = [];
    for (const i of db.incidents) {
      const tl = db.timeline.filter((t) => t.incidentId === i.id);
      const c = tl.find((t) => t.type === 'INCIDENT_CREATED'); const p = tl.find((t) => t.type === 'ARRIVED_PICKUP');
      const a = tl.find((t) => t.type === 'AMBULANCE_ARRIVED'); const h = tl.find((t) => t.type === 'HANDOVER_COMPLETED');
      if (c && p) resp.push((Date.parse(p.at) - Date.parse(c.at)) / 1000);
      if (a && h) hand.push((Date.parse(h.at) - Date.parse(a.at)) / 1000);
    }
    const fresh: Record<string, number> = { LIVE: 0, RECENT: 0, STALE: 0, UNAVAILABLE: 0 };
    for (const h of db.hospitals) fresh[ctx.statusView(h.id).freshness]++;
    const ambs = db.ambulances.map((a) => ctx.ambulanceView(a));
    return {
      systemStatus: 'OPERATIONAL' as const, demoMode: ctx.demoMode,
      ambulances: { online: ambs.filter((a) => a.status !== 'OFFLINE').length, offline: ambs.filter((a) => a.status === 'OFFLINE').length, gpsLost: ambs.filter((a) => a.gpsFreshness === 'LOST').length },
      capacityFreshness: fresh, activeByType: byType, perHospital,
      avgAckSec: avg(ack), avgResponseSec: avg(resp), avgHandoverSec: avg(hand),
      escalations: active.filter((i) => i.escalationLevel > 0 || i.severity === 'CRITICAL' && !db.requests.some((r) => r.incidentId === i.id && r.status !== 'CANCELLED')).map((i) => ({ id: i.id, code: i.incidentCode, severity: i.severity, level: i.escalationLevel })),
      openAlerts: db.notifications.filter((n) => n.requiresAck && n.status !== 'ACKNOWLEDGED').length,
      totals: { incidents: db.incidents.length, active: active.length, requests: db.requests.length },
    };
  }

  upsertHospital(token: string, input: Partial<Hospital> & { name: string }) {
    const { user } = this.auth(token, 'write');
    need(user, 'ADMIN');
    const c = new Check();
    const name = c.str(input.name, 'name', { min: 3, max: 80, label: 'Name' });
    const address = c.str(input.address, 'address', { min: 3, max: 160, label: 'Address' });
    const lat = c.num(input.lat, 'lat', { min: -90, max: 90, label: 'Latitude' });
    const lng = c.num(input.lng, 'lng', { min: -180, max: 180, label: 'Longitude' });
    const elat = input.entranceLat == null ? lat : c.num(input.entranceLat, 'entranceLat', { min: -90, max: 90, label: 'Entrance latitude' });
    const elng = input.entranceLng == null ? lng : c.num(input.entranceLng, 'entranceLng', { min: -180, max: 180, label: 'Entrance longitude' });
    const phone = c.str(input.phone, 'phone', { max: 30, optional: true, label: 'Phone' });
    const contact = c.str(input.emergencyContact, 'emergencyContact', { min: 3, max: 30, label: 'Emergency contact number' });
    const t = {
      totalErBeds: c.int(input.totalErBeds ?? 0, 'totalErBeds', { min: 0, max: 1000, label: 'ER beds' }),
      totalIcuBeds: c.int(input.totalIcuBeds ?? 0, 'totalIcuBeds', { min: 0, max: 1000, label: 'ICU beds' }),
      totalVentilators: c.int(input.totalVentilators ?? 0, 'totalVentilators', { min: 0, max: 1000, label: 'Ventilators' }),
      totalTraumaBays: c.int(input.totalTraumaBays ?? 0, 'totalTraumaBays', { min: 0, max: 1000, label: 'Trauma bays' }),
      totalIsolationBeds: c.int(input.totalIsolationBeds ?? 0, 'totalIsolationBeds', { min: 0, max: 1000, label: 'Isolation beds' }),
    };
    const status = c.oneOf(input.status ?? 'ONLINE', ['ONLINE', 'OFFLINE'] as const, 'status', 'Status');
    const regionId = input.regionId || zoneOf({ lat, lng }) || 'z_central';
    c.done();
    const db = this.ctx.db;
    const now = this.ctx.nowIso();
    const existing = input.id ? db.hospitals.find((h) => h.id === input.id) : undefined;
    const caps = { ...(existing?.capabilities ?? Object.fromEntries(CAPABILITIES.map((x) => [x, false]))), ...(input.capabilities ?? {}) } as Hospital['capabilities'];
    if (existing) {
      const prev = { ...existing };
      Object.assign(existing, { name, address, lat, lng, entranceLat: elat, entranceLng: elng, phone, emergencyContact: contact, status, regionId, capabilities: caps, ...t, updatedAt: now });
      const rs = db.resourceStatus[existing.id];
      if (rs) { // clamp availability to the new totals
        rs.availableErBeds = Math.min(rs.availableErBeds, t.totalErBeds); rs.availableIcuBeds = Math.min(rs.availableIcuBeds, t.totalIcuBeds);
        rs.availableVentilators = Math.min(rs.availableVentilators, t.totalVentilators); rs.availableTraumaBays = Math.min(rs.availableTraumaBays, t.totalTraumaBays);
        rs.availableIsolationBeds = Math.min(rs.availableIsolationBeds, t.totalIsolationBeds);
      }
      this.ctx.audit(actorOf(user), 'HOSPITAL_UPDATED', 'hospital', existing.id, prev, existing);
      this.ctx.emit('capacity', { hospitalId: existing.id });
      return existing;
    }
    const id = this.ctx.id('hosp', 'h');
    const h: Hospital = { id, name, address, lat, lng, entranceLat: elat, entranceLng: elng, phone, emergencyContact: contact, status, regionId, capabilities: caps, ...t, createdAt: now, updatedAt: now };
    db.hospitals.push(h);
    db.resourceStatus[id] = { hospitalId: id, availableErBeds: 0, availableIcuBeds: 0, availableVentilators: 0, availableTraumaBays: 0, availableIsolationBeds: 0, acceptanceStatus: 'UNAVAILABLE', operationalNotes: 'New hospital — awaiting first capacity update.', lastVerifiedAt: null, updatedBy: user.fullName, updatedAt: now, dataSource: 'HOSPITAL_STAFF' };
    this.ctx.audit(actorOf(user), 'HOSPITAL_CREATED', 'hospital', id, null, h);
    this.ctx.emit('capacity', { hospitalId: id });
    return h;
  }

  deleteHospital(token: string, id: string) {
    const { user } = this.auth(token, 'write');
    need(user, 'ADMIN');
    const h = this.ctx.hospital(id);
    if (this.ctx.db.requests.some((r) => r.hospitalId === id) || this.ctx.db.incidents.some((i) => i.selectedHospitalId === id)) {
      throw new ApiError(409, 'IN_USE', 'This hospital has incident history. Set it to OFFLINE instead of deleting it.');
    }
    this.ctx.db.hospitals = this.ctx.db.hospitals.filter((x) => x.id !== id);
    delete this.ctx.db.resourceStatus[id];
    this.ctx.audit(actorOf(user), 'HOSPITAL_DELETED', 'hospital', id, h, null);
    this.ctx.emit('capacity', { hospitalId: id });
  }

  upsertAmbulance(token: string, input: { id?: string; code: string; vehicleType: 'ALS' | 'BLS' | 'NEONATAL_TRANSPORT'; operatorName: string; lat?: number; lng?: number }) {
    const { user } = this.auth(token, 'write');
    need(user, 'ADMIN');
    const c = new Check();
    const code = c.str(input.code, 'code', { min: 3, max: 20, label: 'Ambulance code' }).toUpperCase();
    const vt = c.oneOf(input.vehicleType, ['ALS', 'BLS', 'NEONATAL_TRANSPORT'] as const, 'vehicleType', 'Vehicle type');
    const op = c.str(input.operatorName, 'operatorName', { min: 2, max: 60, label: 'Operator' });
    const lat = input.lat ?? 12.9716; const lng = input.lng ?? 77.5946;
    if (!isValidLatLng(lat, lng)) c.fail('lat', 'Invalid coordinates.');
    if (this.ctx.db.ambulances.some((a) => a.code === code && a.id !== input.id)) c.fail('code', 'An ambulance with this code already exists.');
    c.done();
    const now = this.ctx.nowIso();
    const existing = input.id ? this.ctx.db.ambulances.find((a) => a.id === input.id) : undefined;
    if (existing) {
      const prev = { ...existing };
      Object.assign(existing, { code, vehicleType: vt, operatorName: op, updatedAt: now });
      this.ctx.audit(actorOf(user), 'AMBULANCE_UPDATED', 'ambulance', existing.id, prev, existing);
      this.ctx.emit('ambulance', { ambulanceId: existing.id });
      return existing;
    }
    const id = `a_${String(this.ctx.db.seq.amb = (this.ctx.db.seq.amb ?? 0) + 1).padStart(3, '0')}`;
    const a = { id, code, vehicleType: vt, status: 'OFFLINE' as const, lat, lng, gpsAccuracyMeters: null, speedKmph: 0, headingDegrees: 0, lastLocationAt: null, operatorName: op, locationSharing: false, simSignalLoss: false, regionId: zoneOf({ lat, lng }) ?? 'z_central', createdAt: now, updatedAt: now };
    this.ctx.db.ambulances.push(a);
    this.ctx.audit(actorOf(user), 'AMBULANCE_CREATED', 'ambulance', id, null, a);
    this.ctx.emit('ambulance', { ambulanceId: id });
    return a;
  }

  deleteAmbulance(token: string, id: string) {
    const { user } = this.auth(token, 'write');
    need(user, 'ADMIN');
    const a = this.ctx.ambulanceRaw(id);
    if (this.ctx.db.incidents.some((i) => i.assignedAmbulanceId === id)) throw new ApiError(409, 'IN_USE', 'This ambulance has incident history and cannot be deleted. Take it off duty instead.');
    this.ctx.db.ambulances = this.ctx.db.ambulances.filter((x) => x.id !== id);
    this.ctx.audit(actorOf(user), 'AMBULANCE_DELETED', 'ambulance', id, a, null);
    this.ctx.emit('ambulance', { ambulanceId: id });
  }

  listUsers(token: string): User[] {
    const { user } = this.auth(token);
    need(user, 'ADMIN');
    this.ctx.auditSensitive(actorOf(user), 'user', 'all', 'user list viewed');
    return this.ctx.db.users.map(publicUser);
  }

  upsertUser(token: string, input: { id?: string; fullName: string; email: string; role: Role; hospitalId?: string | null; ambulanceId?: string | null; active?: boolean; password?: string }) {
    const { user } = this.auth(token, 'write');
    need(user, 'ADMIN');
    const c = new Check();
    const fullName = c.str(input.fullName, 'fullName', { min: 2, max: 80, label: 'Full name' });
    const email = c.email(input.email);
    const role = c.oneOf(input.role, ['ADMIN', 'DISPATCHER', 'HOSPITAL_STAFF', 'AMBULANCE_CREW'] as const, 'role', 'Role');
    const hospitalId = role === 'HOSPITAL_STAFF' ? (input.hospitalId ?? null) : null;
    const ambulanceId = role === 'AMBULANCE_CREW' ? (input.ambulanceId ?? null) : null;
    if (role === 'HOSPITAL_STAFF' && (!hospitalId || !this.ctx.db.hospitals.some((h) => h.id === hospitalId))) c.fail('hospitalId', 'Hospital staff must be linked to a hospital.');
    if (role === 'AMBULANCE_CREW' && (!ambulanceId || !this.ctx.db.ambulances.some((a) => a.id === ambulanceId))) c.fail('ambulanceId', 'Ambulance crew must be linked to an ambulance.');
    if (this.ctx.db.users.some((u) => u.email === email && u.id !== input.id)) c.fail('email', 'This email is already in use.');
    if (input.password !== undefined && input.password !== '' && input.password.length < 10) c.fail('password', 'Password must be at least 10 characters.');
    if (input.id === user.id && input.active === false) c.fail('active', 'You cannot deactivate your own account.');
    if (input.id === user.id && role !== 'ADMIN') c.fail('role', 'You cannot remove your own admin role.');
    c.done();
    const now = this.ctx.nowIso();
    const existing = input.id ? this.ctx.db.users.find((u) => u.id === input.id) : undefined;
    let tempPassword: string | null = null;
    if (existing) {
      const prev = publicUser(existing);
      Object.assign(existing, { fullName, email, role, hospitalId, ambulanceId, active: input.active ?? existing.active, updatedAt: now });
      if (input.password) { existing.salt = randomToken().slice(0, 16); existing.passwordHash = sha256Hex(existing.salt + input.password); }
      if (!existing.active) for (const [t, s] of this.ctx.sessions) if (s.userId === existing.id) this.ctx.sessions.delete(t);
      this.ctx.audit(actorOf(user), 'USER_UPDATED', 'user', existing.id, prev, publicUser(existing));
      return { user: publicUser(existing), tempPassword };
    }
    const id = this.ctx.id('usr', 'u');
    const pw = input.password || (tempPassword = randomToken().slice(0, 14));
    const salt = randomToken().slice(0, 16);
    const u: StoredUser = { id, fullName, email, role, hospitalId, ambulanceId, active: input.active ?? true, createdAt: now, updatedAt: now, salt, passwordHash: sha256Hex(salt + pw) };
    this.ctx.db.users.push(u);
    this.ctx.audit(actorOf(user), 'USER_CREATED', 'user', id, null, publicUser(u));
    return { user: publicUser(u), tempPassword };
  }

  upsertCategory(token: string, input: { id: string; label: string; defaultCapabilities: Capability[]; defaultResources: string[]; active: boolean }) {
    const { user } = this.auth(token, 'write');
    need(user, 'ADMIN');
    const c = new Check();
    const id = c.oneOf(input.id, EMERGENCY_TYPES, 'id', 'Category');
    const label = c.str(input.label, 'label', { min: 2, max: 40, label: 'Label' });
    const caps = (input.defaultCapabilities ?? []).filter((x) => (CAPABILITIES as readonly string[]).includes(x));
    const res = (input.defaultResources ?? []).filter((x) => (RESOURCES as readonly string[]).includes(x)) as typeof RESOURCES[number][];
    c.done();
    const cat = this.ctx.db.categories.find((x) => x.id === id);
    const prev = cat ? { ...cat } : null;
    if (cat) Object.assign(cat, { label, defaultCapabilities: caps, defaultResources: res, active: !!input.active });
    else this.ctx.db.categories.push({ id, label, defaultCapabilities: caps, defaultResources: res, active: !!input.active });
    this.ctx.audit(actorOf(user), 'CATEGORY_UPDATED', 'emergency_category', id, prev, { label, caps, res, active: input.active });
  }

  upsertServiceArea(token: string, input: ServiceArea) {
    const { user } = this.auth(token, 'write');
    need(user, 'ADMIN');
    const c = new Check();
    const name = c.str(input.name, 'name', { min: 2, max: 40, label: 'Name' });
    const b = input.bounds;
    if (!Array.isArray(b) || b.length !== 4 || b.some((x) => typeof x !== 'number' || !Number.isFinite(x))) c.fail('bounds', 'Bounds must be four numbers: south, west, north, east.');
    else if (b[0] >= b[2] || b[1] >= b[3]) c.fail('bounds', 'South must be less than north, and west less than east.');
    c.done();
    const id = input.id || this.ctx.id('seq', 'z');
    const neighbors = (input.neighbors ?? []).filter((n) => n !== id);
    const ex = this.ctx.db.serviceAreas.find((a) => a.id === id);
    const prev = ex ? { ...ex } : null;
    if (ex) Object.assign(ex, { name, bounds: b, neighbors }); else this.ctx.db.serviceAreas.push({ id, name, bounds: b, neighbors });
    this.ctx.audit(actorOf(user), 'SERVICE_AREA_UPDATED', 'service_area', id, prev, { name, bounds: b, neighbors });
  }

  deleteServiceArea(token: string, id: string) {
    const { user } = this.auth(token, 'write');
    need(user, 'ADMIN');
    if (this.ctx.db.hospitals.some((h) => h.regionId === id)) throw new ApiError(409, 'IN_USE', 'Hospitals are assigned to this service area.');
    this.ctx.db.serviceAreas = this.ctx.db.serviceAreas.filter((a) => a.id !== id);
    this.ctx.audit(actorOf(user), 'SERVICE_AREA_DELETED', 'service_area', id, null, null);
  }

  async updateConfig(token: string, patch: Partial<SystemConfig>) {
    const { user } = this.auth(token, 'write');
    need(user, 'ADMIN');
    const cur = this.ctx.db.config;
    const c = new Check();
    const next: SystemConfig = { ...cur, weights: { ...cur.weights, ...(patch.weights ?? {}) } };
    for (const k of Object.keys(next.weights) as (keyof SystemConfig['weights'])[]) c.num(next.weights[k], `weights.${k}`, { min: 0, max: 1, label: `Weight ${k}` });
    if (Object.values(next.weights).reduce((a, b) => a + b, 0) <= 0) c.fail('weights', 'At least one weight must be above zero.');
    const nums: [keyof SystemConfig, number, number][] = [
      ['etaCapMinutes', 5, 240], ['liveMinutes', 1, 60], ['recentMinutes', 2, 240], ['ineligibleAfterMinutes', 5, 1440], ['staleMultiplier', 0, 1],
      ['limitedMultiplier', 0, 1], ['ackTimeoutSec', 10, 900], ['decisionTimeoutSec', 10, 3600], ['gpsStaleSec', 5, 600], ['gpsLostSec', 10, 3600],
      ['escalateCriticalAfterSec', 10, 3600], ['simCompression', 1, 60], ['sessionIdleMinutes', 5, 480],
    ];
    for (const [k, lo, hi] of nums) {
      if (patch[k] !== undefined) (next as unknown as Record<string, number>)[k] = c.num(patch[k], k, { min: lo, max: hi, label: k });
    }
    if (patch.restrictToServiceArea !== undefined) next.restrictToServiceArea = !!patch.restrictToServiceArea;
    if (patch.notifyAdminsOnEscalation !== undefined) next.notifyAdminsOnEscalation = !!patch.notifyAdminsOnEscalation;
    if (next.liveMinutes >= next.recentMinutes) c.fail('liveMinutes', 'LIVE window must be shorter than RECENT window.');
    if (next.gpsStaleSec >= next.gpsLostSec) c.fail('gpsStaleSec', 'GPS stale threshold must be shorter than the lost threshold.');
    c.done();
    this.ctx.audit(actorOf(user), 'CONFIG_CHANGE', 'system_config', 'config', cur, next);
    this.ctx.db.config = next;
    await this.recomputeAll();
    this.ctx.emit('config');
    return next;
  }

  // ------------------------------------------------------------------ demo controls
  private demoGuard(token: string, ...roles: Role[]) {
    const { user } = this.auth(token, 'write');
    if (!this.ctx.demoMode) throw new ApiError(403, 'DEMO_DISABLED', 'Demo controls are disabled.');
    need(user, ...(roles.length ? roles : (['DISPATCHER', 'ADMIN'] as Role[])));
    return user;
  }

  async demoTriggerCapacityChange(token: string, hospitalId?: string) {
    const user = this.demoGuard(token);
    const ctx = this.ctx;
    const h = hospitalId ? ctx.hospital(hospitalId) : ctx.db.hospitals[Math.floor(Math.random() * ctx.db.hospitals.length)];
    const rs = ctx.db.resourceStatus[h.id];
    const map = { ER_BED: ['availableErBeds', 'totalErBeds'], ICU_BED: ['availableIcuBeds', 'totalIcuBeds'], VENTILATOR: ['availableVentilators', 'totalVentilators'] } as const;
    const keys = (['ER_BED', 'ICU_BED', 'VENTILATOR'] as const).filter((k) => h[map[k][1]] > 0);
    const k = keys[Math.floor(Math.random() * keys.length)];
    const [af, tf] = map[k];
    const cur = rs[af];
    const delta = cur <= 0 ? 1 : cur >= h[tf] ? -1 : Math.random() < 0.5 ? -1 : 1;
    const prev = { ...rs };
    rs[af] = Math.max(0, Math.min(h[tf], cur + delta));
    rs.lastVerifiedAt = ctx.nowIso(); rs.updatedAt = rs.lastVerifiedAt; rs.updatedBy = 'Demo simulator'; rs.dataSource = 'DEMO_SIM';
    ctx.audit(actorOf(user), 'CAPACITY_UPDATE', 'hospital_resource_status', h.id, prev, { ...rs, simulated: true });
    ctx.emit('capacity', { hospitalId: h.id });
    for (const inc of ctx.db.incidents) if (ctx.isActive(inc)) await refreshRecommendations(ctx, inc.id);
    return `${h.name}: ${k.replace('_', ' ')} availability ${cur} → ${rs[af]}`;
  }

  async demoRespond(token: string, requestId: string, decision: 'ACCEPT' | 'DECLINE') {
    const user = this.demoGuard(token);
    return respondToRequest(this.ctx, user, requestId, { decision, declineReason: 'No ICU bed available' }, 'DEMO');
  }

  demoToggleSignalLoss(token: string, ambulanceId: string) {
    const user = this.demoGuard(token);
    const a = this.ctx.ambulanceRaw(ambulanceId);
    a.simSignalLoss = !a.simSignalLoss;
    this.ctx.audit(actorOf(user), 'DEMO_SIGNAL_LOSS', 'ambulance', a.id, null, { simSignalLoss: a.simSignalLoss });
    this.ctx.emit('ambulance', { ambulanceId: a.id });
    return a.simSignalLoss;
  }

  async demoAgeCapacity(token: string, hospitalId: string, minutes = 20) {
    const user = this.demoGuard(token);
    const rs = this.ctx.db.resourceStatus[hospitalId];
    if (!rs) throw new ApiError(404, 'NOT_FOUND', 'Hospital not found.');
    const base = rs.lastVerifiedAt ? Date.parse(rs.lastVerifiedAt) : this.ctx.now();
    rs.lastVerifiedAt = new Date(base - minutes * 60_000).toISOString();
    this.ctx.audit(actorOf(user), 'DEMO_AGE_CAPACITY', 'hospital_resource_status', hospitalId, null, { minutes });
    this.ctx.emit('capacity', { hospitalId });
    for (const inc of this.ctx.db.incidents) if (this.ctx.isActive(inc)) await refreshRecommendations(this.ctx, inc.id);
  }

  /** Demo: lets a presenter drive the crew steps without switching accounts. Audited as a dispatcher action. */
  async demoCrewDepart(token: string, ambulanceId: string) {
    const user = this.demoGuard(token);
    const ctx = this.ctx;
    const amb = ctx.ambulanceRaw(ambulanceId);
    const crew = ctx.db.users.find((u) => u.ambulanceId === ambulanceId && u.active) ?? user;
    if (amb.status !== 'ASSIGNED') throw new ApiError(409, 'INVALID_STATE', 'Ambulance must be assigned first.');
    ctx.audit(actorOf(user), 'DEMO_CREW_ACTION', 'ambulance', ambulanceId, null, { action: 'start trip + depart' });
    await ambulanceAction(ctx, crew, ambulanceId, 'START_TRIP', { source: 'SIMULATED' });
    await ambulanceAction(ctx, crew, ambulanceId, 'BEGIN_ROUTE_PICKUP', {});
  }

  async demoReset(token: string) {
    const user = this.demoGuard(token, 'ADMIN', 'DISPATCHER');
    const ctx = this.ctx;
    const keep = ctx.db.users.length;
    void keep;
    ctx.db = buildSeed(ctx.now());
    ctx.deviceGps.clear();
    for (const s of Object.values(ctx.flags)) (s as Set<string> | Map<string, unknown>).clear();
    ctx.limiter.reset();
    ctx.audit(actorOf(user), 'DEMO_RESET', 'system', 'demo', null, null);
    await this.recomputeAll();
    ctx.emit('reset');
  }

  demoSetCompression(token: string, n: number) {
    const user = this.demoGuard(token);
    const v = new Check().int(n, 'simCompression', { min: 1, max: 60 });
    this.ctx.db.config.simCompression = v;
    this.ctx.audit(actorOf(user), 'DEMO_SIM_SPEED', 'system_config', 'simCompression', null, { v });
    this.ctx.emit('config');
  }

  // ------------------------------------------------------------------ system (cron/worker in production; UI timer in demo)
  readonly system = {
    tick: (compression?: number) => simTick(this.ctx, compression),
    housekeeping: () => housekeeping(this.ctx),
  };
}

export { DEMO_DOMAIN, DEMO_PASSWORD };
export { COUNTED_RESOURCES };
