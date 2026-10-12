import type {
  Ambulance, AppNotification, EmergencyCategory, EtaPoint, Hospital, HospitalRecommendation, HospitalRequest,
  HospitalResourceStatus, Incident, LatLng, LocationPoint, ServiceArea, SystemConfig, TimelineEvent, User,
} from '../lib/types';
import { ACTIVE_INCIDENT_STATUSES } from '../lib/types';
import type { Ctx } from './ctx';
import type { StoredUser } from './db';
import { remainingKm, remainingPoints, routeEtaMinutes } from './ops';

export interface RouteView {
  incidentId: string; leg: 'PICKUP' | 'HOSPITAL'; points: LatLng[]; distanceKm: number; etaMinutes: number;
  trafficLevel: 'LIGHT' | 'MODERATE' | 'HEAVY'; hospitalId: string | null; destination: LatLng;
}

export interface IncomingCase {
  request: HospitalRequest;
  incident: Incident;
  ambulanceCode: string | null;
  ambulanceStatus: string | null;
  gpsFreshness: string | null;
  etaMinutes: number | null;
  etaAt: string | null;
}

export interface Summary {
  activeEmergencies: number; availableAmbulances: number; hospitalsAccepting: number;
  icuAvailable: number; icuTotal: number; unackedAlerts: number; criticalActive: number;
}

export interface Snapshot {
  serverTime: number;
  me: User;
  hospitals: Hospital[];
  resourceStatus: Record<string, HospitalResourceStatus>;
  ambulances: Ambulance[];
  incidents: Incident[];
  recommendations: Record<string, HospitalRecommendation[]>;
  requests: HospitalRequest[];
  notifications: AppNotification[];
  routes: Record<string, RouteView>;
  incoming: IncomingCase[];
  serviceAreas: ServiceArea[];
  categories: EmergencyCategory[];
  config: Partial<SystemConfig>;
  summary: Summary;
  demoMode: boolean;
  sessionExpiresAt: number;
}

export interface IncidentDetail {
  incident: Incident;
  timeline: TimelineEvent[];
  etaHistory: EtaPoint[];
  requests: (HospitalRequest & { hospitalName: string })[];
  recommendations: HospitalRecommendation[];
  notifications: AppNotification[];
  trail: LocationPoint[];
  route: RouteView | null;
  ambulance: Ambulance | null;
  hospitalName: string | null;
}

export const publicUser = (u: StoredUser): User => ({
  id: u.id, fullName: u.fullName, email: u.email, role: u.role, hospitalId: u.hospitalId, ambulanceId: u.ambulanceId,
  active: u.active, createdAt: u.createdAt, updatedAt: u.updatedAt,
});

export function routeView(ctx: Ctx, incidentId: string): RouteView | null {
  const r = ctx.db.routes[incidentId];
  if (!r) return null;
  return {
    incidentId, leg: r.leg, points: remainingPoints(r), distanceKm: Math.round(remainingKm(r) * 10) / 10,
    etaMinutes: Math.max(0, Math.round(routeEtaMinutes(r))), trafficLevel: r.trafficLevel, hospitalId: r.hospitalId, destination: r.destination,
  };
}

/** Hospitals only ever see what they need to prepare: no pickup location, no creator. */
export function redactForHospital(inc: Incident): Incident {
  return { ...inc, pickupLat: null, pickupLng: null, pickupAddress: null, createdBy: '', regionId: null };
}
export function redactForCrew(inc: Incident): Incident { return { ...inc, createdBy: '' }; }

function visibleNotifications(ctx: Ctx, user: StoredUser): AppNotification[] {
  const out = ctx.db.notifications.filter((n) => {
    if (n.recipientUserId) return n.recipientUserId === user.id;
    if (n.recipientRole) return n.recipientRole === user.role || (user.role === 'ADMIN' && n.recipientRole === 'DISPATCHER');
    if (n.recipientHospitalId) return user.role === 'HOSPITAL_STAFF' && user.hospitalId === n.recipientHospitalId;
    if (n.recipientAmbulanceId) return user.role === 'AMBULANCE_CREW' && user.ambulanceId === n.recipientAmbulanceId;
    return false;
  });
  return out.slice(-60);
}

