// RapidCare domain types. Mirrors the relational model in supabase/schema.sql.

export type Role = 'ADMIN' | 'DISPATCHER' | 'HOSPITAL_STAFF' | 'AMBULANCE_CREW';

export const SEVERITIES = ['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const EMERGENCY_TYPES = [
  'TRAUMA', 'CARDIAC', 'STROKE', 'RESPIRATORY', 'BURN', 'PEDIATRIC', 'OBSTETRIC', 'POISONING', 'OTHER',
] as const;
export type EmergencyType = (typeof EMERGENCY_TYPES)[number];

export const AGE_GROUPS = ['ADULT', 'CHILD', 'NEONATAL', 'UNKNOWN'] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

/** Resources a dispatcher can require. The first five are counted by hospitals; the rest are service-backed. */
export const RESOURCES = [
  'ER_BED', 'ICU_BED', 'VENTILATOR', 'TRAUMA_BAY', 'OPERATING_THEATRE',
  'CATH_LAB', 'STROKE_UNIT', 'NEONATAL_ICU', 'ISOLATION_BED',
] as const;
export type ResourceKey = (typeof RESOURCES)[number];

export const COUNTED_RESOURCES = ['ER_BED', 'ICU_BED', 'VENTILATOR', 'TRAUMA_BAY', 'ISOLATION_BED'] as const;
export type CountedResource = (typeof COUNTED_RESOURCES)[number];

