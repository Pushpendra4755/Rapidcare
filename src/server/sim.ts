import { pointAlong } from '../lib/geo';
import { gpsFreshness, hospitalFreshness } from '../lib/freshness';
import type { Ctx } from './ctx';
import { SYSTEM } from './ctx';
import { recordEta, refreshRecommendations, remainingKm, routeEtaMinutes } from './ops';
import { markArrivedAtHospital } from './workflows';

let ticking = false;

/**
 * Simulated GPS: every call represents one 10-second GPS ping. Each ping advances the vehicle by
 * (10s x compression) of travel so a demo trip finishes in a watchable time. Real devices bypass this.
 * Called by the UI timer in demo mode; a production deployment would not run this at all.
 */
export async function simTick(ctx: Ctx, compression = ctx.db.config.simCompression) {
  if (ticking) return;
  ticking = true;
  try {
    const dtHours = (10 * compression) / 3600;
    const touched = new Set<string>();
    for (const amb of ctx.db.ambulances) {
      if (amb.status === 'OFFLINE' || !amb.locationSharing || amb.simSignalLoss || ctx.deviceGps.has(amb.id)) continue;
      const inc = ctx.activeIncidentOfAmbulance(amb.id);
      const route = inc ? ctx.db.routes[inc.id] : undefined;
      const moving = !!inc && !!route && (amb.status === 'EN_ROUTE_PICKUP' || amb.status === 'EN_ROUTE_HOSPITAL')
        && ((amb.status === 'EN_ROUTE_PICKUP' && route.leg === 'PICKUP') || (amb.status === 'EN_ROUTE_HOSPITAL' && route.leg === 'HOSPITAL'));
      const nowIso = ctx.nowIso();
      if (!moving || !inc || !route) {
        amb.lastLocationAt = nowIso; amb.speedKmph = 0; amb.gpsAccuracyMeters = 6 + Math.round(Math.random() * 4);
        continue;
      }
      const move = route.speedKmph * dtHours;
      route.progressKm = Math.min(route.totalKm, route.progressKm + move);
      const p = pointAlong(route.points, route.progressKm);
      amb.lat = p.point.lat; amb.lng = p.point.lng; amb.headingDegrees = Math.round(p.heading);
      amb.speedKmph = Math.round(route.speedKmph * (0.9 + Math.random() * 0.2));
      amb.gpsAccuracyMeters = 5 + Math.round(Math.random() * 7);
      amb.lastLocationAt = nowIso; amb.updatedAt = nowIso;
      ctx.db.locationHistory.push({
        ambulanceId: amb.id, incidentId: inc.id, lat: amb.lat, lng: amb.lng, accuracyMeters: amb.gpsAccuracyMeters,
        speedKmph: amb.speedKmph, headingDegrees: amb.headingDegrees, recordedAt: nowIso,
      });
      if (ctx.db.locationHistory.length > 4000) ctx.db.locationHistory.splice(0, 400);

      const eta = routeEtaMinutes(route);
      inc.etaMinutes = Math.max(0, Math.round(eta)); inc.etaDistanceKm = Math.round(remainingKm(route) * 10) / 10; inc.etaUpdatedAt = nowIso;
      recordEta(ctx, inc, route.leg, eta, remainingKm(route));
      const last = ctx.flags.lastEtaNotified.get(inc.id);
      if (inc.selectedHospitalId && route.leg === 'HOSPITAL' && (last === undefined || Math.abs(last - inc.etaMinutes) >= 3)) {
        ctx.flags.lastEtaNotified.set(inc.id, inc.etaMinutes);
        if (last !== undefined) {
          ctx.timeline(inc.id, 'ETA_UPDATED', 'System', `ETA to hospital updated: ${inc.etaMinutes} min (${inc.etaDistanceKm} km).`);
          ctx.notify({ hospitalId: inc.selectedHospitalId }, { type: 'ETA_UPDATED', title: 'ETA updated', message: `${amb.code} ETA is now ${inc.etaMinutes} min.`, incidentId: inc.id });
        }
      }

      if (route.progressKm >= route.totalKm - 1e-6) {
        if (route.leg === 'PICKUP') {
          amb.status = 'AT_PICKUP'; inc.status = 'AT_PICKUP'; amb.speedKmph = 0;
          ctx.timeline(inc.id, 'ARRIVED_PICKUP', 'System', `${amb.code} arrived at pickup.`);
          ctx.notify({ role: 'DISPATCHER' }, { type: 'INFO', title: 'Ambulance at pickup', message: `${amb.code} reached the pickup for ${inc.incidentCode}.`, incidentId: inc.id });
          delete ctx.db.routes[inc.id];
        } else {
          markArrivedAtHospital(ctx, inc, amb.id, 'System');
        }
      }
      touched.add(inc.id);
      ctx.emit('location', { ambulanceId: amb.id, incidentId: inc.id, hospitalId: inc.selectedHospitalId });
    }
    for (const id of touched) {
      const inc = ctx.incident(id);
      if (ctx.isActive(inc) && !inc.destinationConfirmed) await refreshRecommendations(ctx, id);
    }
    ctx.emit('tick');
  } finally {
    ticking = false;
  }
}