export function buildSnapshot(ctx: Ctx, user: StoredUser, expiresAt: number): Snapshot {
  const db = ctx.db;
  const cfg = db.config;
  const publicCfg: Partial<SystemConfig> = user.role === 'ADMIN' || user.role === 'DISPATCHER'
    ? cfg : { ackTimeoutSec: cfg.ackTimeoutSec, simCompression: cfg.simCompression, gpsStaleSec: cfg.gpsStaleSec, gpsLostSec: cfg.gpsLostSec, liveMinutes: cfg.liveMinutes, recentMinutes: cfg.recentMinutes };

  let hospitals: Hospital[] = [];
  let resourceStatus: Record<string, HospitalResourceStatus> = {};
  let ambulances: Ambulance[] = [];
  let incidents: Incident[] = [];
  let recommendations: Record<string, HospitalRecommendation[]> = {};
  let requests: HospitalRequest[] = [];
  let routes: Record<string, RouteView> = {};
  const incoming: IncomingCase[] = [];

  if (user.role === 'ADMIN' || user.role === 'DISPATCHER') {
    hospitals = db.hospitals;
    for (const h of hospitals) resourceStatus[h.id] = ctx.statusView(h.id);
    ambulances = db.ambulances.map((a) => ctx.ambulanceView(a));
    const sorted = [...db.incidents].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    incidents = [...sorted.filter((i) => ACTIVE_INCIDENT_STATUSES.includes(i.status)), ...sorted.filter((i) => !ACTIVE_INCIDENT_STATUSES.includes(i.status)).slice(0, 25)];
    const ids = new Set(incidents.map((i) => i.id));
    for (const id of ids) {
      if (db.recommendations[id]) recommendations[id] = db.recommendations[id];
      const rv = routeView(ctx, id);
      if (rv) routes[id] = rv;
    }
    requests = db.requests.filter((r) => ids.has(r.incidentId));
  } else if (user.role === 'HOSPITAL_STAFF' && user.hospitalId) {
    const h = ctx.hospital(user.hospitalId);
    hospitals = [h];
    resourceStatus[h.id] = ctx.statusView(h.id);
    requests = db.requests.filter((r) => r.hospitalId === h.id).slice(-40);
    for (const r of requests) {
      const inc = db.incidents.find((i) => i.id === r.incidentId);
      if (!inc) continue;
      if (['CANCELLED'].includes(r.status) && !ctx.isActive(inc)) continue;
      const amb = inc.assignedAmbulanceId ? db.ambulances.find((a) => a.id === inc.assignedAmbulanceId) : undefined;
      const av = amb ? ctx.ambulanceView(amb) : null;
      incidents.push(redactForHospital(inc));
      incoming.push({
        request: r, incident: redactForHospital(inc), ambulanceCode: amb?.code ?? null, ambulanceStatus: amb?.status ?? null,
        gpsFreshness: av?.gpsFreshness ?? null, etaMinutes: inc.etaMinutes, etaAt: inc.etaUpdatedAt,
      });
      ctx.auditSensitive({ id: user.id, label: user.fullName, role: user.role }, 'incident', inc.id, 'pre-arrival notes');
    }
  } else if (user.role === 'AMBULANCE_CREW' && user.ambulanceId) {
    const a = ctx.ambulanceRaw(user.ambulanceId);
    ambulances = [ctx.ambulanceView(a)];
    const inc = ctx.activeIncidentOfAmbulance(a.id);
    if (inc) {
      incidents = [redactForCrew(inc)];
      const rv = routeView(ctx, inc.id);
      if (rv) routes[inc.id] = rv;
      if (inc.selectedHospitalId) {
        const h = ctx.hospital(inc.selectedHospitalId);
        hospitals = [h];
        requests = db.requests.filter((r) => r.incidentId === inc.id && r.hospitalId === h.id).slice(-1)
          .map((r) => ({ ...r, phoneCalls: [], overrideReason: null }));
      }
      ctx.auditSensitive({ id: user.id, label: user.fullName, role: user.role }, 'incident', inc.id, 'pickup location + notes');
    }
  }

  const active = db.incidents.filter((i) => ctx.isActive(i) && i.status !== 'HANDED_OVER');
  const accepting = db.hospitals.filter((h) => {
    const s = ctx.statusView(h.id);
    return h.status === 'ONLINE' && (s.acceptanceStatus === 'ACCEPTING' || s.acceptanceStatus === 'LIMITED_CAPACITY') && s.freshness !== 'UNAVAILABLE';
  }).length;
  const icuAvailable = db.hospitals.reduce((n, h) => n + (db.resourceStatus[h.id]?.availableIcuBeds ?? 0), 0);
  const icuTotal = db.hospitals.reduce((n, h) => n + h.totalIcuBeds, 0);
  const dispatchNtf = db.notifications.filter((n) => n.recipientRole === 'DISPATCHER' && n.requiresAck && n.status !== 'ACKNOWLEDGED').length;

  const summary: Summary = (user.role === 'ADMIN' || user.role === 'DISPATCHER') ? {
    activeEmergencies: active.length,
    availableAmbulances: db.ambulances.filter((a) => a.status === 'AVAILABLE').length,
    hospitalsAccepting: accepting, icuAvailable, icuTotal, unackedAlerts: dispatchNtf,
    criticalActive: active.filter((i) => i.severity === 'CRITICAL').length,
  } : { activeEmergencies: 0, availableAmbulances: 0, hospitalsAccepting: 0, icuAvailable: 0, icuTotal: 0, unackedAlerts: 0, criticalActive: 0 };

  return {
    serverTime: ctx.now(), me: publicUser(user), hospitals, resourceStatus, ambulances, incidents, recommendations, requests,
    notifications: visibleNotifications(ctx, user), routes, incoming,
    serviceAreas: user.role === 'ADMIN' || user.role === 'DISPATCHER' ? db.serviceAreas : [],
    categories: db.categories, config: publicCfg, summary, demoMode: ctx.demoMode, sessionExpiresAt: expiresAt,
  };
}
