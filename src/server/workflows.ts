import { deriveCapabilities } from '../lib/engine';
import { haversineKm, isValidLatLng, pointAlong } from '../lib/geo';
import { DECLINE_REASONS, EMERGENCY_LABEL, OVERRIDE_REASONS, RESOURCE_LABEL, RESOURCE_SHORT } from '../lib/labels';
import {
  ACCEPTANCE_STATUSES, AGE_GROUPS, CAPABILITIES, COUNTED_RESOURCES, EMERGENCY_TYPES, PREP_ITEMS, RESOURCES, SEVERITIES,
  type AcceptanceStatus, type AgeGroup, type Capability, type CountedResource, type EmergencyType, type HospitalRequest,
  type Incident, type PickupSource, type PrepItem, type ResourceKey, type Role, type Severity,
} from '../lib/types';
import { ApiError, Check } from './core';
import { actorOf, type Ctx } from './ctx';
import type { StoredUser } from './db';
import { clearRoute, pickupOf, recordEta, refreshRecommendations, setActiveRoute } from './ops';
import { GAZETTEER, zoneOf } from './seed';

export function need(user: StoredUser, ...roles: Role[]) {
  if (!roles.includes(user.role)) throw new ApiError(403, 'FORBIDDEN', 'Your role is not permitted to perform this action.');
}

const hospName = (ctx: Ctx, id: string) => ctx.db.hospitals.find((h) => h.id === id)?.name ?? id;

// =============================================================================================
// Incidents
// =============================================================================================
export interface CreateIncidentInput {
  emergencyType: EmergencyType;
  severity: Severity;
  patientAgeGroup: AgeGroup;
  requiredResources: ResourceKey[];
  requiredSpecialty: Capability | null;
  pickup: { method: PickupSource; lat?: number; lng?: number; address?: string; consent?: boolean };
  notes: string;
  assignedAmbulanceId?: string | null;
}

export function geocodeDemo(address: string): { lat: number; lng: number; name: string } | null {
  const q = address.trim().toLowerCase();
  if (q.length < 3) return null;
  const hit = GAZETTEER.find((g) => g.name.toLowerCase().includes(q)) ?? GAZETTEER.find((g) => q.includes(g.name.split(',')[0].toLowerCase()));
  return hit ?? null;
}

export async function createIncident(ctx: Ctx, user: StoredUser, input: CreateIncidentInput): Promise<Incident> {
  need(user, 'DISPATCHER', 'ADMIN');
  const c = new Check();
  const type = c.oneOf(input.emergencyType, EMERGENCY_TYPES, 'emergencyType', 'Emergency type');
  const severity = c.oneOf(input.severity, SEVERITIES, 'severity', 'Severity');
  const age = c.oneOf(input.patientAgeGroup, AGE_GROUPS, 'patientAgeGroup', 'Patient age group');
  const resources = Array.isArray(input.requiredResources) ? input.requiredResources : [];
  for (const r of resources) if (!(RESOURCES as readonly string[]).includes(r)) c.fail('requiredResources', `Unknown resource: ${String(r)}`);
  const specialty = input.requiredSpecialty == null || (input.requiredSpecialty as string) === ''
    ? null : c.oneOf(input.requiredSpecialty, CAPABILITIES, 'requiredSpecialty', 'Specialty');
  const notes = c.str(input.notes, 'notes', { max: 400, optional: true, label: 'Notes' });
  if (/\b\d{10,}\b/.test(notes) || /@/.test(notes)) c.fail('notes', 'Do not enter phone numbers, ID numbers or email addresses. Keep notes clinical and anonymous.');
  const cat = ctx.db.categories.find((x) => x.id === type);
  if (cat && !cat.active) c.fail('emergencyType', 'This emergency category is currently disabled.');

  const method = c.oneOf(input.pickup?.method, ['ADDRESS', 'MAP_PIN', 'CALLER_SHARED'] as const, 'pickup', 'Pickup method');
  let lat = 0, lng = 0, address: string | null = null;
  if (method === 'MAP_PIN') {
    if (!isValidLatLng(input.pickup.lat, input.pickup.lng)) c.fail('pickup', 'Drop a pin on the map to set the pickup location.');
    else { lat = input.pickup.lat!; lng = input.pickup.lng!; address = c.str(input.pickup.address, 'pickupAddress', { optional: true, max: 160 }) || `Pin ${lat.toFixed(4)}, ${lng.toFixed(4)}`; }
  } else if (method === 'ADDRESS') {
    const g = geocodeDemo(c.str(input.pickup.address, 'pickup', { min: 3, max: 160, label: 'Address' }));
    if (!g) c.fail('pickup', 'Address not found in the demo gazetteer. Pick a suggestion or drop a map pin instead.');
    else { lat = g.lat; lng = g.lng; address = g.name; }
  } else {
    if (input.pickup.consent !== true) c.fail('pickup', 'Caller consent must be acknowledged before using a shared location.');
    if (isValidLatLng(input.pickup.lat, input.pickup.lng)) { lat = input.pickup.lat!; lng = input.pickup.lng!; }
    else c.fail('pickup', 'Simulated caller location was not generated.');
    address = 'Caller-shared location (simulated)';
  }
  c.done();

  const caps = deriveCapabilities(type, age, resources, specialty);
  const t = ctx.nowIso();
  const seq = (ctx.db.seq.inc = (ctx.db.seq.inc ?? 1000) + 1);
  const inc: Incident = {
    id: `inc_${seq}`, incidentCode: `INC-2026-${seq}`, emergencyType: type, severity, patientAgeGroup: age,
    pickupLat: lat, pickupLng: lng, pickupAddress: address, pickupSource: method, pickupPrecisionReduced: false,
    regionId: zoneOf({ lat, lng }), requiredResources: [...new Set(resources)], requiredCapabilities: caps.required,
    preArrivalNotes: notes, status: 'NEW', assignedAmbulanceId: null, selectedHospitalId: null, destinationConfirmed: false,
    declinedHospitalIds: [], tripStarted: false, escalationLevel: 0, handoverConfirmed: false, createdBy: user.id,
    createdAt: t, updatedAt: t, closedAt: null, etaMinutes: null, etaDistanceKm: null, etaUpdatedAt: null,
  };
  ctx.db.incidents.push(inc);
  const a = actorOf(user);
  ctx.audit(a, 'INCIDENT_CREATED', 'incident', inc.id, null, { code: inc.incidentCode, type, severity, pickupSource: method });
  ctx.timeline(inc.id, 'INCIDENT_CREATED', user.fullName, `${EMERGENCY_LABEL[type]} incident created (${severity.toLowerCase()} severity).`);
  ctx.timeline(inc.id, 'PICKUP_ADDED', user.fullName, `Pickup location added (${method === 'MAP_PIN' ? 'map pin' : method === 'ADDRESS' ? 'address' : 'simulated caller-shared location'}).`);
  ctx.notify({ role: 'DISPATCHER' }, {
    type: 'NEW_EMERGENCY', title: 'New emergency created', incidentId: inc.id, requiresAck: true,
    severity: severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
    message: `${severity} ${EMERGENCY_LABEL[type].toLowerCase()} incident ${inc.incidentCode} at ${address}.`,
  });
  await refreshRecommendations(ctx, inc.id, { log: true });
  if (input.assignedAmbulanceId) await assignAmbulance(ctx, user, inc.id, input.assignedAmbulanceId, {});
  ctx.emit('incident', { incidentId: inc.id });
  return ctx.incident(inc.id);
}