/** Time-driven rules: request timeouts, GPS loss, stale capacity, critical-case escalation. Idempotent. */
export async function housekeeping(ctx: Ctx) {
  const now = ctx.now();
  const cfg = ctx.db.config;
  let changed = false;

  // ---- hospital request timeouts
  for (const r of ctx.db.requests) {
    if (r.status !== 'PENDING') continue;
    const inc = ctx.db.incidents.find((i) => i.id === r.incidentId);
    if (!inc || !ctx.isActive(inc)) continue;
    const sent = Date.parse(r.sentAt);
    const ack = r.acknowledgedAt ? Date.parse(r.acknowledgedAt) : null;
    const timedOut = ack == null ? now - sent > cfg.ackTimeoutSec * 1000 : now - ack > cfg.decisionTimeoutSec * 1000;
    if (!timedOut) continue;
    r.status = 'NO_RESPONSE'; r.respondedAt = ctx.nowIso(); changed = true;
    const h = ctx.hospital(r.hospitalId);
    ctx.timeline(inc.id, 'HOSPITAL_NO_RESPONSE', 'System', `No response from ${h.name} within ${ack == null ? cfg.ackTimeoutSec : cfg.decisionTimeoutSec} s.`);
    ctx.audit(SYSTEM, 'HOSPITAL_REQUEST_TIMEOUT', 'hospital_request', r.id, { status: 'PENDING' }, { status: 'NO_RESPONSE' });
    ctx.notify({ role: 'DISPATCHER' }, {
      type: 'HOSPITAL_NO_RESPONSE', title: 'Hospital request timed out', severity: 'CRITICAL', requiresAck: true, incidentId: inc.id,
      message: `Hospital request timed out. Review alternatives or call emergency contact (${h.name}: ${h.emergencyContact}).`,
    });
    ctx.emit('request', { hospitalId: r.hospitalId, incidentId: inc.id });
    await refreshRecommendations(ctx, inc.id, { log: true });
  }

  // ---- GPS freshness (active trips only)
  for (const amb of ctx.db.ambulances) {
    const inc = ctx.activeIncidentOfAmbulance(amb.id);
    const onTrip = !!inc && ['EN_ROUTE_PICKUP', 'AT_PICKUP', 'PATIENT_ONBOARD', 'EN_ROUTE_HOSPITAL'].includes(amb.status);
    const f = gpsFreshness(amb.lastLocationAt, now, amb.locationSharing, cfg).freshness;
    const key = amb.id;
    if (onTrip && amb.locationSharing && f === 'LOST' && !ctx.flags.gpsLost.has(key)) {
      ctx.flags.gpsLost.add(key); changed = true;
      ctx.timeline(inc!.id, 'GPS_LOST', 'System', `GPS signal lost for ${amb.code}. Showing last known location.`);
      ctx.notify({ role: 'DISPATCHER' }, { type: 'GPS_LOST', title: 'GPS signal lost', severity: 'CRITICAL', requiresAck: true, incidentId: inc!.id, message: `GPS signal lost for ${amb.code} on ${inc!.incidentCode}. Last known location shown — contact the crew.` });
      ctx.notify({ ambulanceId: amb.id }, { type: 'GPS_LOST', title: 'GPS unavailable — use manual fallback', severity: 'WARNING', incidentId: inc!.id, message: 'Dispatch has not received your location. Update your location by map pin or contact dispatcher.' });
    } else if (ctx.flags.gpsLost.has(key) && (f === 'LIVE' || !onTrip)) {
      ctx.flags.gpsLost.delete(key); changed = true;
      if (inc) ctx.timeline(inc.id, 'GPS_RESTORED', 'System', `GPS signal restored for ${amb.code}.`);
    }
  }

  // ---- capacity staleness
  for (const h of ctx.db.hospitals) {
    const s = ctx.db.resourceStatus[h.id];
    const f = hospitalFreshness(s?.lastVerifiedAt ?? null, now, cfg, h.status === 'ONLINE');
    if (f.freshness === 'STALE' && !ctx.flags.capacityStale.has(h.id)) {
      ctx.flags.capacityStale.add(h.id); changed = true;
      ctx.notify({ role: 'DISPATCHER' }, { type: 'CAPACITY_STALE', title: 'Capacity data became stale', severity: 'WARNING', requiresAck: true, message: `${h.name}: capacity data older than ${cfg.recentMinutes} minutes — verify by phone (${h.emergencyContact}).` });
      ctx.notify({ hospitalId: h.id }, { type: 'CAPACITY_STALE', title: 'Please confirm current availability', severity: 'WARNING', message: 'Your capacity data is stale and is being down-ranked. Confirm current availability.' });
    }
    if (f.ageMinutes != null && f.ageMinutes >= 30 && !ctx.flags.capacity30.has(h.id)) {
      ctx.flags.capacity30.add(h.id); changed = true;
      ctx.notify({ role: 'DISPATCHER' }, { type: 'CAPACITY_STALE', title: 'Capacity unverified for 30 minutes', severity: 'WARNING', message: `Hospital capacity data has not been verified for 30 minutes. (${h.name})` });
    }
    if (f.freshness === 'LIVE' || f.freshness === 'RECENT') { ctx.flags.capacityStale.delete(h.id); ctx.flags.capacity30.delete(h.id); }
  }

  // ---- critical incidents without a hospital request
  for (const inc of ctx.db.incidents) {
    if (inc.severity !== 'CRITICAL' || !ctx.isActive(inc) || ctx.flags.critEscalated.has(inc.id)) continue;
    const anyReq = ctx.db.requests.some((r) => r.incidentId === inc.id && r.status !== 'CANCELLED');
    if (anyReq) continue;
    if (now - Date.parse(inc.createdAt) > cfg.escalateCriticalAfterSec * 1000) {
      ctx.flags.critEscalated.add(inc.id); changed = true;
      ctx.notify({ role: 'DISPATCHER' }, { type: 'CRITICAL_ESCALATION', title: 'Critical incident escalation', severity: 'CRITICAL', requiresAck: true, incidentId: inc.id, message: `${inc.incidentCode} is critical and has no hospital request after ${cfg.escalateCriticalAfterSec} s.` });
      if (cfg.notifyAdminsOnEscalation) ctx.notify({ role: 'ADMIN' }, { type: 'CRITICAL_ESCALATION', title: 'Critical incident escalation', severity: 'CRITICAL', requiresAck: true, incidentId: inc.id, message: `${inc.incidentCode} is critical and still has no hospital request.` });
    }
  }

  // ---- expire sessions
  for (const [t, s] of ctx.sessions) if (s.expiresAt < now) ctx.sessions.delete(t);
  if (changed) ctx.emit('housekeeping');
}
