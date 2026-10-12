import { AMBULANCE_STATUS_LABEL, ACCEPTANCE_LABEL } from '../lib/labels';
import type { Ambulance, Hospital, HospitalRecommendation, HospitalResourceStatus, Incident } from '../lib/types';
import type { ATone, HTone, MapAmbulance, MapHeat, MapHospital, MapPickup } from './MapView';

export function hospitalTone(h: Hospital, s: HospitalResourceStatus | undefined, rec?: HospitalRecommendation): HTone {
  if (!s || h.status === 'OFFLINE' || s.acceptanceStatus === 'DIVERTING' || s.acceptanceStatus === 'UNAVAILABLE' || s.freshness === 'UNAVAILABLE') return 'red';
  if (rec && !rec.eligible) return 'red';
  if (s.acceptanceStatus === 'LIMITED_CAPACITY' || s.freshness === 'STALE') return 'yellow';
  return 'green';
}

export function ambulanceTone(a: Ambulance): ATone {
  if (a.status === 'OFFLINE') return 'gray';
  if (a.status === 'AVAILABLE') return 'blue';
  if (['ASSIGNED', 'EN_ROUTE_PICKUP', 'AT_PICKUP'].includes(a.status)) return 'orange';
  return 'purple';
}

export function mapHospitals(hospitals: Hospital[], status: Record<string, HospitalResourceStatus>, recs: HospitalRecommendation[] | undefined, selectedId?: string | null, recommendedId?: string | null): MapHospital[] {
  return hospitals.map((h) => {
    const s = status[h.id];
    const rec = recs?.find((r) => r.hospitalId === h.id);
    return {
      id: h.id, name: h.name, lat: h.entranceLat, lng: h.entranceLng, tone: hospitalTone(h, s, rec),
      status: s ? `${ACCEPTANCE_LABEL[s.acceptanceStatus]} · ${s.freshness}${rec ? (rec.eligible ? ' · eligible' : ' · not eligible') : ''}` : 'unknown',
      selected: h.id === selectedId, recommended: h.id === recommendedId,
    };
  });
}

export function mapAmbulances(ambs: Ambulance[], selectedIncident?: Incident | null): MapAmbulance[] {
  return ambs.map((a) => ({
    id: a.id, code: a.code, lat: a.lat, lng: a.lng, tone: ambulanceTone(a),
    status: `${AMBULANCE_STATUS_LABEL[a.status]}${a.gpsAgeSeconds != null && a.locationSharing ? ` · GPS ${a.gpsAgeSeconds}s ago` : ''}`,
    warn: a.locationSharing && a.gpsFreshness === 'LOST' ? 'GPS signal lost — last known location' : a.locationSharing && a.gpsFreshness === 'STALE' ? 'location stale' : undefined,
    selected: !!selectedIncident && selectedIncident.assignedAmbulanceId === a.id,
  }));
}

export function mapPickups(incidents: Incident[], selectedId?: string | null): MapPickup[] {
  return incidents.filter((i) => i.pickupLat != null && i.pickupLng != null && !['CLOSED', 'CANCELLED', 'HANDED_OVER', 'ARRIVED', 'PATIENT_ONBOARD', 'EN_ROUTE_HOSPITAL'].includes(i.status))
    .map((i) => ({ id: i.id, lat: i.pickupLat!, lng: i.pickupLng!, label: `${i.incidentCode} (${i.severity})`, selected: i.id === selectedId }));
}

/** ICU pressure heat overlay: green >= 40% free, amber > 0, red none / diverting. */
export function mapHeat(hospitals: Hospital[], status: Record<string, HospitalResourceStatus>): MapHeat[] {
  return hospitals.map((h) => {
    const s = status[h.id];
    const free = s ? s.availableIcuBeds : 0;
    const pct = h.totalIcuBeds ? free / h.totalIcuBeds : 0;
    const tone: HTone = !s || free === 0 || s.acceptanceStatus === 'DIVERTING' ? 'red' : pct < 0.4 ? 'yellow' : 'green';
    return { id: h.id, lat: h.lat, lng: h.lng, tone, label: `${h.name}: ICU ${free}/${h.totalIcuBeds} free (${tone === 'green' ? 'low pressure' : tone === 'yellow' ? 'moderate pressure' : 'high pressure'})` };
  });
}