export const CAPABILITIES = ['TRAUMA', 'CARDIAC', 'STROKE', 'PEDIATRIC', 'BURN', 'OBSTETRIC', 'NEONATAL'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ACCEPTANCE_STATUSES = ['ACCEPTING', 'LIMITED_CAPACITY', 'DIVERTING', 'UNAVAILABLE'] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

export type HospitalFreshness = 'LIVE' | 'RECENT' | 'STALE' | 'UNAVAILABLE';
export type GpsFreshness = 'LIVE' | 'STALE' | 'LOST' | 'NONE';

export type AmbulanceStatus =
  | 'OFFLINE' | 'AVAILABLE' | 'ASSIGNED' | 'EN_ROUTE_PICKUP' | 'AT_PICKUP'
  | 'PATIENT_ONBOARD' | 'EN_ROUTE_HOSPITAL' | 'AT_HOSPITAL';

export type IncidentStatus =
  | 'NEW' | 'AMBULANCE_ASSIGNED' | 'EN_ROUTE_PICKUP' | 'AT_PICKUP' | 'PATIENT_ONBOARD'
  | 'EN_ROUTE_HOSPITAL' | 'ARRIVED' | 'HANDED_OVER' | 'CLOSED' | 'CANCELLED';

export const ACTIVE_INCIDENT_STATUSES: IncidentStatus[] = [
  'NEW', 'AMBULANCE_ASSIGNED', 'EN_ROUTE_PICKUP', 'AT_PICKUP', 'PATIENT_ONBOARD',
  'EN_ROUTE_HOSPITAL', 'ARRIVED', 'HANDED_OVER',
];

export type PickupSource = 'ADDRESS' | 'MAP_PIN' | 'CALLER_SHARED';

export interface LatLng { lat: number; lng: number }

export interface User {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  hospitalId: string | null;
  ambulanceId: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Hospital {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  entranceLat: number;
  entranceLng: number;
  phone: string;
  emergencyContact: string; // operational fallback contact number
  status: 'ONLINE' | 'OFFLINE';
  regionId: string;
  totalErBeds: number;
  totalIcuBeds: number;
  totalVentilators: number;
  totalTraumaBays: number;
  totalIsolationBeds: number;
  capabilities: Record<Capability, boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface HospitalResourceStatus {
  hospitalId: string;
  availableErBeds: number;
  availableIcuBeds: number;
  availableVentilators: number;
  availableTraumaBays: number;
  availableIsolationBeds: number;
  acceptanceStatus: AcceptanceStatus;
  operationalNotes: string;
  lastVerifiedAt: string | null;
  updatedBy: string;
  updatedAt: string;
  dataSource: 'HOSPITAL_STAFF' | 'DEMO_SEED' | 'DEMO_SIM' | 'PHONE_CONFIRMED';
  /** Derived at read time from lastVerifiedAt. Never stored as truth. */
  freshness: HospitalFreshness;
  ageMinutes: number | null;
}

export interface Ambulance {
  id: string;
  code: string;
  vehicleType: 'ALS' | 'BLS' | 'NEONATAL_TRANSPORT';
  status: AmbulanceStatus;
  lat: number;
  lng: number;
  gpsAccuracyMeters: number | null;
  speedKmph: number;
  headingDegrees: number;
  lastLocationAt: string | null;
  operatorName: string;
  locationSharing: boolean;
  /** Demo only: simulates network/GPS loss. */
  simSignalLoss: boolean;
  regionId: string;
  createdAt: string;
  updatedAt: string;
  /** Derived at read time. */
  gpsFreshness: GpsFreshness;
  gpsAgeSeconds: number | null;
}

export interface Incident {
  id: string;
  incidentCode: string;
  emergencyType: EmergencyType;
  severity: Severity;
  patientAgeGroup: AgeGroup;
  pickupLat: number | null;
  pickupLng: number | null;
  pickupAddress: string | null;
  pickupSource: PickupSource;
  pickupPrecisionReduced: boolean;
  regionId: string | null;
  requiredResources: ResourceKey[];
  requiredCapabilities: Capability[];
  preArrivalNotes: string;
  status: IncidentStatus;
  assignedAmbulanceId: string | null;
  selectedHospitalId: string | null;
  destinationConfirmed: boolean;
  declinedHospitalIds: string[];
  tripStarted: boolean;
  escalationLevel: number;
  handoverConfirmed: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Derived: current ETA (minutes) of the active leg and to destination. */
  etaMinutes: number | null;
  etaDistanceKm: number | null;
  etaUpdatedAt: string | null;
}

export type RecommendationLabel =
  | 'BEST_MATCH' | 'ELIGIBLE_ALTERNATIVE' | 'LIMITED_CAPACITY' | 'NOT_ELIGIBLE' | 'STALE_VERIFY';

export interface HospitalRecommendation {
  id: string;
  incidentId: string;
  hospitalId: string;
  eligible: boolean;
  label: RecommendationLabel;
  ineligibilityReasons: string[];
  warnings: string[];
  reasons: string[];
  summary: string;
  distanceKm: number | null;
  etaMinutes: number | null;
  resourceMatchScore: number;
  specialtyMatchScore: number;
  etaScore: number;
  freshnessScore: number;
  workloadScore: number;
  finalScore: number;
  rank: number | null;
  freshness: HospitalFreshness;
  capacityAgeMinutes: number | null;
  generatedAt: string;
}

export type RequestStatus =
  | 'PENDING' | 'INFO_REQUESTED' | 'ACCEPTED' | 'DECLINED' | 'NO_RESPONSE' | 'CANCELLED' | 'ESCALATED';

export interface HospitalRequest {
  id: string;
  incidentId: string;
  hospitalId: string;
  status: RequestStatus;
  sentAt: string;
  acknowledgedAt: string | null;
  respondedAt: string | null;
  decision: 'ACCEPT' | 'DECLINE' | 'PHONE_ACCEPT' | 'PHONE_DECLINE' | null;
  declineReason: string | null;
  estimatedArrivalMinutes: number | null;
  expiresAt: string;
  reservedResources: ResourceKey[];
  infoRequestMessage: string | null;
  dispatcherReply: string | null;
  overrideReason: string | null;
  prepChecklist: Record<PrepItem, boolean>;
  phoneCalls: { at: string; by: string; outcome: string; note: string }[];
}

export const PREP_ITEMS = ['ER_TEAM_ALERTED', 'BED_CONFIRMED', 'SPECIALIST_ALERTED', 'EQUIPMENT_READY'] as const;
export type PrepItem = (typeof PREP_ITEMS)[number];

export type NotificationType =
  | 'NEW_EMERGENCY' | 'AMBULANCE_ASSIGNED' | 'HOSPITAL_REQUEST_SENT' | 'HOSPITAL_NO_RESPONSE'
  | 'HOSPITAL_ACCEPTED' | 'HOSPITAL_DECLINED' | 'HOSPITAL_INFO_REQUEST' | 'PATIENT_ONBOARD'
  | 'ETA_UPDATED' | 'AMBULANCE_ARRIVED' | 'CAPACITY_STALE' | 'HOSPITAL_DIVERTING'
  | 'GPS_LOST' | 'CRITICAL_ESCALATION' | 'REASSIGNED' | 'INFO';

export interface AppNotification {
  id: string;
  recipientUserId: string | null;
  recipientHospitalId: string | null;
  recipientAmbulanceId: string | null;
  recipientRole: Role | null;
  incidentId: string | null;
  type: NotificationType;
  title: string;
  message: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  requiresAck: boolean;
  status: 'SENT' | 'READ' | 'ACKNOWLEDGED';
  sentAt: string;
  readAt: string | null;
  acknowledgedAt: string | null;
}

export type TimelineType =
  | 'INCIDENT_CREATED' | 'PICKUP_ADDED' | 'AMBULANCE_ASSIGNED' | 'AMBULANCE_REASSIGNED' | 'RECOMMENDATIONS_GENERATED'
  | 'HOSPITAL_SELECTED' | 'ALERT_SENT' | 'HOSPITAL_ACKNOWLEDGED' | 'HOSPITAL_ACCEPTED' | 'HOSPITAL_DECLINED'
  | 'HOSPITAL_INFO_REQUESTED' | 'DISPATCHER_REPLY' | 'HOSPITAL_NO_RESPONSE' | 'PHONE_CALL' | 'OVERRIDE'
  | 'ESCALATED' | 'TRIP_STARTED' | 'AMBULANCE_DEPARTED' | 'ARRIVED_PICKUP' | 'PATIENT_ONBOARD'
  | 'EN_ROUTE_HOSPITAL' | 'ETA_UPDATED' | 'GPS_LOST' | 'GPS_RESTORED' | 'AMBULANCE_ARRIVED'
  | 'HANDOVER_COMPLETED' | 'INCIDENT_CLOSED' | 'INCIDENT_CANCELLED' | 'NOTE';

export interface TimelineEvent {
  readonly id: string;
  readonly incidentId: string;
  readonly at: string;
  readonly type: TimelineType;
  readonly actor: string;
  readonly message: string;
  readonly meta?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface EtaPoint { at: string; etaMinutes: number; distanceKm: number; leg: 'PICKUP' | 'HOSPITAL' }

export interface LocationPoint {
  ambulanceId: string;
  incidentId: string | null;
  lat: number;
  lng: number;
  accuracyMeters: number | null;
  speedKmph: number;
  headingDegrees: number;
  recordedAt: string;
}

export interface Route {
  points: LatLng[];
  distanceKm: number;
  durationSec: number;
  trafficLevel: 'LIGHT' | 'MODERATE' | 'HEAVY';
  provider: string;
}

export interface AuditLog {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly actorLabel: string;
  readonly actionType: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly previousValue: unknown;
  readonly newValue: unknown;
  readonly createdAt: string;
}

export interface ServiceArea {
  id: string;
  name: string;
  /** [south, west, north, east] */
  bounds: [number, number, number, number];
  neighbors: string[];
}

export interface EmergencyCategory {
  id: EmergencyType;
  label: string;
  defaultCapabilities: Capability[];
  defaultResources: ResourceKey[];
  active: boolean;
}

export interface SystemConfig {
  weights: { resource: number; specialty: number; eta: number; freshness: number; workload: number };
  etaCapMinutes: number;
  liveMinutes: number;
  recentMinutes: number;
  ineligibleAfterMinutes: number;
  staleMultiplier: number;
  limitedMultiplier: number;
  restrictToServiceArea: boolean;
  ackTimeoutSec: number;
  decisionTimeoutSec: number;
  gpsStaleSec: number;
  gpsLostSec: number;
  escalateCriticalAfterSec: number;
  notifyAdminsOnEscalation: boolean;
  simCompression: number;
  sessionIdleMinutes: number;
}

export interface Session {
  token: string;
  userId: string;
  role: Role;
  expiresAt: number;
}
