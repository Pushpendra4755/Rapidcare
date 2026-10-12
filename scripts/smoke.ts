// End-to-end backend smoke test of the RapidCare acceptance flow. Run: npx tsx scripts/smoke.ts
import { RapidCareBackend } from '../src/server/backend';
import { createClock } from '../src/server/core';
import { ApiError } from '../src/server/core';

let pass = 0;
let fail = 0;
function ok(cond: unknown, name: string, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
async function rejects(p: Promise<unknown> | (() => unknown), code: string, name: string) {
  try { await (typeof p === 'function' ? p() : p); ok(false, name, '(did not throw)'); } catch (e) {
    ok(e instanceof ApiError && (e.code === code || e.status === Number(code)), name, e instanceof ApiError ? `got ${e.code}` : String(e));
  }
}

const clock = createClock();
const be = await RapidCareBackend.create({ clock });
const disp = be.demoLogin('DISPATCHER').session.token;
const admin = be.demoLogin('ADMIN').session.token;
const crew1 = be.demoLoginAs('u_crew_1').session.token; // AMB-001
const central = be.demoLoginAs('u_hosp_central').session.token;
const north = be.demoLoginAs('u_hosp_north').session.token;
const hospNames = (t: string) => Object.fromEntries(be.getSnapshot(t).hospitals.map((h) => [h.id, h.name]));

console.log('\n[1] Access control');
await rejects(() => be.getSnapshot('bogus'), '401', 'invalid token rejected');
await rejects(() => be.getAuditLogs(disp), 'FORBIDDEN', 'dispatcher cannot read audit log');
ok(be.getAuditLogs(admin).length > 0, 'admin can read audit log');
await rejects(() => be.updateCapacity(north, 'h_central', { availableIcuBeds: 1 }, true), 'FORBIDDEN', 'hospital staff cannot edit another hospital');
await rejects(() => be.createIncident(central, {} as never), 'FORBIDDEN', 'hospital staff cannot create incidents');
await rejects(() => be.ambulanceAction(crew1, 'a_002', 'START_DUTY'), 'FORBIDDEN', 'crew cannot act on another ambulance');
const hs = be.getSnapshot(north);
ok(hs.hospitals.length === 1 && hs.hospitals[0].id === 'h_north', 'hospital snapshot contains only own hospital');
ok(hs.incoming.every((c) => c.incident.pickupLat === null && c.incident.createdBy === ''), 'hospital view hides pickup location and creator');
ok(hs.incidents.every((i) => be.getSnapshot(north).incoming.some((c) => c.incident.id === i.id)), 'hospital sees only incidents sent to it');
const cs = be.getSnapshot(crew1);
ok(cs.ambulances.length === 1 && cs.incidents.length === 0 && Object.keys(cs.recommendations).length === 0, 'crew snapshot is scoped to own ambulance, no recommendations');
await rejects(() => be.subscribe(north, 'hospital:h_central', () => {}), 'FORBIDDEN_CHANNEL', 'hospital cannot subscribe to another hospital channel');
await rejects(() => be.subscribe(crew1, 'dispatcher:operations', () => {}), 'FORBIDDEN_CHANNEL', 'crew cannot subscribe to dispatcher channel');

console.log('\n[2] Seeded scenarios');
const snap0 = be.getSnapshot(disp);
const recs = (code: string) => snap0.recommendations[snap0.incidents.find((i) => i.incidentCode === code)!.id];
const r1 = recs('INC-2026-1001');
ok(r1.find((r) => r.rank === 1)?.hospitalId === 'h_central', 'trauma: only Central eligible, recommended despite being farther');
const westRec = r1.find((r) => r.hospitalId === 'h_west')!;
ok(!westRec.eligible && westRec.ineligibilityReasons.some((m) => m.includes('diverting')), 'trauma: nearest (West) not eligible — diverting', westRec.ineligibilityReasons.join('|'));
ok(westRec.ineligibilityReasons.some((m) => m.includes('no ICU beds available')), 'trauma: West message "no ICU beds available"');
ok(r1.find((r) => r.hospitalId === 'h_east')!.ineligibilityReasons.some((m) => m.includes('trauma service unavailable')), 'trauma: "trauma service unavailable" message');
const r2 = recs('INC-2026-1002');
ok(r2.find((r) => r.rank === 1)?.hospitalId === 'h_east', 'stroke: stroke-capable East recommended');
const r4 = recs('INC-2026-1004');
const c4 = r4.find((r) => r.hospitalId === 'h_central')!, s4 = r4.find((r) => r.hospitalId === 'h_south')!;
ok(c4.rank === 1 && s4.rank === 2, 'cardiac: fresh Central outranks stale South');
ok(s4.label === 'STALE_VERIFY' && s4.warnings.some((w) => w.startsWith('Low confidence')), 'stale: South labelled STALE DATA — VERIFY BY PHONE with low-confidence warning');
console.log(`    recommendation: ${c4.summary}`);

console.log('\n[3] Main flow: critical trauma');
const created = await be.createIncident(disp, {
  emergencyType: 'TRAUMA', severity: 'CRITICAL', patientAgeGroup: 'ADULT', requiredResources: ['TRAUMA_BAY', 'ICU_BED'], requiredSpecialty: 'TRAUMA',
  pickup: { method: 'MAP_PIN', lat: 12.9655, lng: 77.5315 }, notes: 'Simulated crash, adult, unresponsive.',
});
ok(created.status === 'NEW' && created.incidentCode.startsWith('INC-2026-'), `incident created ${created.incidentCode}`);
ok(created.regionId === 'z_west', 'pickup mapped to West zone');
const a1 = await be.assignAmbulance(disp, created.id, 'a_001');
ok(a1.status === 'AMBULANCE_ASSIGNED' && a1.assignedAmbulanceId === 'a_001', 'AMB-001 assigned');
await rejects(() => be.assignAmbulance(disp, created.id, 'a_004'), 'AMBULANCE_OFFLINE', 'cannot assign offline ambulance');
await rejects(() => be.assignAmbulance(disp, created.id, 'a_005'), 'REASSIGN_CONFIRM_REQUIRED', 'reassignment requires confirmation');
await be.demoCrewDepart(disp, 'a_001');
ok(be.getSnapshot(disp).ambulances.find((a) => a.id === 'a_001')!.status === 'EN_ROUTE_PICKUP', 'ambulance en route to pickup');
let moved = 0;
const startPos = be.getSnapshot(disp).ambulances.find((a) => a.id === 'a_001')!;
for (let i = 0; i < 40; i++) {
  await be.system.tick(6);
  clock.advance(10_000);
  await be.system.housekeeping();
  const a = be.getSnapshot(disp).ambulances.find((x) => x.id === 'a_001')!;
  if (a.status === 'AT_PICKUP') break;
  moved++;
}
const atPickup = be.getSnapshot(disp).ambulances.find((a) => a.id === 'a_001')!;
ok(atPickup.status === 'AT_PICKUP', `simulated GPS reached pickup after ${moved} pings (10 s each)`);
ok(atPickup.lat !== startPos.lat || atPickup.lng !== startPos.lng, 'ambulance position changed via GPS simulation');
ok(atPickup.gpsFreshness === 'LIVE', 'GPS freshness LIVE while pings arrive');

await be.markPatientOnboard(disp, created.id);
let snap = be.getSnapshot(disp);
const recsOn = snap.recommendations[created.id];
ok(recsOn.find((r) => r.rank === 1)?.hospitalId === 'h_central', 'after onboard, Central recommended with explanation');
console.log(`    ${recsOn.find((r) => r.rank === 1)!.summary}`);
ok(recsOn.filter((r) => r.eligible).length === 1, 'only trauma+ICU+bay hospital is eligible');
await rejects(() => be.sendHospitalRequest(disp, created.id, 'h_west'), 'OVERRIDE_REQUIRED', 'unsuitable hospital blocked without override');
await rejects(() => be.sendHospitalRequest(disp, created.id, 'h_west', { overrideConfirmed: true }), '422', 'override requires a reason');
const req = await be.sendHospitalRequest(disp, created.id, 'h_central');
ok(req.status === 'PENDING', 'request sent to Central (pending — not reserved)');
ok(be.getSnapshot(central).incoming.some((c) => c.request.id === req.id), 'Central sees the incoming alert');
ok(be.getSnapshot(north).incoming.every((c) => c.request.id !== req.id), 'North does NOT see Central\'s alert');
ok(be.getSnapshot(central).notifications.some((n) => n.message.startsWith('Critical trauma case en route. Ambulance AMB-001.')), 'notification template text matches');
console.log(`    ${be.getSnapshot(central).notifications.slice(-1)[0].message}`);
be.acknowledgeRequest(central, req.id);
await be.respondToRequest(central, req.id, { decision: 'ACCEPT', reservedResources: ['TRAUMA_BAY', 'ICU_BED'] });
snap = be.getSnapshot(disp);
const inc = snap.incidents.find((i) => i.id === created.id)!;
ok(inc.destinationConfirmed && inc.status === 'EN_ROUTE_HOSPITAL', 'on acceptance: destination confirmed and route switched to hospital');
ok(snap.routes[created.id]?.leg === 'HOSPITAL' && snap.routes[created.id].hospitalId === 'h_central', 'active route targets Central emergency entrance');
let pings = 0;
for (let i = 0; i < 80; i++) {
  await be.system.tick(6); clock.advance(10_000); await be.system.housekeeping(); pings++;
  if (be.getSnapshot(disp).incidents.find((x) => x.id === created.id)!.status === 'ARRIVED') break;
}
ok(be.getSnapshot(disp).incidents.find((x) => x.id === created.id)!.status === 'ARRIVED', `ambulance arrived after ${pings} pings`);
be.confirmHandover(central, req.id);
await be.ambulanceAction(crew1, 'a_001', 'COMPLETE_INCIDENT');
const done = be.getSnapshot(disp).incidents.find((x) => x.id === created.id)!;
ok(done.status === 'CLOSED', 'incident closed');
const amb1 = be.getSnapshot(disp).ambulances.find((a) => a.id === 'a_001')!;
ok(amb1.status === 'AVAILABLE' && !amb1.locationSharing, 'ambulance released and location sharing stopped on completion');
const detail = be.getIncidentDetail(disp, created.id);
const types = detail.timeline.map((t) => t.type);
for (const t of ['INCIDENT_CREATED', 'PICKUP_ADDED', 'AMBULANCE_ASSIGNED', 'RECOMMENDATIONS_GENERATED', 'HOSPITAL_SELECTED', 'ALERT_SENT', 'HOSPITAL_ACCEPTED', 'AMBULANCE_DEPARTED', 'PATIENT_ONBOARD', 'EN_ROUTE_HOSPITAL', 'AMBULANCE_ARRIVED', 'HANDOVER_COMPLETED', 'INCIDENT_CLOSED']) {
  ok(types.includes(t as never), `timeline has ${t}`);
}
ok(detail.etaHistory.length > 3, `ETA history recorded (${detail.etaHistory.length} points)`);
ok(be.getAuditLogs(admin).some((a) => a.actionType === 'HOSPITAL_ACCEPT'), 'audit log records hospital acceptance');

console.log('\n[4] Decline → re-rank (cardiac)');
const card = be.getSnapshot(disp).incidents.find((i) => i.incidentCode === 'INC-2026-1004')!;
await be.assignAmbulance(disp, card.id, 'a_005');
const r = await be.sendHospitalRequest(disp, card.id, 'h_central');
await be.respondToRequest(central, r.id, { decision: 'DECLINE', declineReason: 'No ICU bed available' });
const after = be.getSnapshot(disp).recommendations[card.id];
ok(!after.find((x) => x.hospitalId === 'h_central')!.eligible, 'declining hospital becomes ineligible');
ok(after.find((x) => x.rank === 1)?.hospitalId === 'h_south', 'next suitable hospital (South) recommended after decline');
ok(after.find((x) => x.rank === 1)?.label === 'STALE_VERIFY', 'next hospital flagged stale — verify by phone');
await rejects(() => be.sendHospitalRequest(disp, card.id, 'h_south'), 'STALE_ACK_REQUIRED', 'stale hospital requires acknowledgement');
const r5 = await be.sendHospitalRequest(disp, card.id, 'h_south', { staleAcknowledged: true });
ok(r5.status === 'PENDING', 'request to stale hospital sent after acknowledgement');

console.log('\n[5] No-response timeout + escalation + phone fallback');
clock.advance(61_000);
await be.system.housekeeping();
const nr = be.getSnapshot(disp).requests.find((x) => x.id === r5.id)!;
ok(nr.status === 'NO_RESPONSE', 'request marked NO_RESPONSE after 60 s');
ok(be.getSnapshot(disp).notifications.some((n) => n.type === 'HOSPITAL_NO_RESPONSE'), 'dispatcher alerted about timeout');
await be.escalateIncident(disp, card.id, 'South did not answer');
ok(be.getSnapshot(disp).incidents.find((i) => i.id === card.id)!.escalationLevel === 1, 'incident escalated');
await be.recordPhoneCall(disp, r5.id, 'ACCEPTED', 'Charge nurse confirmed by phone');
ok(be.getSnapshot(disp).incidents.find((i) => i.id === card.id)!.destinationConfirmed, 'phone acceptance recorded and destination confirmed');

console.log('\n[6] Capacity validation, freshness and GPS loss');
await rejects(() => be.updateCapacity(central, 'h_central', { availableIcuBeds: -1 }, true), '422', 'negative counts rejected');
await rejects(() => be.updateCapacity(central, 'h_central', { availableIcuBeds: 99 }, true), '422', 'count above total rejected');
await rejects(() => be.updateCapacity(central, 'h_central', { availableIcuBeds: 2 }, false), '422', 'update requires confirmation');
await be.updateCapacity(central, 'h_central', { availableIcuBeds: 2 }, true);
ok(be.getSnapshot(central).resourceStatus.h_central.availableIcuBeds === 2, 'valid capacity update applied');
ok(be.getSnapshot(disp).resourceStatus.h_central.freshness === 'LIVE', 'updated hospital is LIVE');
ok(be.getSnapshot(disp).resourceStatus.h_south.freshness === 'STALE', 'South remains STALE');
clock.advance(20 * 60_000);
ok(be.getSnapshot(disp).resourceStatus.h_central.freshness === 'STALE', 'LIVE data becomes STALE after 20 min');
be.confirmAvailability(central, 'h_central');
ok(be.getSnapshot(disp).resourceStatus.h_central.freshness === 'LIVE', 'Confirm current availability restores LIVE');
// GPS loss on seeded en-route ambulance AMB-002
ok(be.demoToggleSignalLoss(disp, 'a_002') === true, 'GPS loss simulated for AMB-002');
for (let i = 0; i < 3; i++) { await be.system.tick(6); clock.advance(50_000); await be.system.housekeeping(); }
const a2 = be.getSnapshot(disp).ambulances.find((a) => a.id === 'a_002')!;
ok(a2.gpsFreshness === 'LOST', `AMB-002 GPS marked LOST (${a2.gpsAgeSeconds}s old)`);
ok(be.getSnapshot(disp).notifications.some((n) => n.type === 'GPS_LOST' && n.message.includes('AMB-002')), 'dispatcher notified of GPS loss');
await rejects(() => be.updateLocation(crew1, 'a_001', { lat: 12.97, lng: 77.59 }), 'SHARING_OFF', 'location update refused when sharing is off');

console.log('\n[7] Validation & privacy');
await rejects(() => be.createIncident(disp, { emergencyType: 'TRAUMA', severity: 'LOW', patientAgeGroup: 'ADULT', requiredResources: [], requiredSpecialty: null, pickup: { method: 'CALLER_SHARED', lat: 12.95, lng: 77.58, consent: false }, notes: '' }), '422', 'caller-shared location requires consent');
await rejects(() => be.createIncident(disp, { emergencyType: 'TRAUMA', severity: 'LOW', patientAgeGroup: 'ADULT', requiredResources: [], requiredSpecialty: null, pickup: { method: 'MAP_PIN', lat: 12.95, lng: 77.58 }, notes: 'call 9876543210 patient John' }), '422', 'phone numbers in notes rejected');
const cs2 = await be.createIncident(disp, { emergencyType: 'OTHER', severity: 'LOW', patientAgeGroup: 'UNKNOWN', requiredResources: ['ER_BED'], requiredSpecialty: null, pickup: { method: 'CALLER_SHARED', lat: 12.95123, lng: 77.58456, consent: true }, notes: '' });
be.closeIncident(disp, cs2.id, { cancel: true, reason: 'test' });
const closed = be.getSnapshot(disp).incidents.find((i) => i.id === cs2.id)!;
ok(closed.pickupPrecisionReduced && closed.pickupLat === 12.95, 'caller-shared location precision reduced after closure');
ok(Object.isFrozen(be.getIncidentDetail(disp, created.id).timeline[0]), 'timeline events are immutable');
let sessionExpired = false;
clock.advance(31 * 60_000);
try { be.getSnapshot(disp); } catch (e) { sessionExpired = e instanceof ApiError && e.code === 'SESSION_EXPIRED'; }
ok(sessionExpired, 'idle session expires after 30 min');
let limited = false;
const t2 = be.demoLogin('DISPATCHER').session.token;
try { for (let i = 0; i < 1000; i++) be.getSnapshot(t2); } catch (e) { limited = e instanceof ApiError && e.status === 429; }
ok(limited, 'rate limiting returns 429');
await rejects(() => { for (let i = 0; i < 6; i++) { try { be.login('dispatcher@demo.rapidcare.test', 'wrong-password'); } catch (e) { if (i === 5) throw e; } } }, '429', 'login attempts are rate limited');

console.log(`\n${pass} passed, ${fail} failed`);
void hospNames;
process.exit(fail ? 1 : 0);