export async function assignAmbulance(ctx: Ctx, user: StoredUser, incidentId: string, ambulanceId: string, o: { confirmReassign?: boolean }) {
  need(user, 'DISPATCHER', 'ADMIN');
  const inc = ctx.incident(incidentId);
  if (!ctx.isActive(inc)) throw new ApiError(409, 'INCIDENT_CLOSED', 'This incident is closed.');
  const amb = ctx.ambulanceRaw(ambulanceId);
  const prevId = inc.assignedAmbulanceId;
  if (prevId === ambulanceId) return inc;
  if (amb.status === 'OFFLINE') throw new ApiError(409, 'AMBULANCE_OFFLINE', `${amb.code} is off duty and cannot be assigned.`);
  if (amb.status !== 'AVAILABLE') throw new ApiError(409, 'AMBULANCE_BUSY', `${amb.code} is not available (${amb.status.toLowerCase().replace(/_/g, ' ')}).`);
  if (prevId) {
    const prev = ctx.ambulanceRaw(prevId);
    if (['PATIENT_ONBOARD', 'EN_ROUTE_HOSPITAL', 'AT_HOSPITAL'].includes(prev.status)) {
      throw new ApiError(409, 'PATIENT_ONBOARD', 'The patient is already onboard. The ambulance cannot be reassigned.');
    }
    if (o.confirmReassign !== true) throw new ApiError(409, 'REASSIGN_CONFIRM_REQUIRED', `${prev.code} is already assigned. Confirm reassignment to ${amb.code}.`);
    prev.status = 'AVAILABLE'; prev.updatedAt = ctx.nowIso();
    clearRoute(ctx, inc.id);
    inc.tripStarted = false;
    ctx.timeline(inc.id, 'AMBULANCE_REASSIGNED', user.fullName, `Ambulance reassigned from ${prev.code} to ${amb.code}.`);
    ctx.audit(actorOf(user), 'AMBULANCE_REASSIGN', 'incident', inc.id, { ambulance: prev.code }, { ambulance: amb.code });
    ctx.notify({ ambulanceId: prev.id }, { type: 'REASSIGNED', title: 'Assignment cancelled', message: `${inc.incidentCode} was reassigned to another ambulance.`, incidentId: inc.id, severity: 'WARNING' });
    ctx.emit('ambulance', { ambulanceId: prev.id, incidentId: inc.id });
  } else {
    ctx.audit(actorOf(user), 'AMBULANCE_ASSIGN', 'incident', inc.id, null, { ambulance: amb.code });
  }
  amb.status = 'ASSIGNED'; amb.updatedAt = ctx.nowIso();
  inc.assignedAmbulanceId = amb.id; inc.status = 'AMBULANCE_ASSIGNED'; inc.updatedAt = ctx.nowIso();
  ctx.timeline(inc.id, 'AMBULANCE_ASSIGNED', user.fullName, `${amb.code} assigned to ${inc.incidentCode}.`);
  const p = pickupOf(inc);
  if (p) await setActiveRoute(ctx, inc, 'PICKUP', { lat: amb.lat, lng: amb.lng }, p, null);
  ctx.notify({ ambulanceId: amb.id }, { type: 'AMBULANCE_ASSIGNED', title: 'New emergency assignment', message: `${inc.severity} ${EMERGENCY_LABEL[inc.emergencyType].toLowerCase()} — ${inc.incidentCode}. Start trip when ready.`, incidentId: inc.id, severity: inc.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING', requiresAck: true });
  ctx.notify({ role: 'DISPATCHER' }, { type: 'AMBULANCE_ASSIGNED', title: 'Ambulance assigned', message: `${amb.code} assigned to ${inc.incidentCode}.`, incidentId: inc.id });
  await refreshRecommendations(ctx, inc.id);
  ctx.emit('incident', { incidentId: inc.id, ambulanceId: amb.id });
  return inc;
}

export interface SendRequestOptions {
  overrideConfirmed?: boolean;
  overrideReason?: string;
  staleAcknowledged?: boolean;
  confirmReassignDestination?: boolean;
}

/** Dispatcher sends an incoming-case alert. The destination is only "recommended" until the hospital accepts. */
export async function sendHospitalRequest(ctx: Ctx, user: StoredUser, incidentId: string, hospitalId: string, o: SendRequestOptions = {}) {
  need(user, 'DISPATCHER', 'ADMIN');
  const inc = ctx.incident(incidentId);
  if (!ctx.isActive(inc)) throw new ApiError(409, 'INCIDENT_CLOSED', 'This incident is closed.');
  if (!inc.assignedAmbulanceId) throw new ApiError(409, 'NO_AMBULANCE', 'Assign an ambulance before alerting a hospital.');
  const hosp = ctx.hospital(hospitalId);
  await refreshRecommendations(ctx, inc.id);
  const rec = (ctx.db.recommendations[inc.id] ?? []).find((r) => r.hospitalId === hospitalId);
  const top = (ctx.db.recommendations[inc.id] ?? []).find((r) => r.rank === 1);
  const c = new Check();

  let overridden = false;
  let reason = '';
  if (!rec || !rec.eligible) {
    overridden = true;
    if (o.overrideConfirmed !== true) {
      throw new ApiError(409, 'OVERRIDE_REQUIRED', `${hosp.name} is not eligible: ${rec?.ineligibilityReasons[0] ?? 'no data'} Explicit override confirmation and a reason are required.`);
    }
  } else if (top && top.hospitalId !== hospitalId) overridden = true;
  if (overridden) {
    reason = c.str(o.overrideReason, 'overrideReason', { min: 3, max: 200, label: 'Override reason' });
    c.done();
  }
  if (rec?.eligible && rec.freshness === 'STALE' && o.staleAcknowledged !== true) {
    throw new ApiError(409, 'STALE_ACK_REQUIRED', 'Capacity data for this hospital is stale. Acknowledge that it must be verified by phone before sending.');
  }

  const existing = ctx.activeRequestFor(inc.id);
  if (existing && existing.hospitalId === hospitalId && ['PENDING', 'INFO_REQUESTED', 'ACCEPTED'].includes(existing.status)) {
    throw new ApiError(409, 'ALREADY_REQUESTED', 'A request is already active for this hospital.');
  }
  if (existing && ['PENDING', 'INFO_REQUESTED', 'ACCEPTED'].includes(existing.status)) {
    if (existing.status === 'ACCEPTED' && o.confirmReassignDestination !== true) {
      throw new ApiError(409, 'DESTINATION_CONFIRM_REQUIRED', `${hospName(ctx, existing.hospitalId)} has already accepted. Confirm that you want to cancel and redirect.`);
    }
    existing.status = 'CANCELLED'; existing.respondedAt = ctx.nowIso();
    inc.destinationConfirmed = false;
    ctx.timeline(inc.id, 'NOTE', user.fullName, `Request to ${hospName(ctx, existing.hospitalId)} cancelled.`);
    ctx.notify({ hospitalId: existing.hospitalId }, { type: 'INFO', title: 'Incoming case cancelled', message: `${inc.incidentCode} was redirected. No arrival expected.`, incidentId: inc.id, severity: 'WARNING' });
    ctx.emit('request', { hospitalId: existing.hospitalId, incidentId: inc.id });
  } else if (existing && existing.status === 'NO_RESPONSE') {
    existing.status = 'ESCALATED';
  }

  const sentAt = ctx.now();
  const req: HospitalRequest = {
    id: ctx.id('req', 'req'), incidentId: inc.id, hospitalId, status: 'PENDING', sentAt: new Date(sentAt).toISOString(), acknowledgedAt: null,
    respondedAt: null, decision: null, declineReason: null, estimatedArrivalMinutes: rec?.etaMinutes ?? inc.etaMinutes,
    expiresAt: new Date(sentAt + ctx.db.config.ackTimeoutSec * 1000).toISOString(), reservedResources: [], infoRequestMessage: null,
    dispatcherReply: null, overrideReason: overridden ? reason : null,
    prepChecklist: Object.fromEntries(PREP_ITEMS.map((p) => [p, false])) as HospitalRequest['prepChecklist'], phoneCalls: [],
  };
  ctx.db.requests.push(req);
  inc.selectedHospitalId = hospitalId; inc.destinationConfirmed = false; inc.updatedAt = ctx.nowIso();
  const a = actorOf(user);
  if (overridden) {
    ctx.audit(a, 'DESTINATION_OVERRIDE', 'incident', inc.id,
      { recommended: top ? hospName(ctx, top.hospitalId) : null },
      { selected: hosp.name, eligible: !!rec?.eligible, reason });
    ctx.timeline(inc.id, 'OVERRIDE', user.fullName, `Recommendation overridden: ${hosp.name} selected. Reason: ${reason}`, { eligible: !!rec?.eligible });
  }
  ctx.audit(a, 'HOSPITAL_REQUEST_SENT', 'hospital_request', req.id, null, { incident: inc.incidentCode, hospital: hosp.name });
  ctx.timeline(inc.id, 'HOSPITAL_SELECTED', user.fullName, `${hosp.name} selected as recommended destination (awaiting hospital acceptance).`);
  ctx.timeline(inc.id, 'ALERT_SENT', user.fullName, `Incoming-case alert sent to ${hosp.name}.`);

  const amb = ctx.ambulanceRaw(inc.assignedAmbulanceId);
  const needs = [...new Set(inc.requiredResources.map((r) => RESOURCE_SHORT[r]))];
  const needsText = needs.length === 0 ? 'ER bed' : needs.length === 1 ? needs[0] : `${needs.slice(0, -1).join(', ')} and ${needs[needs.length - 1]}`;
  ctx.notify({ hospitalId }, {
    type: 'HOSPITAL_REQUEST_SENT', title: `${inc.severity === 'CRITICAL' ? 'Critical ' : ''}${EMERGENCY_LABEL[inc.emergencyType].toLowerCase()} case en route`, incidentId: inc.id,
    severity: inc.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING', requiresAck: true,
    message: `${inc.severity === 'CRITICAL' ? 'Critical ' : ''}${EMERGENCY_LABEL[inc.emergencyType].toLowerCase()} case en route. Ambulance ${amb.code}. ETA ${req.estimatedArrivalMinutes ?? '—'} min. ${needsText} required.`,
  });
  ctx.notify({ role: 'DISPATCHER' }, { type: 'HOSPITAL_REQUEST_SENT', title: 'Hospital request sent', message: `Request for ${inc.incidentCode} sent to ${hosp.name}. Awaiting acceptance.`, incidentId: inc.id });
  ctx.emit('request', { hospitalId, incidentId: inc.id, ambulanceId: amb.id });
  await refreshRecommendations(ctx, inc.id);
  return req;
}

export function getRequest(ctx: Ctx, id: string): HospitalRequest {
  const r = ctx.db.requests.find((x) => x.id === id);
  if (!r) throw new ApiError(404, 'NOT_FOUND', 'Request not found.');
  return r;
}

function assertHospitalAccess(user: StoredUser, hospitalId: string) {
  if (user.role === 'ADMIN') return;
  if (user.role !== 'HOSPITAL_STAFF' || user.hospitalId !== hospitalId) throw new ApiError(403, 'FORBIDDEN', 'You can only act on your own hospital.');
}

export function acknowledgeRequest(ctx: Ctx, user: StoredUser, requestId: string) {
  const r = getRequest(ctx, requestId);
  assertHospitalAccess(user, r.hospitalId);
  if (r.acknowledgedAt) return r;
  r.acknowledgedAt = ctx.nowIso();
  const inc = ctx.incident(r.incidentId);
  ctx.timeline(inc.id, 'HOSPITAL_ACKNOWLEDGED', user.fullName, `${hospName(ctx, r.hospitalId)} acknowledged the incoming-case alert.`);
  ctx.audit(actorOf(user), 'HOSPITAL_REQUEST_ACK', 'hospital_request', r.id, null, { acknowledgedAt: r.acknowledgedAt });
  for (const n of ctx.db.notifications) {
    if (n.incidentId === inc.id && n.recipientHospitalId === r.hospitalId && n.status !== 'ACKNOWLEDGED') { n.status = 'ACKNOWLEDGED'; n.acknowledgedAt = r.acknowledgedAt; }
  }
  ctx.notify({ role: 'DISPATCHER' }, { type: 'INFO', title: 'Hospital acknowledged', message: `${hospName(ctx, r.hospitalId)} acknowledged ${inc.incidentCode}.`, incidentId: inc.id });
  ctx.emit('request', { hospitalId: r.hospitalId, incidentId: inc.id });
  return r;
}

export interface RespondInput {
  decision: 'ACCEPT' | 'DECLINE' | 'MORE_INFO';
  declineReason?: string;
  note?: string;
  reservedResources?: ResourceKey[];
}

export async function respondToRequest(ctx: Ctx, user: StoredUser, requestId: string, input: RespondInput, via: 'HOSPITAL' | 'DEMO' = 'HOSPITAL') {
  const r = getRequest(ctx, requestId);
  if (via === 'HOSPITAL') assertHospitalAccess(user, r.hospitalId); else need(user, 'DISPATCHER', 'ADMIN');
  const inc = ctx.incident(r.incidentId);
  const late = r.status === 'NO_RESPONSE';
  if (!['PENDING', 'INFO_REQUESTED'].includes(r.status) && !late) throw new ApiError(409, 'REQUEST_CLOSED', `This request is already ${r.status.toLowerCase().replace(/_/g, ' ')}.`);
  if (late) {
    const other = ctx.db.requests.find((x) => x.incidentId === inc.id && x.id !== r.id && ['PENDING', 'INFO_REQUESTED', 'ACCEPTED'].includes(x.status));
    if (other) throw new ApiError(409, 'REQUEST_SUPERSEDED', 'The dispatcher has already redirected this case.');
  }
  if (!ctx.isActive(inc)) throw new ApiError(409, 'INCIDENT_CLOSED', 'This incident is closed.');
  const c = new Check();
  const decision = c.oneOf(input.decision, ['ACCEPT', 'DECLINE', 'MORE_INFO'] as const, 'decision', 'Decision');
  const label = via === 'DEMO' ? `${user.fullName} (simulating ${hospName(ctx, r.hospitalId)})` : user.fullName;
  const hn = hospName(ctx, r.hospitalId);
  const a = actorOf(user);
  if (!r.acknowledgedAt) { r.acknowledgedAt = ctx.nowIso(); ctx.timeline(inc.id, 'HOSPITAL_ACKNOWLEDGED', label, `${hn} acknowledged the incoming-case alert.`); }

  if (decision === 'MORE_INFO') {
    const msg = c.str(input.note, 'note', { min: 3, max: 240, label: 'Question' });
    c.done();
    r.status = 'INFO_REQUESTED'; r.infoRequestMessage = msg;
    r.expiresAt = new Date(ctx.now() + ctx.db.config.decisionTimeoutSec * 1000).toISOString();
    ctx.timeline(inc.id, 'HOSPITAL_INFO_REQUESTED', label, `${hn} requested more information: ${msg}`);
    ctx.notify({ role: 'DISPATCHER' }, { type: 'HOSPITAL_INFO_REQUEST', title: 'Hospital requests more information', message: `${hn}: ${msg}`, incidentId: inc.id, severity: 'WARNING', requiresAck: true });
    ctx.audit(a, 'HOSPITAL_INFO_REQUEST', 'hospital_request', r.id, null, { message: msg });
  } else if (decision === 'DECLINE') {
    const reason = c.str(input.declineReason, 'declineReason', { min: 3, max: 160, label: 'Decline reason' });
    if (reason && !DECLINE_REASONS.includes(reason) && reason.length < 3) c.fail('declineReason', 'Choose a reason.');
    c.done();
    const prevStatus = r.status;
    r.status = 'DECLINED'; r.decision = 'DECLINE'; r.declineReason = reason; r.respondedAt = ctx.nowIso();
    if (!inc.declinedHospitalIds.includes(r.hospitalId)) inc.declinedHospitalIds.push(r.hospitalId);
    inc.selectedHospitalId = null; inc.destinationConfirmed = false;
    ctx.timeline(inc.id, 'HOSPITAL_DECLINED', label, `${hn} declined: ${reason}`);
    ctx.audit(a, 'HOSPITAL_DECLINE', 'hospital_request', r.id, { status: prevStatus }, { status: 'DECLINED', reason, simulated: via === 'DEMO' });
    await refreshRecommendations(ctx, inc.id, { log: true });
    const next = (ctx.db.recommendations[inc.id] ?? []).find((x) => x.rank === 1);
    ctx.notify({ role: 'DISPATCHER' }, {
      type: 'HOSPITAL_DECLINED', title: 'Hospital declined', incidentId: inc.id, severity: 'CRITICAL', requiresAck: true,
      message: `${hn} declined ${inc.incidentCode}: ${reason}. ${next ? `New recommended destination: ${hospName(ctx, next.hospitalId)} (ETA ${next.etaMinutes} min). Review before sending.` : 'No eligible hospital remains — review alternatives and call hospitals.'}`,
    });
  } else {
    c.done();
    const reserved = (input.reservedResources ?? inc.requiredResources).filter((x) => (RESOURCES as readonly string[]).includes(x));
    r.status = 'ACCEPTED'; r.decision = 'ACCEPT'; r.respondedAt = ctx.nowIso(); r.reservedResources = reserved;
    inc.selectedHospitalId = r.hospitalId; inc.destinationConfirmed = true; inc.updatedAt = ctx.nowIso();
    ctx.timeline(inc.id, 'HOSPITAL_ACCEPTED', label, `${hn} accepted the case${reserved.length ? ` and reserved: ${reserved.map((x) => RESOURCE_LABEL[x]).join(', ')}` : ''}.`);
    ctx.audit(a, 'HOSPITAL_ACCEPT', 'hospital_request', r.id, null, { hospital: hn, reserved, simulated: via === 'DEMO' });
    ctx.notify({ role: 'DISPATCHER' }, { type: 'HOSPITAL_ACCEPTED', title: 'Hospital accepted', message: `${hn} accepted ${inc.incidentCode}. Destination confirmed.`, incidentId: inc.id, severity: 'INFO' });
    if (inc.assignedAmbulanceId) {
      ctx.notify({ ambulanceId: inc.assignedAmbulanceId }, { type: 'HOSPITAL_ACCEPTED', title: 'Destination confirmed', message: `${hn} accepted. Proceed to the emergency entrance when patient is onboard.`, incidentId: inc.id, severity: 'INFO' });
      const amb = ctx.ambulanceRaw(inc.assignedAmbulanceId);
      if (amb.status === 'PATIENT_ONBOARD') await beginRouteToHospital(ctx, inc, amb.id, 'System');
    }
    await refreshRecommendations(ctx, inc.id);
  }
  ctx.emit('request', { hospitalId: r.hospitalId, incidentId: inc.id, ambulanceId: inc.assignedAmbulanceId });
  return r;
}

export async function beginRouteToHospital(ctx: Ctx, inc: Incident, ambulanceId: string, actorLabel: string) {
  const amb = ctx.ambulanceRaw(ambulanceId);
  if (!inc.selectedHospitalId) throw new ApiError(409, 'NO_DESTINATION', 'No destination hospital selected.');
  const h = ctx.hospital(inc.selectedHospitalId);
  await setActiveRoute(ctx, inc, 'HOSPITAL', { lat: amb.lat, lng: amb.lng }, { lat: h.entranceLat, lng: h.entranceLng }, h.id);
  amb.status = 'EN_ROUTE_HOSPITAL'; amb.updatedAt = ctx.nowIso();
  inc.status = 'EN_ROUTE_HOSPITAL'; inc.updatedAt = ctx.nowIso();
  ctx.timeline(inc.id, 'EN_ROUTE_HOSPITAL', actorLabel, `Route set to ${h.name} emergency entrance (ETA ${inc.etaMinutes} min).`);
  ctx.emit('ambulance', { ambulanceId, incidentId: inc.id, hospitalId: h.id });
}

export function replyToInfoRequest(ctx: Ctx, user: StoredUser, requestId: string, message: string) {
  need(user, 'DISPATCHER', 'ADMIN');
  const r = getRequest(ctx, requestId);
  if (r.status !== 'INFO_REQUESTED') throw new ApiError(409, 'NOT_WAITING', 'The hospital has not requested more information.');
  const c = new Check();
  const m = c.str(message, 'message', { min: 3, max: 240, label: 'Reply' });
  c.done();
  r.dispatcherReply = m; r.status = 'PENDING'; r.acknowledgedAt ??= ctx.nowIso();
  r.expiresAt = new Date(ctx.now() + ctx.db.config.decisionTimeoutSec * 1000).toISOString();
  ctx.timeline(r.incidentId, 'DISPATCHER_REPLY', user.fullName, `Dispatcher replied to ${hospName(ctx, r.hospitalId)}: ${m}`);
  ctx.notify({ hospitalId: r.hospitalId }, { type: 'INFO', title: 'Dispatcher replied', message: m, incidentId: r.incidentId, severity: 'WARNING' });
  ctx.emit('request', { hospitalId: r.hospitalId, incidentId: r.incidentId });
  return r;
}

export function updatePrep(ctx: Ctx, user: StoredUser, requestId: string, item: PrepItem, value: boolean) {
  const r = getRequest(ctx, requestId);
  assertHospitalAccess(user, r.hospitalId);
  if (!(PREP_ITEMS as readonly string[]).includes(item)) throw new ApiError(422, 'VALIDATION', 'Unknown checklist item.');
  r.prepChecklist[item] = !!value;
  ctx.emit('request', { hospitalId: r.hospitalId, incidentId: r.incidentId });
  return r;
}

export async function recordPhoneCall(ctx: Ctx, user: StoredUser, requestId: string, outcome: 'ACCEPTED' | 'DECLINED' | 'NO_ANSWER' | 'CALL_BACK_LATER', note: string) {
  need(user, 'DISPATCHER', 'ADMIN');
  const r = getRequest(ctx, requestId);
  const c = new Check();
  const oc = c.oneOf(outcome, ['ACCEPTED', 'DECLINED', 'NO_ANSWER', 'CALL_BACK_LATER'] as const, 'outcome', 'Call outcome');
  const n = c.str(note, 'note', { max: 200, optional: true, label: 'Note' });
  c.done();
  const inc = ctx.incident(r.incidentId);
  const hn = hospName(ctx, r.hospitalId);
  r.phoneCalls.push({ at: ctx.nowIso(), by: user.fullName, outcome: oc, note: n });
  ctx.timeline(inc.id, 'PHONE_CALL', user.fullName, `Called ${hn} by phone — outcome: ${oc.replace(/_/g, ' ').toLowerCase()}${n ? ` (${n})` : ''}.`);
  ctx.audit(actorOf(user), 'PHONE_CALL_RECORDED', 'hospital_request', r.id, null, { hospital: hn, outcome: oc });
  if (['PENDING', 'INFO_REQUESTED', 'NO_RESPONSE'].includes(r.status)) {
    if (oc === 'ACCEPTED') {
      r.status = 'ACCEPTED'; r.decision = 'PHONE_ACCEPT'; r.respondedAt = ctx.nowIso(); r.reservedResources = [];
      inc.selectedHospitalId = r.hospitalId; inc.destinationConfirmed = true;
      ctx.timeline(inc.id, 'HOSPITAL_ACCEPTED', user.fullName, `${hn} accepted by phone (recorded by dispatcher).`);
      if (inc.assignedAmbulanceId && ctx.ambulanceRaw(inc.assignedAmbulanceId).status === 'PATIENT_ONBOARD') await beginRouteToHospital(ctx, inc, inc.assignedAmbulanceId, 'System');
    } else if (oc === 'DECLINED') {
      r.status = 'DECLINED'; r.decision = 'PHONE_DECLINE'; r.declineReason = n || 'Declined by phone'; r.respondedAt = ctx.nowIso();
      if (!inc.declinedHospitalIds.includes(r.hospitalId)) inc.declinedHospitalIds.push(r.hospitalId);
      inc.selectedHospitalId = null; inc.destinationConfirmed = false;
      ctx.timeline(inc.id, 'HOSPITAL_DECLINED', user.fullName, `${hn} declined by phone.`);
    }
  }
  await refreshRecommendations(ctx, inc.id, { log: oc === 'DECLINED' });
  ctx.emit('request', { hospitalId: r.hospitalId, incidentId: inc.id, ambulanceId: inc.assignedAmbulanceId });
  return r;
}

/** Escalate when a hospital has not responded (or a critical case needs attention). Never auto-dispatches. */
export async function escalateIncident(ctx: Ctx, user: StoredUser, incidentId: string, note: string) {
  need(user, 'DISPATCHER', 'ADMIN');
  const inc = ctx.incident(incidentId);
  if (!ctx.isActive(inc)) throw new ApiError(409, 'INCIDENT_CLOSED', 'This incident is closed.');
  const c = new Check();
  const n = c.str(note, 'note', { max: 200, optional: true });
  c.done();
  inc.escalationLevel += 1;
  ctx.timeline(inc.id, 'ESCALATED', user.fullName, `Incident escalated (level ${inc.escalationLevel})${n ? `: ${n}` : ''}.`);
  ctx.audit(actorOf(user), 'ESCALATION', 'incident', inc.id, { level: inc.escalationLevel - 1 }, { level: inc.escalationLevel, note: n });
  const targets: Role[] = ctx.db.config.notifyAdminsOnEscalation ? ['ADMIN', 'DISPATCHER'] : ['DISPATCHER'];
  for (const role of targets) {
    ctx.notify({ role }, { type: 'CRITICAL_ESCALATION', title: 'Critical incident escalation', message: `${inc.incidentCode} escalated (level ${inc.escalationLevel}). ${n}`.trim(), incidentId: inc.id, severity: 'CRITICAL', requiresAck: true });
  }
  await refreshRecommendations(ctx, inc.id);
  ctx.emit('incident', { incidentId: inc.id });
  return inc;
}

export async function previewRoute(ctx: Ctx, user: StoredUser, incidentId: string, hospitalId: string) {
  need(user, 'DISPATCHER', 'ADMIN');
  const inc = ctx.incident(incidentId);
  const h = ctx.hospital(hospitalId);
  const amb = inc.assignedAmbulanceId ? ctx.ambulanceRaw(inc.assignedAmbulanceId) : null;
  const onboard = ['PATIENT_ONBOARD', 'EN_ROUTE_HOSPITAL', 'ARRIVED'].includes(inc.status);
  const from = amb && onboard ? { lat: amb.lat, lng: amb.lng } : pickupOf(inc);
  if (!from) throw new ApiError(409, 'NO_ORIGIN', 'No origin available for a route preview.');
  const r = await ctx.routing.getRoute(from, { lat: h.entranceLat, lng: h.entranceLng }, { severity: inc.severity, departureMs: ctx.now() });
  return { hospitalId, points: r.points, distanceKm: Math.round(r.distanceKm * 10) / 10, etaMinutes: Math.round(r.durationSec / 60), trafficLevel: r.trafficLevel, from: onboard ? 'ambulance' : 'pickup' };
}

export function confirmHandover(ctx: Ctx, user: StoredUser, requestId: string) {
  const r = getRequest(ctx, requestId);
  assertHospitalAccess(user, r.hospitalId);
  const inc = ctx.incident(r.incidentId);
  if (r.status !== 'ACCEPTED') throw new ApiError(409, 'NOT_ACCEPTED', 'Only an accepted case can be handed over.');
  if (!['ARRIVED', 'EN_ROUTE_HOSPITAL'].includes(inc.status)) throw new ApiError(409, 'NOT_ARRIVED', 'The ambulance has not arrived yet.');
  inc.handoverConfirmed = true; inc.status = 'HANDED_OVER'; inc.updatedAt = ctx.nowIso();
  ctx.timeline(inc.id, 'HANDOVER_COMPLETED', user.fullName, `${hospName(ctx, r.hospitalId)} confirmed patient handover.`);
  ctx.audit(actorOf(user), 'HANDOVER_CONFIRMED', 'incident', inc.id, null, { hospital: hospName(ctx, r.hospitalId) });
  if (inc.assignedAmbulanceId) ctx.notify({ ambulanceId: inc.assignedAmbulanceId }, { type: 'INFO', title: 'Handover confirmed', message: 'Hospital confirmed handover. You may complete the incident.', incidentId: inc.id });
  ctx.notify({ role: 'DISPATCHER' }, { type: 'INFO', title: 'Handover completed', message: `${inc.incidentCode}: handover confirmed by ${hospName(ctx, r.hospitalId)}.`, incidentId: inc.id });
  ctx.emit('incident', { incidentId: inc.id, hospitalId: r.hospitalId, ambulanceId: inc.assignedAmbulanceId });
  return inc;
}

/** Closes (or cancels) an incident. Releases the ambulance, stops location sharing and reduces caller-location precision. */
export function closeIncident(ctx: Ctx, actor: { id: string | null; label: string; role: Role | 'SYSTEM' }, incidentId: string, o: { cancel?: boolean; reason?: string } = {}) {
  const inc = ctx.incident(incidentId);
  if (!ctx.isActive(inc)) throw new ApiError(409, 'INCIDENT_CLOSED', 'This incident is already closed.');
  const cancel = !!o.cancel;
  const prev = inc.status;
  inc.status = cancel ? 'CANCELLED' : 'CLOSED'; inc.closedAt = ctx.nowIso(); inc.updatedAt = inc.closedAt;
  if (inc.assignedAmbulanceId) {
    const amb = ctx.ambulanceRaw(inc.assignedAmbulanceId);
    amb.status = amb.status === 'OFFLINE' ? 'OFFLINE' : 'AVAILABLE';
    amb.locationSharing = false; amb.speedKmph = 0; amb.updatedAt = ctx.nowIso();
    ctx.deviceGps.delete(amb.id);
    ctx.audit(actor, 'LOCATION_SHARING_STOPPED', 'ambulance', amb.id, { sharing: true }, { sharing: false, reason: 'incident closed' });
    ctx.notify({ ambulanceId: amb.id }, { type: 'INFO', title: cancel ? 'Incident cancelled' : 'Incident closed', message: 'Location sharing has stopped. Start sharing again when you are ready for the next assignment.', incidentId: inc.id });
    ctx.emit('ambulance', { ambulanceId: amb.id, incidentId: inc.id });
  }
  for (const r of ctx.db.requests) {
    if (r.incidentId === inc.id && ['PENDING', 'INFO_REQUESTED', 'NO_RESPONSE'].includes(r.status)) {
      r.status = 'CANCELLED'; r.respondedAt = ctx.nowIso();
      ctx.notify({ hospitalId: r.hospitalId }, { type: 'INFO', title: 'Incoming case cancelled', message: `${inc.incidentCode} was ${cancel ? 'cancelled' : 'closed'}.`, incidentId: inc.id });
    }
  }
  clearRoute(ctx, inc.id);
  if (inc.pickupSource === 'CALLER_SHARED') {
    // consent: caller location expires when the incident is closed -> keep only ~1 km precision
    if (inc.pickupLat != null) inc.pickupLat = Math.round(inc.pickupLat * 100) / 100;
    if (inc.pickupLng != null) inc.pickupLng = Math.round(inc.pickupLng * 100) / 100;
    inc.pickupAddress = 'Caller-shared location (expired — precision reduced)';
    inc.pickupPrecisionReduced = true;
  }
  ctx.timeline(inc.id, cancel ? 'INCIDENT_CANCELLED' : 'INCIDENT_CLOSED', actor.label, cancel ? `Incident cancelled${o.reason ? `: ${o.reason}` : ''}.` : `Incident closed${inc.handoverConfirmed ? '' : ' (handover not confirmed by hospital)'}.`);
  ctx.audit(actor, cancel ? 'INCIDENT_CANCELLED' : 'INCIDENT_CLOSED', 'incident', inc.id, { status: prev }, { status: inc.status, reason: o.reason ?? null });
  ctx.emit('incident', { incidentId: inc.id, hospitalId: inc.selectedHospitalId, ambulanceId: inc.assignedAmbulanceId });
  return inc;
}

// =============================================================================================
// Hospital resources
// =============================================================================================
const COUNT_KEYS: { key: 'availableErBeds' | 'availableIcuBeds' | 'availableVentilators' | 'availableTraumaBays' | 'availableIsolationBeds'; total: 'totalErBeds' | 'totalIcuBeds' | 'totalVentilators' | 'totalTraumaBays' | 'totalIsolationBeds'; label: string }[] = [
  { key: 'availableErBeds', total: 'totalErBeds', label: 'ER beds' },
  { key: 'availableIcuBeds', total: 'totalIcuBeds', label: 'ICU beds' },
  { key: 'availableVentilators', total: 'totalVentilators', label: 'Ventilators' },
  { key: 'availableTraumaBays', total: 'totalTraumaBays', label: 'Trauma bays' },
  { key: 'availableIsolationBeds', total: 'totalIsolationBeds', label: 'Isolation beds' },
];

async function refreshOpenIncidents(ctx: Ctx) {
  for (const inc of ctx.db.incidents) {
    if (ctx.isActive(inc) && !['HANDED_OVER', 'ARRIVED'].includes(inc.status)) await refreshRecommendations(ctx, inc.id);
  }
}

export async function updateCapacity(ctx: Ctx, user: StoredUser, hospitalId: string, patch: Record<string, unknown>, confirmed: boolean, notes?: string) {
  assertHospitalAccess(user, hospitalId);
  const h = ctx.hospital(hospitalId);
  const raw = ctx.db.resourceStatus[hospitalId];
  const c = new Check();
  if (confirmed !== true) c.fail('confirm', 'Please confirm the update before saving.');
  const next: Record<string, number> = {};
  for (const k of COUNT_KEYS) {
    const v = patch[k.key] === undefined ? raw[k.key] : patch[k.key];
    next[k.key] = c.int(v, k.key, { min: 0, max: h[k.total], label: k.label });
    if (typeof next[k.key] === 'number' && next[k.key] > h[k.total]) c.fail(k.key, `${k.label} cannot exceed the configured total of ${h[k.total]}.`);
  }
  const note = notes === undefined ? raw.operationalNotes : c.str(notes, 'operationalNotes', { max: 240, optional: true, label: 'Notes' });
  c.done();
  const prev = { ...raw };
  const wasIcu = raw.availableIcuBeds;
  Object.assign(raw, next, { operationalNotes: note, lastVerifiedAt: ctx.nowIso(), updatedBy: user.fullName, updatedAt: ctx.nowIso(), dataSource: 'HOSPITAL_STAFF' as const });
  h.updatedAt = ctx.nowIso();
  ctx.audit(actorOf(user), 'CAPACITY_UPDATE', 'hospital_resource_status', hospitalId, prev, { ...raw });
  ctx.flags.capacityStale.delete(hospitalId); ctx.flags.capacity30.delete(hospitalId);
  if (wasIcu > 0 && raw.availableIcuBeds === 0) {
    ctx.notify({ role: 'DISPATCHER' }, { type: 'INFO', title: 'ICU capacity exhausted', message: `${h.name} now reports 0 ICU beds.`, severity: 'WARNING' });
  }
  ctx.emit('capacity', { hospitalId });
  await refreshOpenIncidents(ctx);
  return ctx.statusView(hospitalId);
}

export function confirmAvailability(ctx: Ctx, user: StoredUser, hospitalId: string) {
  assertHospitalAccess(user, hospitalId);
  const raw = ctx.db.resourceStatus[hospitalId];
  const prev = raw.lastVerifiedAt;
  raw.lastVerifiedAt = ctx.nowIso(); raw.updatedBy = user.fullName; raw.updatedAt = raw.lastVerifiedAt; raw.dataSource = 'HOSPITAL_STAFF';
  ctx.audit(actorOf(user), 'CAPACITY_CONFIRMED', 'hospital_resource_status', hospitalId, { lastVerifiedAt: prev }, { lastVerifiedAt: raw.lastVerifiedAt });
  ctx.flags.capacityStale.delete(hospitalId); ctx.flags.capacity30.delete(hospitalId);
  ctx.emit('capacity', { hospitalId });
  void refreshOpenIncidents(ctx);
  return ctx.statusView(hospitalId);
}

export async function setAcceptanceStatus(ctx: Ctx, user: StoredUser, hospitalId: string, status: AcceptanceStatus, note?: string) {
  assertHospitalAccess(user, hospitalId);
  const c = new Check();
  const s = c.oneOf(status, ACCEPTANCE_STATUSES, 'acceptanceStatus', 'Status');
  const n = note === undefined ? undefined : c.str(note, 'operationalNotes', { max: 240, optional: true });
  c.done();
  const raw = ctx.db.resourceStatus[hospitalId];
  const h = ctx.hospital(hospitalId);
  const prev = { acceptanceStatus: raw.acceptanceStatus, operationalNotes: raw.operationalNotes };
  raw.acceptanceStatus = s; if (n !== undefined) raw.operationalNotes = n;
  raw.updatedBy = user.fullName; raw.updatedAt = ctx.nowIso(); raw.dataSource = 'HOSPITAL_STAFF';
  ctx.audit(actorOf(user), 'ACCEPTANCE_STATUS_CHANGE', 'hospital_resource_status', hospitalId, prev, { acceptanceStatus: s, operationalNotes: raw.operationalNotes });
  if (s === 'DIVERTING' || s === 'UNAVAILABLE') {
    const affected = ctx.db.requests.filter((r) => r.hospitalId === hospitalId && ['PENDING', 'INFO_REQUESTED', 'ACCEPTED'].includes(r.status) && ctx.isActive(ctx.incident(r.incidentId))).length;
    ctx.notify({ role: 'DISPATCHER' }, {
      type: 'HOSPITAL_DIVERTING', title: `Hospital changed to ${s.toLowerCase()}`, severity: 'CRITICAL', requiresAck: true,
      message: `${h.name} is now ${s.toLowerCase()}.${affected ? ` ${affected} incoming case${affected > 1 ? 's are' : ' is'} affected — review destinations.` : ''}`,
    });
  }
  ctx.emit('capacity', { hospitalId });
  await refreshOpenIncidents(ctx);
  return ctx.statusView(hospitalId);
}

export async function setCapabilities(ctx: Ctx, user: StoredUser, hospitalId: string, patch: Partial<Record<Capability, boolean>>) {
  assertHospitalAccess(user, hospitalId);
  const h = ctx.hospital(hospitalId);
  const prev = { ...h.capabilities };
  for (const cp of CAPABILITIES) if (typeof patch[cp] === 'boolean') h.capabilities[cp] = patch[cp]!;
  h.updatedAt = ctx.nowIso();
  ctx.audit(actorOf(user), 'CAPABILITY_CHANGE', 'hospital', hospitalId, prev, { ...h.capabilities });
  ctx.emit('capacity', { hospitalId });
  await refreshOpenIncidents(ctx);
  return h;
}

// =============================================================================================
// Ambulance crew
// =============================================================================================
export type AmbulanceAction =
  | 'START_DUTY' | 'END_DUTY' | 'START_SHARING' | 'STOP_SHARING' | 'START_TRIP' | 'BEGIN_ROUTE_PICKUP'
  | 'ARRIVED_PICKUP' | 'PATIENT_ONBOARD' | 'BEGIN_ROUTE_HOSPITAL' | 'ARRIVED_HOSPITAL' | 'COMPLETE_INCIDENT';

function assertAmbulanceAccess(user: StoredUser, ambulanceId: string, allowDispatch = false) {
  if (user.role === 'ADMIN') return;
  if (allowDispatch && user.role === 'DISPATCHER') return;
  if (user.role !== 'AMBULANCE_CREW' || user.ambulanceId !== ambulanceId) throw new ApiError(403, 'FORBIDDEN', 'You can only act on your own ambulance.');
}

export async function ambulanceAction(ctx: Ctx, user: StoredUser, ambulanceId: string, action: AmbulanceAction, payload: { source?: 'SIMULATED' | 'DEVICE'; manual?: boolean } = {}) {
  const dispatchAllowed = action === 'PATIENT_ONBOARD';
  assertAmbulanceAccess(user, ambulanceId, dispatchAllowed);
  const amb = ctx.ambulanceRaw(ambulanceId);
  const inc = ctx.activeIncidentOfAmbulance(ambulanceId);
  const actor = actorOf(user);
  const who = user.fullName;
  const bad = (msg: string) => new ApiError(409, 'INVALID_STATE', msg);
  const touch = () => { amb.updatedAt = ctx.nowIso(); ctx.emit('ambulance', { ambulanceId, incidentId: inc?.id ?? null, hospitalId: inc?.selectedHospitalId ?? null }); };

  switch (action) {
    case 'START_DUTY':
      if (amb.status !== 'OFFLINE') throw bad('Ambulance is already on duty.');
      amb.status = 'AVAILABLE'; ctx.audit(actor, 'DUTY_STARTED', 'ambulance', amb.id, { status: 'OFFLINE' }, { status: 'AVAILABLE' });
      break;
    case 'END_DUTY':
      if (inc) throw bad('Complete or hand over the active incident before ending duty.');
      if (amb.status === 'OFFLINE') throw bad('Ambulance is already off duty.');
      amb.status = 'OFFLINE'; amb.locationSharing = false; amb.speedKmph = 0; ctx.deviceGps.delete(amb.id);
      ctx.audit(actor, 'DUTY_ENDED', 'ambulance', amb.id, { status: 'AVAILABLE' }, { status: 'OFFLINE', sharing: false });
      break;
    case 'START_SHARING':
      if (amb.status === 'OFFLINE') throw new ApiError(403, 'NOT_ON_DUTY', 'Location sharing is only allowed while on duty or on an emergency trip. Start duty first.');
      amb.locationSharing = true; amb.simSignalLoss = false;
      if (payload.source === 'DEVICE') ctx.deviceGps.add(amb.id); else ctx.deviceGps.delete(amb.id);
      ctx.audit(actor, 'LOCATION_SHARING_STARTED', 'ambulance', amb.id, { sharing: false }, { sharing: true, source: payload.source ?? 'SIMULATED' });
      break;
    case 'STOP_SHARING':
      if (!amb.locationSharing) throw bad('Location sharing is already stopped.');
      amb.locationSharing = false; amb.speedKmph = 0; ctx.deviceGps.delete(amb.id);
      ctx.audit(actor, 'LOCATION_SHARING_STOPPED', 'ambulance', amb.id, { sharing: true }, { sharing: false, reason: 'manual' });
      if (inc) ctx.notify({ role: 'DISPATCHER' }, { type: 'GPS_LOST', title: 'Crew stopped location sharing', message: `${amb.code} stopped sharing location during ${inc.incidentCode}. Last known position is shown.`, incidentId: inc.id, severity: 'WARNING' });
      break;
    case 'START_TRIP':
      if (!inc || amb.status !== 'ASSIGNED') throw bad('There is no assigned emergency to start.');
      amb.locationSharing = true; amb.simSignalLoss = false;
      if (payload.source === 'DEVICE') ctx.deviceGps.add(amb.id);
      inc.tripStarted = true;
      ctx.timeline(inc.id, 'TRIP_STARTED', who, `${amb.code} crew started the emergency trip. Location sharing is on.`);
      ctx.audit(actor, 'LOCATION_SHARING_STARTED', 'ambulance', amb.id, { sharing: false }, { sharing: true, reason: 'emergency trip' });
      break;
    case 'BEGIN_ROUTE_PICKUP': {
      if (!inc || amb.status !== 'ASSIGNED') throw bad('No assigned emergency to route to.');
      if (!inc.tripStarted) throw bad('Start the emergency trip first.');
      if (!amb.locationSharing && !payload.manual) throw bad('Start location sharing, or use the manual fallback, before departing.');
      const p = pickupOf(inc);
      if (p && (!ctx.db.routes[inc.id] || ctx.db.routes[inc.id].leg !== 'PICKUP')) await setActiveRoute(ctx, inc, 'PICKUP', { lat: amb.lat, lng: amb.lng }, p, null);
      amb.status = 'EN_ROUTE_PICKUP'; inc.status = 'EN_ROUTE_PICKUP'; inc.updatedAt = ctx.nowIso();
      ctx.timeline(inc.id, 'AMBULANCE_DEPARTED', who, `${amb.code} departed — en route to pickup (ETA ${inc.etaMinutes ?? '—'} min).`);
      break;
    }
    case 'ARRIVED_PICKUP':
      if (!inc || amb.status !== 'EN_ROUTE_PICKUP') throw bad('Ambulance is not en route to pickup.');
      amb.status = 'AT_PICKUP'; inc.status = 'AT_PICKUP'; inc.updatedAt = ctx.nowIso();
      ctx.timeline(inc.id, 'ARRIVED_PICKUP', who, `${amb.code} arrived at pickup.`);
      break;
    case 'PATIENT_ONBOARD': {
      if (!inc || !['EN_ROUTE_PICKUP', 'AT_PICKUP'].includes(amb.status)) throw bad('Patient can only be marked onboard after the ambulance has departed for pickup.');
      amb.status = 'PATIENT_ONBOARD'; inc.status = 'PATIENT_ONBOARD'; inc.updatedAt = ctx.nowIso();
      clearRoute(ctx, inc.id);
      ctx.timeline(inc.id, 'PATIENT_ONBOARD', who, 'Patient onboard.');
      ctx.notify({ role: 'DISPATCHER' }, { type: 'PATIENT_ONBOARD', title: 'Patient onboard', message: `${amb.code} has the patient onboard (${inc.incidentCode}). Review recommended destinations.`, incidentId: inc.id, severity: 'WARNING' });
      if (inc.selectedHospitalId) ctx.notify({ hospitalId: inc.selectedHospitalId }, { type: 'PATIENT_ONBOARD', title: 'Patient onboard', message: `${amb.code} has the patient onboard for ${inc.incidentCode}.`, incidentId: inc.id });
      if (inc.destinationConfirmed && inc.selectedHospitalId) await beginRouteToHospital(ctx, inc, amb.id, 'System');
      await refreshRecommendations(ctx, inc.id, { log: true });
      break;
    }
    case 'BEGIN_ROUTE_HOSPITAL':
      if (!inc || amb.status !== 'PATIENT_ONBOARD') throw bad('Patient must be onboard before routing to the hospital.');
      if (!inc.destinationConfirmed) throw bad('The hospital has not accepted yet. Wait for acceptance or contact the dispatcher.');
      await beginRouteToHospital(ctx, inc, amb.id, who);
      break;
    case 'ARRIVED_HOSPITAL':
      if (!inc || amb.status !== 'EN_ROUTE_HOSPITAL') throw bad('Ambulance is not en route to a hospital.');
      markArrivedAtHospital(ctx, inc, amb.id, who);
      break;
    case 'COMPLETE_INCIDENT':
      if (!inc || !['AT_HOSPITAL'].includes(amb.status)) throw bad('Incident can be completed after arrival at the hospital.');
      closeIncident(ctx, actor, inc.id);
      return ctx.ambulanceView(amb);
    default:
      throw new ApiError(422, 'VALIDATION', 'Unknown action.');
  }
  touch();
  if (inc) ctx.emit('incident', { incidentId: inc.id });
  return ctx.ambulanceView(amb);
}

export function markArrivedAtHospital(ctx: Ctx, inc: Incident, ambulanceId: string, who: string) {
  const amb = ctx.ambulanceRaw(ambulanceId);
  amb.status = 'AT_HOSPITAL'; amb.speedKmph = 0; inc.status = 'ARRIVED'; inc.updatedAt = ctx.nowIso(); inc.etaMinutes = 0; inc.etaDistanceKm = 0;
  clearRoute(ctx, inc.id);
  const hn = inc.selectedHospitalId ? hospName(ctx, inc.selectedHospitalId) : 'hospital';
  ctx.timeline(inc.id, 'AMBULANCE_ARRIVED', who, `${amb.code} arrived at ${hn} emergency entrance.`);
  ctx.notify({ role: 'DISPATCHER' }, { type: 'AMBULANCE_ARRIVED', title: 'Ambulance arrived', message: `${amb.code} arrived at ${hn} (${inc.incidentCode}).`, incidentId: inc.id });
  if (inc.selectedHospitalId) ctx.notify({ hospitalId: inc.selectedHospitalId }, { type: 'AMBULANCE_ARRIVED', title: 'Ambulance arrived', message: `${amb.code} has arrived. Please confirm patient handover.`, incidentId: inc.id, severity: 'WARNING', requiresAck: true });
  ctx.emit('incident', { incidentId: inc.id, hospitalId: inc.selectedHospitalId, ambulanceId });
}

export function updateLocation(
  ctx: Ctx, user: StoredUser, ambulanceId: string,
  loc: { lat: number; lng: number; accuracyMeters?: number; speedKmph?: number; headingDegrees?: number },
  kind: 'GPS' | 'MAP_PIN' | 'LAST_KNOWN' = 'GPS',
) {
  assertAmbulanceAccess(user, ambulanceId);
  const amb = ctx.ambulanceRaw(ambulanceId);
  const c = new Check();
  if (!isValidLatLng(loc.lat, loc.lng)) c.fail('location', 'Invalid coordinates.');
  c.done();
  if (amb.status === 'OFFLINE') throw new ApiError(403, 'NOT_ON_DUTY', 'Location can only be updated while on duty.');
  if (kind === 'GPS' && !amb.locationSharing) throw new ApiError(403, 'SHARING_OFF', 'Location sharing is not active. Start location sharing first.');
  ctx.limiter.check(`loc:${ambulanceId}`, 40, 60_000);
  const inc = ctx.activeIncidentOfAmbulance(ambulanceId);
  amb.lat = loc.lat; amb.lng = loc.lng; amb.gpsAccuracyMeters = kind === 'GPS' ? (loc.accuracyMeters ?? null) : null;
  amb.speedKmph = loc.speedKmph ?? 0; amb.headingDegrees = loc.headingDegrees ?? amb.headingDegrees;
  amb.lastLocationAt = ctx.nowIso(); amb.updatedAt = amb.lastLocationAt;
  ctx.db.locationHistory.push({ ambulanceId, incidentId: inc?.id ?? null, lat: amb.lat, lng: amb.lng, accuracyMeters: amb.gpsAccuracyMeters, speedKmph: amb.speedKmph, headingDegrees: amb.headingDegrees, recordedAt: amb.lastLocationAt });
  if (ctx.db.locationHistory.length > 4000) ctx.db.locationHistory.splice(0, 400);
  if (kind !== 'GPS') ctx.audit(actorOf(user), 'LOCATION_MANUAL_UPDATE', 'ambulance', ambulanceId, null, { kind });
  ctx.emit('location', { ambulanceId, incidentId: inc?.id ?? null });
  return ctx.ambulanceView(amb);
}

export function distanceFromPickup(ctx: Ctx, inc: Incident, amb: { lat: number; lng: number }) {
  const p = pickupOf(inc);
  return p ? haversineKm(p, amb) : null;
}
export { pointAlong, recordEta, COUNTED_RESOURCES, OVERRIDE_REASONS };
export type { CountedResource };
