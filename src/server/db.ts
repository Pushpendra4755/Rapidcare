import type {
  Ambulance, AppNotification, AuditLog, EmergencyCategory, EtaPoint, Hospital, HospitalRecommendation, HospitalRequest,
  HospitalResourceStatus, Incident, LatLng, LocationPoint, ServiceArea, SystemConfig, TimelineEvent, User,
} from '../lib/types';

export type StoredUser = User & { passwordHash: string; salt: string };
export type StoredStatus = Omit<HospitalResourceStatus, 'freshness' | 'ageMinutes'>;
export type StoredAmbulance = Omit<Ambulance, 'gpsFreshness' | 'gpsAgeSeconds'>;

export interface ActiveRoute {
  incidentId: string;
  leg: 'PICKUP' | 'HOSPITAL';
  points: LatLng[];
  totalKm: number;
  progressKm: number;
  speedKmph: number;
  trafficLevel: 'LIGHT' | 'MODERATE' | 'HEAVY';
  destination: LatLng;
  hospitalId: string | null;
  computedAt: number;
}

/** In-memory relational store. Table names/columns mirror supabase/schema.sql. */
export interface Db {
  users: StoredUser[];
  hospitals: Hospital[];
  resourceStatus: Record<string, StoredStatus>;
  ambulances: StoredAmbulance[];
  incidents: Incident[];
  recommendations: Record<string, HospitalRecommendation[]>;
  requests: HospitalRequest[];
  notifications: AppNotification[];
  timeline: TimelineEvent[];
  etaHistory: Record<string, EtaPoint[]>;
  locationHistory: LocationPoint[];
  audit: AuditLog[];
  serviceAreas: ServiceArea[];
  categories: EmergencyCategory[];
  config: SystemConfig;
  routes: Record<string, ActiveRoute>;
  seq: Record<string, number>;
}

export const DEFAULT_CONFIG: SystemConfig = {
  weights: { resource: 0.4, specialty: 0.25, eta: 0.2, freshness: 0.1, workload: 0.05 },
  etaCapMinutes: 45,
  liveMinutes: 5,
  recentMinutes: 15,
  ineligibleAfterMinutes: 120,
  staleMultiplier: 0.85,
  limitedMultiplier: 0.9,
  restrictToServiceArea: false,
  ackTimeoutSec: 60,
  decisionTimeoutSec: 180,
  gpsStaleSec: 30,
  gpsLostSec: 120,
  escalateCriticalAfterSec: 90,
  notifyAdminsOnEscalation: true,
  simCompression: 6,
  sessionIdleMinutes: 30,
};
