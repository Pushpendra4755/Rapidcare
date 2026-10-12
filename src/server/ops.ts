import { rankHospitals, type EtaEntry } from '../lib/engine';
import { pathLengthKm, sliceFrom } from '../lib/geo';
import type { Incident, LatLng } from '../lib/types';
import type { ActiveRoute } from './db';
import type { Ctx } from './ctx';

const ONBOARD = ['PATIENT_ONBOARD', 'EN_ROUTE_HOSPITAL', 'ARRIVED', 'HANDED_OVER'];

export function pickupOf(inc: Incident): LatLng | null {
  return inc.pickupLat != null && inc.pickupLng != null ? { lat: inc.pickupLat, lng: inc.pickupLng } : null;
}

export function remainingKm(r: ActiveRoute) { return Math.max(0, r.totalKm - r.progressKm); }
export function remainingPoints(r: ActiveRoute) { return sliceFrom(r.points, r.progressKm); }

/** ETA (minutes) from an active route's remaining distance and its traffic-adjusted speed. */
export function routeEtaMinutes(r: ActiveRoute) {
  return r.speedKmph > 0 ? (remainingKm(r) / r.speedKmph) * 60 : 0;
}

/** Traffic-aware ETA + distance to every hospital's emergency entrance for this incident. */
export async function computeHospitalEtas(ctx: Ctx, inc: Incident): Promise<Record<string, EtaEntry | undefined>> {
  const amb = inc.assignedAmbulanceId ? ctx.db.ambulances.find((a) => a.id === inc.assignedAmbulanceId) : undefined;
  const pickup = pickupOf(inc);
  const onboard = ONBOARD.includes(inc.status);
  const route = ctx.db.routes[inc.id];
  let origin: LatLng | null = null;
  let preSec = 0;
  let preKm = 0;

  if (amb && onboard) origin = { lat: amb.lat, lng: amb.lng };
  else if (pickup) {
    origin = pickup;
    if (amb && amb.status !== 'OFFLINE') {
      if (route && route.leg === 'PICKUP') {
        preKm = remainingKm(route);
        preSec = routeEtaMinutes(route) * 60;
      } else {
        const r = await ctx.routing.getRoute({ lat: amb.lat, lng: amb.lng }, pickup, { severity: inc.severity, departureMs: ctx.now() });
        preKm = r.distanceKm;
        preSec = r.durationSec;
      }
    }
  } else if (amb) origin = { lat: amb.lat, lng: amb.lng };

  const out: Record<string, EtaEntry | undefined> = {};
  if (!origin) return out;
  for (const h of ctx.db.hospitals) {
    const dest = { lat: h.entranceLat, lng: h.entranceLng };
    try {
      if (route && route.leg === 'HOSPITAL' && route.hospitalId === h.id) {
        out[h.id] = { distanceKm: remainingKm(route), etaMinutes: routeEtaMinutes(route) };
        continue;
      }
      const r = await ctx.routing.getRoute(origin, dest, { severity: inc.severity, departureMs: ctx.now() });
      out[h.id] = { distanceKm: preKm + r.distanceKm, etaMinutes: (preSec + r.durationSec) / 60 };
    } catch {
      out[h.id] = undefined;
    }
  }
  return out;
}

export async function refreshRecommendations(ctx: Ctx, incidentId: string, o: { log?: boolean } = {}) {
  const inc = ctx.incident(incidentId);
  if (!ctx.isActive(inc)) return;
  const etas = await computeHospitalEtas(ctx, inc);
  const preferred = inc.patientAgeGroup === 'CHILD' && !inc.requiredCapabilities.includes('PEDIATRIC') ? (['PEDIATRIC'] as const) : [];
  const recs = rankHospitals({
    incident: { ...inc, preferredCapabilities: [...preferred] },
    hospitals: ctx.db.hospitals.map((h) => ({ hospital: h, status: ctx.statusView(h.id) })),
    eta: etas,
    workload: ctx.workload(inc.id),
    config: ctx.db.config,
    serviceAreas: ctx.db.serviceAreas,
    nowIso: ctx.nowIso(),
  });
  ctx.db.recommendations[inc.id] = recs;

  // keep the incident's displayed ETA in step with the selected destination
  const route = ctx.db.routes[inc.id];
  if (route) {
    inc.etaMinutes = Math.max(0, Math.round(routeEtaMinutes(route)));
    inc.etaDistanceKm = Math.round(remainingKm(route) * 10) / 10;
    inc.etaUpdatedAt = ctx.nowIso();
  } else if (inc.selectedHospitalId) {
    const r = recs.find((x) => x.hospitalId === inc.selectedHospitalId);
    if (r && r.etaMinutes != null) { inc.etaMinutes = r.etaMinutes; inc.etaDistanceKm = r.distanceKm; inc.etaUpdatedAt = ctx.nowIso(); }
  }

  const top = recs.find((r) => r.rank === 1);
  const prev = ctx.flags.lastTop.get(inc.id);
  const topId = top?.hospitalId ?? null;
  if (o.log || prev === undefined || prev !== topId) {
    ctx.flags.lastTop.set(inc.id, topId);
    const name = top ? ctx.hospital(top.hospitalId).name : null;
    ctx.timeline(
      inc.id, 'RECOMMENDATIONS_GENERATED', 'System',
      top ? `Hospital recommendations generated. Recommended destination: ${name} (score ${top.finalScore}, ETA ${top.etaMinutes} min).`
        : 'Hospital recommendations generated. No eligible hospital found — review manually and call hospitals.',
      { eligible: recs.filter((r) => r.eligible).length, top: name },
    );
  }
  ctx.emit('recommendations', { incidentId: inc.id });
}

export function recordEta(ctx: Ctx, inc: Incident, leg: 'PICKUP' | 'HOSPITAL', minutes: number, km: number, force = false) {
  const hist = (ctx.db.etaHistory[inc.id] ??= []);
  const last = hist[hist.length - 1];
  const m = Math.round(minutes);
  if (!force && last && last.leg === leg && Math.abs(last.etaMinutes - m) < 1 && ctx.now() - Date.parse(last.at) < 60_000) return;
  hist.push({ at: ctx.nowIso(), etaMinutes: m, distanceKm: Math.round(km * 10) / 10, leg });
  if (hist.length > 300) hist.splice(0, hist.length - 300);
}

/** Compute and store a new active route for an incident from `from` to `dest`. */
export async function setActiveRoute(
  ctx: Ctx, inc: Incident, leg: 'PICKUP' | 'HOSPITAL', from: LatLng, dest: LatLng, hospitalId: string | null,
) {
  const r = await ctx.routing.getRoute(from, dest, { severity: inc.severity, departureMs: ctx.now() });
  const total = r.distanceKm || pathLengthKm(r.points);
  const route: ActiveRoute = {
    incidentId: inc.id, leg, points: r.points, totalKm: total, progressKm: 0,
    speedKmph: r.durationSec > 0 ? (total / r.durationSec) * 3600 : 40, trafficLevel: r.trafficLevel, destination: dest,
    hospitalId, computedAt: ctx.now(),
  };
  ctx.db.routes[inc.id] = route;
  inc.etaMinutes = Math.max(1, Math.round(routeEtaMinutes(route)));
  inc.etaDistanceKm = Math.round(total * 10) / 10;
  inc.etaUpdatedAt = ctx.nowIso();
  recordEta(ctx, inc, leg, routeEtaMinutes(route), total, true);
  return route;
}

export function clearRoute(ctx: Ctx, incidentId: string) { delete ctx.db.routes[incidentId]; }
