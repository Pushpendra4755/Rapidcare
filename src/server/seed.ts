import { deriveCapabilities } from '../lib/engine';
import { bearingDeg, pointAlong } from '../lib/geo';
import { MockRoutingProvider } from '../lib/routing';
import type {
  Ambulance, AppNotification, Capability, EmergencyCategory, EmergencyType, Hospital, HospitalRequest, Incident,
  LocationPoint, ResourceKey, ServiceArea, Severity, TimelineEvent, TimelineType,
} from '../lib/types';
import { PREP_ITEMS } from '../lib/types';
import { sha256Hex, iso } from './core';
import { DEFAULT_CONFIG, type ActiveRoute, type Db, type StoredAmbulance, type StoredStatus, type StoredUser } from './db';

export const DEMO_PASSWORD = 'rapidcare-demo';
export const DEMO_DOMAIN = 'demo.rapidcare.test';

const HOSP = {
  central: 'h_central', north: 'h_north', east: 'h_east', west: 'h_west', south: 'h_south',
} as const;

function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SERVICE_AREAS: ServiceArea[] = [
  { id: 'z_central', name: 'Central Zone', bounds: [12.935, 77.56, 13.005, 77.63], neighbors: ['z_north', 'z_south', 'z_east', 'z_west'] },
  { id: 'z_north', name: 'North Zone', bounds: [13.005, 77.54, 13.08, 77.65], neighbors: ['z_central', 'z_east', 'z_west'] },
  { id: 'z_south', name: 'South Zone', bounds: [12.86, 77.54, 12.935, 77.65], neighbors: ['z_central', 'z_east', 'z_west'] },
  { id: 'z_east', name: 'East Zone', bounds: [12.935, 77.63, 13.005, 77.72], neighbors: ['z_central', 'z_north', 'z_south'] },
  { id: 'z_west', name: 'West Zone', bounds: [12.935, 77.47, 13.005, 77.56], neighbors: ['z_central', 'z_north', 'z_south'] },
];

export const CATEGORIES: EmergencyCategory[] = [
  { id: 'TRAUMA', label: 'Trauma', defaultCapabilities: ['TRAUMA'], defaultResources: ['TRAUMA_BAY', 'ER_BED'], active: true },
  { id: 'CARDIAC', label: 'Cardiac', defaultCapabilities: ['CARDIAC'], defaultResources: ['CATH_LAB', 'ICU_BED'], active: true },
  { id: 'STROKE', label: 'Stroke', defaultCapabilities: ['STROKE'], defaultResources: ['STROKE_UNIT', 'ER_BED'], active: true },
  { id: 'RESPIRATORY', label: 'Respiratory', defaultCapabilities: [], defaultResources: ['ER_BED', 'VENTILATOR'], active: true },
  { id: 'BURN', label: 'Burn', defaultCapabilities: ['BURN'], defaultResources: ['ER_BED'], active: true },
  { id: 'PEDIATRIC', label: 'Pediatric', defaultCapabilities: ['PEDIATRIC'], defaultResources: ['ER_BED'], active: true },
  { id: 'OBSTETRIC', label: 'Obstetric', defaultCapabilities: ['OBSTETRIC'], defaultResources: ['ER_BED'], active: true },
  { id: 'POISONING', label: 'Poisoning', defaultCapabilities: [], defaultResources: ['ER_BED'], active: true },
  { id: 'OTHER', label: 'Other', defaultCapabilities: [], defaultResources: ['ER_BED'], active: true },
];

/** Small demo gazetteer so "Enter address" works offline. Real deployments plug in a geocoder. */
export const GAZETTEER: { name: string; lat: number; lng: number }[] = [
  { name: 'Demo Junction, West Zone', lat: 12.969, lng: 77.533 },
  { name: 'Riverside Market, Central Zone', lat: 12.955, lng: 77.596 },
  { name: 'Lakeview Apartments, East Zone', lat: 12.974, lng: 77.615 },
  { name: 'Northgate Bus Depot, North Zone', lat: 13.012, lng: 77.601 },
  { name: 'Southpark Stadium, South Zone', lat: 12.915, lng: 77.585 },
  { name: 'Tech Park Gate 2, East Zone', lat: 12.99, lng: 77.69 },
  { name: 'Old Fort Road, Central Zone', lat: 12.985, lng: 77.575 },
  { name: 'Greenfield School, North Zone', lat: 13.04, lng: 77.57 },
  { name: 'Harbour Road Crossing, West Zone', lat: 12.955, lng: 77.49 },
  { name: 'Metro Station Plaza, Central Zone', lat: 12.9716, lng: 77.6101 },
];

