import type {
  AcceptanceStatus, AgeGroup, AmbulanceStatus, Capability, EmergencyType, IncidentStatus, RequestStatus,
  ResourceKey, Severity,
} from './types';

export const DISCLAIMER =
  'Demo decision-support platform. Recommendations must be reviewed by authorized emergency and clinical personnel.';

export const RESOURCE_LABEL: Record<ResourceKey, string> = {
  ER_BED: 'ER bed',
  ICU_BED: 'ICU bed',
  VENTILATOR: 'Ventilator',
  TRAUMA_BAY: 'Trauma bay',
  OPERATING_THEATRE: 'Operating theatre',
  CATH_LAB: 'Cardiac cath lab',
  STROKE_UNIT: 'Stroke unit',
  NEONATAL_ICU: 'Neonatal ICU',
  ISOLATION_BED: 'Isolation bed',
};

export const RESOURCE_PLURAL: Record<ResourceKey, string> = {
  ER_BED: 'ER beds', ICU_BED: 'ICU beds', VENTILATOR: 'ventilators', TRAUMA_BAY: 'trauma bays',
  OPERATING_THEATRE: 'operating theatres', CATH_LAB: 'cath labs', STROKE_UNIT: 'stroke unit beds',
  NEONATAL_ICU: 'neonatal ICU beds', ISOLATION_BED: 'isolation beds',
};

/** Short phrase used inside recommendation summaries ("best match for trauma + ICU"). */
export const RESOURCE_SHORT: Record<ResourceKey, string> = {
  ER_BED: 'ER bed',
  ICU_BED: 'ICU',
  VENTILATOR: 'ventilator',
  TRAUMA_BAY: 'trauma bay',
  OPERATING_THEATRE: 'operating theatre',
  CATH_LAB: 'cath lab',
  STROKE_UNIT: 'stroke unit',
  NEONATAL_ICU: 'neonatal ICU',
  ISOLATION_BED: 'isolation bed',
};

export const CAPABILITY_LABEL: Record<Capability, string> = {
  TRAUMA: 'Trauma', CARDIAC: 'Cardiac', STROKE: 'Stroke', PEDIATRIC: 'Pediatric',
  BURN: 'Burn', OBSTETRIC: 'Obstetric', NEONATAL: 'Neonatal',
};

export const EMERGENCY_LABEL: Record<EmergencyType, string> = {
  TRAUMA: 'Trauma', CARDIAC: 'Cardiac', STROKE: 'Stroke', RESPIRATORY: 'Respiratory', BURN: 'Burn',
  PEDIATRIC: 'Pediatric', OBSTETRIC: 'Obstetric', POISONING: 'Poisoning', OTHER: 'Other',
};

export const SEVERITY_LABEL: Record<Severity, string> = { LOW: 'Low', MODERATE: 'Moderate', HIGH: 'High', CRITICAL: 'Critical' };
export const SEVERITY_RANK: Record<Severity, number> = { LOW: 1, MODERATE: 2, HIGH: 3, CRITICAL: 4 };
export const SEVERITY_ICON: Record<Severity, string> = { LOW: '●', MODERATE: '▲', HIGH: '◆', CRITICAL: '⬣' };

export const AGE_LABEL: Record<AgeGroup, string> = { ADULT: 'Adult', CHILD: 'Child', NEONATAL: 'Neonatal', UNKNOWN: 'Unknown' };

export const ACCEPTANCE_LABEL: Record<AcceptanceStatus, string> = {
  ACCEPTING: 'Accepting', LIMITED_CAPACITY: 'Limited capacity', DIVERTING: 'Diverting', UNAVAILABLE: 'Unavailable',
};

export const AMBULANCE_STATUS_LABEL: Record<AmbulanceStatus, string> = {
  OFFLINE: 'Offline', AVAILABLE: 'Available', ASSIGNED: 'Assigned', EN_ROUTE_PICKUP: 'En route to pickup',
  AT_PICKUP: 'At pickup', PATIENT_ONBOARD: 'Patient onboard', EN_ROUTE_HOSPITAL: 'En route to hospital',
  AT_HOSPITAL: 'At hospital',
};

export const INCIDENT_STATUS_LABEL: Record<IncidentStatus, string> = {
  NEW: 'New — unassigned', AMBULANCE_ASSIGNED: 'Ambulance assigned', EN_ROUTE_PICKUP: 'En route to pickup',
  AT_PICKUP: 'At pickup', PATIENT_ONBOARD: 'Patient onboard', EN_ROUTE_HOSPITAL: 'En route to hospital',
  ARRIVED: 'Arrived at hospital', HANDED_OVER: 'Handover complete', CLOSED: 'Closed', CANCELLED: 'Cancelled',
};

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  PENDING: 'Awaiting hospital response', INFO_REQUESTED: 'Hospital asked for more info', ACCEPTED: 'Accepted by hospital',
  DECLINED: 'Declined', NO_RESPONSE: 'No response', CANCELLED: 'Cancelled', ESCALATED: 'Escalated to another hospital',
};

export const DECLINE_REASONS = [
  'No ICU bed available',
  'Trauma team unavailable',
  'Specialist unavailable',
  'Emergency department at capacity',
  'Equipment unavailable',
  'Diverting — internal incident',
  'Other (see note)',
];

export const OVERRIDE_REASONS = [
  'Hospital confirmed capacity by phone',
  'Closer facility for unstable patient',
  'Specialist confirmed available by phone',
  'Patient condition changed',
  'Receiving hospital requested this patient',
  'Other (specify)',
];

export const CALL_OUTCOMES = ['ACCEPTED', 'DECLINED', 'NO_ANSWER', 'CALL_BACK_LATER'] as const;

export const PREP_LABEL: Record<string, string> = {
  ER_TEAM_ALERTED: 'ER team alerted',
  BED_CONFIRMED: 'Bed confirmed',
  SPECIALIST_ALERTED: 'Specialist alerted',
  EQUIPMENT_READY: 'Equipment ready',
};

export const PICKUP_SOURCE_LABEL = {
  ADDRESS: 'Entered address (demo gazetteer)',
  MAP_PIN: 'Dropped map pin',
  CALLER_SHARED: 'Simulated caller-shared location',
} as const;

export const CALLER_CONSENT_TEXT =
  'Location is shared only for emergency pickup coordination and expires when the incident is closed.';

export function titleCase(s: string) {
  return s.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