export function zoneOf(p: { lat: number; lng: number }): string | null {
  for (const a of SERVICE_AREAS) {
    if (p.lat >= a.bounds[0] && p.lat <= a.bounds[2] && p.lng >= a.bounds[1] && p.lng <= a.bounds[3]) return a.id;
  }
  return null;
}

type CapSet = Capability[];
const caps = (list: CapSet): Record<Capability, boolean> => ({
  TRAUMA: list.includes('TRAUMA'), CARDIAC: list.includes('CARDIAC'), STROKE: list.includes('STROKE'),
  PEDIATRIC: list.includes('PEDIATRIC'), BURN: list.includes('BURN'), OBSTETRIC: list.includes('OBSTETRIC'),
  NEONATAL: list.includes('NEONATAL'),
});

export function buildSeed(now: number, routing: MockRoutingProvider = new MockRoutingProvider()): Db {
  const ts = (msAgo: number) => iso(now - msAgo);
  const min = 60_000;
  const rand = mulberry32(20261011);

  // ---------------------------------------------------------------- hospitals
  const hospitals: Hospital[] = [
    {
      id: HOSP.central, name: 'Central Trauma & ICU Hospital', address: '1 Central Avenue, Central Zone',
      lat: 12.9716, lng: 77.5946, entranceLat: 12.9722, entranceLng: 77.5951,
      phone: '+00 555 0101', emergencyContact: '+00 555 0111', status: 'ONLINE', regionId: 'z_central',
      totalErBeds: 8, totalIcuBeds: 6, totalVentilators: 8, totalTraumaBays: 3, totalIsolationBeds: 2,
      capabilities: caps(['TRAUMA', 'CARDIAC']), createdAt: ts(90 * 86400000), updatedAt: ts(min),
    },
    {
      id: HOSP.north, name: 'North City General Hospital', address: '48 Northern Ring Road, North Zone',
      lat: 13.0316, lng: 77.595, entranceLat: 13.0311, entranceLng: 77.5954,
      phone: '+00 555 0102', emergencyContact: '+00 555 0112', status: 'ONLINE', regionId: 'z_north',
      totalErBeds: 10, totalIcuBeds: 5, totalVentilators: 6, totalTraumaBays: 0, totalIsolationBeds: 3,
      capabilities: caps(['PEDIATRIC']), createdAt: ts(90 * 86400000), updatedAt: ts(9 * min),
    },
    {
      id: HOSP.east, name: 'East Stroke Care Center', address: '12 Lakeside Boulevard, East Zone',
      lat: 12.976, lng: 77.662, entranceLat: 12.9764, entranceLng: 77.6613,
      phone: '+00 555 0103', emergencyContact: '+00 555 0113', status: 'ONLINE', regionId: 'z_east',
      totalErBeds: 6, totalIcuBeds: 4, totalVentilators: 4, totalTraumaBays: 0, totalIsolationBeds: 1,
      capabilities: caps(['STROKE']), createdAt: ts(90 * 86400000), updatedAt: ts(2 * min),
    },
    {
      id: HOSP.west, name: 'West Emergency Hospital', address: '7 Harbour Link Road, West Zone',
      lat: 12.968, lng: 77.518, entranceLat: 12.9684, entranceLng: 77.5186,
      phone: '+00 555 0104', emergencyContact: '+00 555 0114', status: 'ONLINE', regionId: 'z_west',
      totalErBeds: 8, totalIcuBeds: 3, totalVentilators: 3, totalTraumaBays: 2, totalIsolationBeds: 1,
      capabilities: caps(['TRAUMA']), createdAt: ts(90 * 86400000), updatedAt: ts(3 * min),
    },
    {
      id: HOSP.south, name: 'South Multispecialty Hospital', address: '90 Southern Parkway, South Zone',
      lat: 12.902, lng: 77.59, entranceLat: 12.9026, entranceLng: 77.5895,
      phone: '+00 555 0105', emergencyContact: '+00 555 0115', status: 'ONLINE', regionId: 'z_south',
      totalErBeds: 12, totalIcuBeds: 6, totalVentilators: 5, totalTraumaBays: 0, totalIsolationBeds: 2,
      capabilities: caps(['CARDIAC', 'OBSTETRIC', 'NEONATAL']), createdAt: ts(90 * 86400000), updatedAt: ts(45 * min),
    },
  ];

  const st = (
    hospitalId: string, a: [number, number, number, number, number], acceptance: StoredStatus['acceptanceStatus'],
    verifiedAgo: number, notes: string,
  ): StoredStatus => ({
    hospitalId, availableErBeds: a[0], availableIcuBeds: a[1], availableVentilators: a[2], availableTraumaBays: a[3],
    availableIsolationBeds: a[4], acceptanceStatus: acceptance, operationalNotes: notes,
    lastVerifiedAt: ts(verifiedAgo), updatedBy: 'seed', updatedAt: ts(verifiedAgo), dataSource: 'DEMO_SEED',
  });

  const resourceStatus: Record<string, StoredStatus> = {
    [HOSP.central]: st(HOSP.central, [2, 1, 2, 1, 1], 'ACCEPTING', 1 * min, 'Trauma team on site.'),
    [HOSP.north]: st(HOSP.north, [4, 0, 1, 0, 1], 'LIMITED_CAPACITY', 9 * min, 'ICU full; paediatric ER open.'),
    [HOSP.east]: st(HOSP.east, [3, 2, 2, 0, 0], 'ACCEPTING', 2 * min, 'Stroke team available.'),
    [HOSP.west]: st(HOSP.west, [0, 0, 0, 0, 0], 'DIVERTING', 3 * min, 'ED saturated — diverting all but life-threatening arrivals.'),
    [HOSP.south]: st(HOSP.south, [5, 2, 1, 0, 1], 'ACCEPTING', 45 * min, 'Last census check this morning.'),
  };

  // ---------------------------------------------------------------- ambulances
  const amb = (
    n: number, status: Ambulance['status'], lat: number, lng: number, o: Partial<StoredAmbulance> = {},
  ): StoredAmbulance => ({
    id: `a_${String(n).padStart(3, '0')}`, code: `AMB-${String(n).padStart(3, '0')}`,
    vehicleType: n === 5 ? 'NEONATAL_TRANSPORT' : n % 2 ? 'ALS' : 'BLS', status, lat, lng,
    gpsAccuracyMeters: 8, speedKmph: 0, headingDegrees: 0, lastLocationAt: ts(4_000),
    operatorName: n % 2 ? 'Metro EMS' : 'City Ambulance Trust', locationSharing: status !== 'OFFLINE', simSignalLoss: false,
    regionId: zoneOf({ lat, lng }) ?? 'z_central', createdAt: ts(60 * 86400000), updatedAt: ts(min), ...o,
  });

  const ambulances: StoredAmbulance[] = [
    amb(1, 'AVAILABLE', 12.965, 77.6),
    amb(2, 'EN_ROUTE_PICKUP', 12.99, 77.556, { speedKmph: 38 }),
    amb(3, 'EN_ROUTE_HOSPITAL', 13.012, 77.583, { speedKmph: 46 }),
    amb(4, 'OFFLINE', 12.93, 77.62, { locationSharing: false, lastLocationAt: ts(5 * 3600000), gpsAccuracyMeters: null }),
    amb(5, 'AVAILABLE', 12.945, 77.575),
  ];

  // ---------------------------------------------------------------- users
  const users: StoredUser[] = [];
  const addUser = (id: string, fullName: string, email: string, role: StoredUser['role'], hospitalId: string | null, ambulanceId: string | null) => {
    const salt = sha256Hex(`salt:${id}`).slice(0, 16);
    users.push({
      id, fullName, email, role, hospitalId, ambulanceId, active: true, createdAt: ts(60 * 86400000), updatedAt: ts(60 * 86400000),
      salt, passwordHash: sha256Hex(salt + DEMO_PASSWORD),
    });
  };
  addUser('u_admin', 'Demo Admin', `admin@${DEMO_DOMAIN}`, 'ADMIN', null, null);
  addUser('u_disp1', 'Demo Dispatcher One', `dispatcher@${DEMO_DOMAIN}`, 'DISPATCHER', null, null);
  addUser('u_disp2', 'Demo Dispatcher Two', `dispatcher2@${DEMO_DOMAIN}`, 'DISPATCHER', null, null);
  addUser('u_hosp_central', 'Demo Staff — Central', `hospital@${DEMO_DOMAIN}`, 'HOSPITAL_STAFF', HOSP.central, null);
  addUser('u_hosp_north', 'Demo Staff — North', `hospital.north@${DEMO_DOMAIN}`, 'HOSPITAL_STAFF', HOSP.north, null);
  addUser('u_hosp_east', 'Demo Staff — East', `hospital.east@${DEMO_DOMAIN}`, 'HOSPITAL_STAFF', HOSP.east, null);
  addUser('u_hosp_west', 'Demo Staff — West', `hospital.west@${DEMO_DOMAIN}`, 'HOSPITAL_STAFF', HOSP.west, null);
  addUser('u_hosp_south', 'Demo Staff — South', `hospital.south@${DEMO_DOMAIN}`, 'HOSPITAL_STAFF', HOSP.south, null);
  ambulances.forEach((a, i) => addUser(`u_crew_${i + 1}`, `Demo Crew ${a.code}`, i === 0 ? `crew@${DEMO_DOMAIN}` : `crew.${a.code.toLowerCase()}@${DEMO_DOMAIN}`, 'AMBULANCE_CREW', null, a.id));

  const db: Db = {
    users, hospitals, resourceStatus, ambulances, incidents: [], recommendations: {}, requests: [], notifications: [],
    timeline: [], etaHistory: {}, locationHistory: [], audit: [], serviceAreas: SERVICE_AREAS.map((a) => ({ ...a })),
    categories: CATEGORIES.map((c) => ({ ...c })), config: { ...DEFAULT_CONFIG, weights: { ...DEFAULT_CONFIG.weights } },
    routes: {}, seq: { inc: 1004, tl: 0, req: 0, ntf: 0, aud: 0, rec: 0, hosp: 5, amb: 5, usr: 20 },
  };

  const nextId = (k: string, prefix: string) => `${prefix}_${++db.seq[k]}`;
  const tl = (incidentId: string, at: number, type: TimelineType, actor: string, message: string, meta?: TimelineEvent['meta']) => {
    db.timeline.push(Object.freeze({ id: nextId('tl', 'tl'), incidentId, at: iso(at), type, actor, message, meta }) as TimelineEvent);
  };

  const mkIncident = (n: number, o: Partial<Incident> & Pick<Incident, 'emergencyType' | 'severity' | 'patientAgeGroup'>, specialty: Capability | null, resources: ResourceKey[], createdAgo: number): Incident => {
    const c = deriveCapabilities(o.emergencyType, o.patientAgeGroup, resources, specialty);
    const inc: Incident = {
      id: `inc_${n}`, incidentCode: `INC-2026-${n}`, pickupLat: null, pickupLng: null, pickupAddress: null,
      pickupSource: 'MAP_PIN', pickupPrecisionReduced: false, regionId: null, requiredResources: resources,
      requiredCapabilities: c.required, preArrivalNotes: '', status: 'NEW', assignedAmbulanceId: null, selectedHospitalId: null,
      destinationConfirmed: false, declinedHospitalIds: [], tripStarted: false, escalationLevel: 0, handoverConfirmed: false,
      createdBy: 'u_disp1', createdAt: ts(createdAgo), updatedAt: ts(createdAgo), closedAt: null,
      etaMinutes: null, etaDistanceKm: null, etaUpdatedAt: null, ...o,
    };
    if (inc.pickupLat != null && inc.pickupLng != null) inc.regionId = zoneOf({ lat: inc.pickupLat, lng: inc.pickupLng });
    db.incidents.push(inc);
    return inc;
  };

  // ---------------------------------------------------------------- live scenarios
  // 1) Critical trauma: nearest hospital (West) has no ICU / is diverting -> farther eligible Central.
  const i1 = mkIncident(1001, {
    emergencyType: 'TRAUMA', severity: 'CRITICAL', patientAgeGroup: 'ADULT', pickupLat: 12.969, pickupLng: 77.533,
    pickupAddress: 'Demo Junction, West Zone', status: 'EN_ROUTE_PICKUP', assignedAmbulanceId: 'a_002', tripStarted: true,
    preArrivalNotes: 'Simulated multi-vehicle collision. Adult, unresponsive, bleeding controlled.',
  }, null, ['TRAUMA_BAY', 'ICU_BED'], 7 * min);
  tl(i1.id, now - 7 * min, 'INCIDENT_CREATED', 'Demo Dispatcher One', 'Critical trauma incident created.');
  tl(i1.id, now - 7 * min + 20_000, 'PICKUP_ADDED', 'Demo Dispatcher One', 'Pickup location added by map pin.');
  tl(i1.id, now - 6 * min, 'AMBULANCE_ASSIGNED', 'Demo Dispatcher One', 'AMB-002 assigned.');
  tl(i1.id, now - 5 * min, 'TRIP_STARTED', 'Demo Crew AMB-002', 'Crew started emergency trip; location sharing on.');
  tl(i1.id, now - 5 * min + 5_000, 'AMBULANCE_DEPARTED', 'Demo Crew AMB-002', 'Ambulance en route to pickup.');

  // 2) Suspected stroke, unassigned: must prefer stroke-capable East.
  const i2 = mkIncident(1002, {
    emergencyType: 'STROKE', severity: 'HIGH', patientAgeGroup: 'ADULT', pickupLat: 12.974, pickupLng: 77.615,
    pickupAddress: 'Lakeview Apartments, East Zone', pickupSource: 'ADDRESS',
    preArrivalNotes: 'Sudden facial droop and slurred speech reported by bystander (simulated).',
  }, null, ['STROKE_UNIT', 'ICU_BED', 'ER_BED'], 3 * min);
  tl(i2.id, now - 3 * min, 'INCIDENT_CREATED', 'Demo Dispatcher Two', 'Suspected stroke incident created.');
  tl(i2.id, now - 3 * min + 15_000, 'PICKUP_ADDED', 'Demo Dispatcher Two', 'Pickup location added by address.');

  // 3) Pediatric respiratory, patient onboard, destination already accepted by North City General.
  const i3 = mkIncident(1003, {
    emergencyType: 'RESPIRATORY', severity: 'HIGH', patientAgeGroup: 'CHILD', pickupLat: 12.998, pickupLng: 77.57,
    pickupAddress: 'Old Fort Road, Central Zone', pickupSource: 'ADDRESS', status: 'EN_ROUTE_HOSPITAL',
    assignedAmbulanceId: 'a_003', selectedHospitalId: HOSP.north, destinationConfirmed: true, tripStarted: true,
    preArrivalNotes: 'Child with severe breathing difficulty, oxygen in place (simulated).',
  }, 'PEDIATRIC', ['ER_BED', 'VENTILATOR'], 16 * min);
  tl(i3.id, now - 16 * min, 'INCIDENT_CREATED', 'Demo Dispatcher One', 'Pediatric respiratory incident created.');
  tl(i3.id, now - 15 * min, 'AMBULANCE_ASSIGNED', 'Demo Dispatcher One', 'AMB-003 assigned.');
  tl(i3.id, now - 10 * min, 'PATIENT_ONBOARD', 'Demo Crew AMB-003', 'Patient onboard.');
  tl(i3.id, now - 9 * min, 'HOSPITAL_SELECTED', 'Demo Dispatcher One', 'North City General Hospital selected as recommended destination.');
  tl(i3.id, now - 9 * min + 2_000, 'ALERT_SENT', 'System', 'Incoming-case alert sent to North City General Hospital.');
  tl(i3.id, now - 8 * min, 'HOSPITAL_ACCEPTED', 'Demo Staff — North', 'North City General Hospital accepted the case.');
  tl(i3.id, now - 8 * min + 3_000, 'EN_ROUTE_HOSPITAL', 'System', 'Route set to hospital emergency entrance.');

  // 4) Cardiac, unassigned: decline demo + stale-data demo (Central first; South is stale).
  const i4 = mkIncident(1004, {
    emergencyType: 'CARDIAC', severity: 'HIGH', patientAgeGroup: 'ADULT', pickupLat: 12.955, pickupLng: 77.596,
    pickupAddress: 'Riverside Market, Central Zone', pickupSource: 'ADDRESS',
    preArrivalNotes: 'Chest pain with suspected heart attack (simulated).',
  }, null, ['CATH_LAB', 'ICU_BED'], 90_000);
  tl(i4.id, now - 90_000, 'INCIDENT_CREATED', 'Demo Dispatcher Two', 'Cardiac incident created.');
  tl(i4.id, now - 80_000, 'PICKUP_ADDED', 'Demo Dispatcher Two', 'Pickup location added by address.');

  // requests: seeded accepted request for incident 3
  const r3: HospitalRequest = {
    id: nextId('req', 'req'), incidentId: i3.id, hospitalId: HOSP.north, status: 'ACCEPTED', sentAt: ts(9 * min),
    acknowledgedAt: ts(9 * min - 20_000), respondedAt: ts(8 * min), decision: 'ACCEPT', declineReason: null,
    estimatedArrivalMinutes: 8, expiresAt: ts(8 * min), reservedResources: ['ER_BED', 'VENTILATOR'], infoRequestMessage: null,
    dispatcherReply: null, overrideReason: null, prepChecklist: Object.fromEntries(PREP_ITEMS.map((p, i) => [p, i < 2])) as HospitalRequest['prepChecklist'],
    phoneCalls: [],
  };
  db.requests.push(r3);

  // ---------------------------------------------------------------- active routes for seeded trips
  const setRoute = (inc: Incident, a: StoredAmbulance, leg: 'PICKUP' | 'HOSPITAL', dest: { lat: number; lng: number }, hospitalId: string | null, progressFraction: number) => {
    const r = routing.compute({ lat: a.lat, lng: a.lng }, dest, { severity: inc.severity, departureMs: now });
    const route: ActiveRoute = {
      incidentId: inc.id, leg, points: r.points, totalKm: r.distanceKm, progressKm: 0,
      speedKmph: (r.distanceKm / r.durationSec) * 3600, trafficLevel: r.trafficLevel, destination: dest, hospitalId, computedAt: now,
    };
    route.progressKm = r.distanceKm * progressFraction;
    db.routes[inc.id] = route;
    const p = pointAlong(route.points, route.progressKm);
    a.lat = p.point.lat; a.lng = p.point.lng; a.headingDegrees = Math.round(p.heading);
    a.speedKmph = Math.round(route.speedKmph);
    const remainingKm = Math.max(0, route.totalKm - route.progressKm);
    inc.etaMinutes = Math.max(1, Math.round((remainingKm / route.speedKmph) * 60));
    inc.etaDistanceKm = Math.round(remainingKm * 10) / 10;
    inc.etaUpdatedAt = iso(now);
  };
  setRoute(i1, ambulances[1], 'PICKUP', { lat: i1.pickupLat!, lng: i1.pickupLng! }, null, 0.25);
  setRoute(i3, ambulances[2], 'HOSPITAL', { lat: hospitals[1].entranceLat, lng: hospitals[1].entranceLng }, HOSP.north, 0.35);
  ambulances[1].regionId = zoneOf(ambulances[1]) ?? 'z_central';

  // ---------------------------------------------------------------- historical closed incidents (analytics / playback)
  const types: EmergencyType[] = ['TRAUMA', 'CARDIAC', 'STROKE', 'RESPIRATORY', 'PEDIATRIC', 'OBSTETRIC', 'BURN', 'TRAUMA', 'CARDIAC', 'POISONING'];
  const sevs: Severity[] = ['CRITICAL', 'HIGH', 'HIGH', 'MODERATE', 'HIGH', 'MODERATE', 'CRITICAL', 'HIGH', 'CRITICAL', 'LOW'];
  const hospOrder = [HOSP.central, HOSP.south, HOSP.east, HOSP.north, HOSP.north, HOSP.south, HOSP.central, HOSP.central, HOSP.south, HOSP.east];
  const resByType: Record<string, ResourceKey[]> = {
    TRAUMA: ['TRAUMA_BAY', 'ICU_BED'], CARDIAC: ['CATH_LAB', 'ICU_BED'], STROKE: ['STROKE_UNIT', 'ER_BED'], RESPIRATORY: ['ER_BED', 'VENTILATOR'],
    PEDIATRIC: ['ER_BED'], OBSTETRIC: ['ER_BED'], BURN: ['ER_BED'], POISONING: ['ER_BED'],
  };
  for (let k = 0; k < 10; k++) {
    const n = 990 - k;
    const agoH = 2 + k * 3.2;
    const created = now - agoH * 3600_000;
    const type = types[k];
    const g = GAZETTEER[k % GAZETTEER.length];
    const hid = hospOrder[k];
    const h = hospitals.find((x) => x.id === hid)!;
    const inc = mkIncident(n, {
      emergencyType: type, severity: sevs[k], patientAgeGroup: type === 'PEDIATRIC' ? 'CHILD' : type === 'OBSTETRIC' ? 'ADULT' : 'ADULT',
      pickupLat: g.lat, pickupLng: g.lng, pickupAddress: g.name, pickupSource: 'ADDRESS', status: 'CLOSED',
      assignedAmbulanceId: ambulances[k % 3].id, selectedHospitalId: hid, destinationConfirmed: true, tripStarted: true,
      handoverConfirmed: true, closedAt: iso(created + 52 * min), createdAt: iso(created), updatedAt: iso(created + 52 * min),
      preArrivalNotes: 'Simulated historical case.', pickupPrecisionReduced: false,
    }, null, resByType[type] ?? ['ER_BED'], agoH * 3600_000);
    inc.createdAt = iso(created);
    const declinedFirst = k % 4 === 1;
    const ackSec = 12 + Math.round(rand() * 25);
    const t = (m: number) => created + m * min;
    tl(inc.id, t(0), 'INCIDENT_CREATED', 'Demo Dispatcher One', `${type} incident created.`);
    tl(inc.id, t(1), 'AMBULANCE_ASSIGNED', 'Demo Dispatcher One', `${ambulances[k % 3].code} assigned.`);
    tl(inc.id, t(11 + k % 3), 'ARRIVED_PICKUP', 'System', 'Ambulance arrived at pickup.');
    tl(inc.id, t(18), 'PATIENT_ONBOARD', 'Demo Crew', 'Patient onboard.');
    tl(inc.id, t(19), 'HOSPITAL_SELECTED', 'Demo Dispatcher One', `${h.name} selected.`);
    tl(inc.id, t(19) + 2000, 'ALERT_SENT', 'System', `Incoming-case alert sent to ${h.name}.`);
    if (declinedFirst) {
      const other = hospitals.find((x) => x.id !== hid && x.id !== HOSP.west)!;
      inc.declinedHospitalIds.push(other.id);
      db.requests.push({
        id: nextId('req', 'req'), incidentId: inc.id, hospitalId: other.id, status: 'DECLINED', sentAt: iso(t(17)), acknowledgedAt: iso(t(17) + ackSec * 1000),
        respondedAt: iso(t(17) + (ackSec + 30) * 1000), decision: 'DECLINE', declineReason: 'No ICU bed available', estimatedArrivalMinutes: 14,
        expiresAt: iso(t(18)), reservedResources: [], infoRequestMessage: null, dispatcherReply: null, overrideReason: null,
        prepChecklist: { ER_TEAM_ALERTED: false, BED_CONFIRMED: false, SPECIALIST_ALERTED: false, EQUIPMENT_READY: false }, phoneCalls: [],
      });
      tl(inc.id, t(18), 'HOSPITAL_DECLINED', `Staff — ${other.name}`, `${other.name} declined: No ICU bed available.`);
    }
    db.requests.push({
      id: nextId('req', 'req'), incidentId: inc.id, hospitalId: hid, status: 'ACCEPTED', sentAt: iso(t(19)), acknowledgedAt: iso(t(19) + ackSec * 1000),
      respondedAt: iso(t(19) + (ackSec + 25) * 1000), decision: 'ACCEPT', declineReason: null, estimatedArrivalMinutes: 15,
      expiresAt: iso(t(20)), reservedResources: resByType[type] ?? ['ER_BED'], infoRequestMessage: null, dispatcherReply: null, overrideReason: null,
      prepChecklist: { ER_TEAM_ALERTED: true, BED_CONFIRMED: true, SPECIALIST_ALERTED: true, EQUIPMENT_READY: true }, phoneCalls: [],
    });
    tl(inc.id, t(19) + (ackSec + 25) * 1000, 'HOSPITAL_ACCEPTED', `Staff — ${h.name}`, `${h.name} accepted the case.`);
    tl(inc.id, t(36), 'AMBULANCE_ARRIVED', 'System', `Ambulance arrived at ${h.name}.`);
    tl(inc.id, t(41), 'HANDOVER_COMPLETED', `Staff — ${h.name}`, 'Patient handover confirmed.');
    tl(inc.id, t(52), 'INCIDENT_CLOSED', 'Demo Dispatcher One', 'Incident closed.');

    // The newest closed incident keeps full GPS + ETA history so the playback page has something to replay.
    if (k === 0) {
      const from = { lat: 12.975, lng: 77.55 };
      const leg1 = routing.compute(from, { lat: g.lat, lng: g.lng }, { severity: inc.severity, departureMs: created });
      const leg2 = routing.compute({ lat: g.lat, lng: g.lng }, { lat: h.entranceLat, lng: h.entranceLng }, { severity: inc.severity, departureMs: created });
      const hist: LocationPoint[] = [];
      const eta: { at: string; etaMinutes: number; distanceKm: number; leg: 'PICKUP' | 'HOSPITAL' }[] = [];
      const push = (route: typeof leg1, startMin: number, endMin: number, leg: 'PICKUP' | 'HOSPITAL') => {
        const steps = Math.max(6, Math.round(((endMin - startMin) * 60) / 20));
        for (let s = 0; s <= steps; s++) {
          const f = s / steps;
          const p = pointAlong(route.points, route.distanceKm * f);
          const at = created + (startMin + (endMin - startMin) * f) * min;
          hist.push({ ambulanceId: inc.assignedAmbulanceId!, incidentId: inc.id, lat: p.point.lat, lng: p.point.lng, accuracyMeters: 8, speedKmph: 42, headingDegrees: Math.round(p.heading), recordedAt: iso(at) });
          if (s % 3 === 0) eta.push({ at: iso(at), etaMinutes: Math.max(0, Math.round((endMin - startMin) * (1 - f))), distanceKm: Math.round(route.distanceKm * (1 - f) * 10) / 10, leg });
        }
      };
      push(leg1, 2, 12, 'PICKUP');
      push(leg2, 19, 36, 'HOSPITAL');
      db.locationHistory.push(...hist);
      db.etaHistory[inc.id] = eta.map((e) => ({ ...e }));
      void bearingDeg;
    }
  }

  // a couple of unacknowledged-style notifications so the dashboard is not empty on first load
  const addNtf = (o: Partial<AppNotification> & Pick<AppNotification, 'type' | 'title' | 'message'>) => {
    db.notifications.push({
      id: nextId('ntf', 'ntf'), recipientUserId: null, recipientHospitalId: null, recipientAmbulanceId: null, recipientRole: 'DISPATCHER',
      incidentId: null, severity: 'INFO', requiresAck: false, status: 'SENT', sentAt: iso(now - 2 * min), readAt: null, acknowledgedAt: null, ...o,
    });
  };
  addNtf({ type: 'NEW_EMERGENCY', title: 'New emergency created', message: 'Critical trauma incident INC-2026-1001 awaiting hospital destination.', incidentId: i1.id, severity: 'CRITICAL', requiresAck: true, sentAt: iso(now - 7 * min) });
  addNtf({ type: 'NEW_EMERGENCY', title: 'New emergency created', message: 'Suspected stroke incident INC-2026-1002 has no ambulance assigned.', incidentId: i2.id, severity: 'WARNING', requiresAck: true, sentAt: iso(now - 3 * min) });
  addNtf({ type: 'CAPACITY_STALE', title: 'Capacity data is stale', message: 'Hospital capacity data has not been verified for 30 minutes. South Multispecialty Hospital — verify by phone.', severity: 'WARNING', requiresAck: true, sentAt: iso(now - 30 * min) });

  return db;
}
