import { RESOURCE_LABEL, RESOURCE_SHORT, RESOURCE_PLURAL, CAPABILITY_LABEL, formatAgeShort } from './engineText';
import { inBounds, round } from './geo';
import type {
  AgeGroup, Capability, CountedResource, EmergencyType, Hospital, HospitalRecommendation, HospitalResourceStatus,
  Incident, RecommendationLabel, ResourceKey, ServiceArea, SystemConfig,
} from './types';
import { COUNTED_RESOURCES } from './types';

/**
 * Transparent decision-support ranking engine.
 *
 *  Step 1  hard eligibility filter (medical suitability always comes before distance)
 *  Step 2  weighted score among eligible hospitals:
 *            40% resource match + 25% specialty match + 20% ETA + 10% freshness + 5% workload
 *          then multiplicative penalties for STALE data and LIMITED_CAPACITY.
 *
 * Output is a *recommended destination* that a dispatcher must review. It is never an automatic dispatch.
 */

const CAPABILITY_FOR_TYPE: Partial<Record<EmergencyType, Capability>> = {
  TRAUMA: 'TRAUMA', CARDIAC: 'CARDIAC', STROKE: 'STROKE', PEDIATRIC: 'PEDIATRIC', BURN: 'BURN', OBSTETRIC: 'OBSTETRIC',
};

const CAPABILITY_FOR_RESOURCE: Partial<Record<ResourceKey, Capability>> = {
  CATH_LAB: 'CARDIAC', STROKE_UNIT: 'STROKE', NEONATAL_ICU: 'NEONATAL',
};

export function deriveCapabilities(
  type: EmergencyType, age: AgeGroup, resources: ResourceKey[], specialty: Capability | null,
): { required: Capability[]; preferred: Capability[] } {
  const req = new Set<Capability>();
  const t = CAPABILITY_FOR_TYPE[type];
  if (t) req.add(t);
  if (specialty) req.add(specialty);
  if (age === 'NEONATAL') req.add('NEONATAL');
  for (const r of resources) {
    const c = CAPABILITY_FOR_RESOURCE[r];
    if (c) req.add(c);
  }
  const preferred = new Set<Capability>();
  if (age === 'CHILD' && !req.has('PEDIATRIC')) preferred.add('PEDIATRIC');
  return { required: [...req], preferred: [...preferred] };
}

export interface EngineHospital { hospital: Hospital; status: HospitalResourceStatus }
export interface EtaEntry { distanceKm: number; etaMinutes: number }

export interface EngineInput {
  incident: Pick<Incident, 'id' | 'emergencyType' | 'severity' | 'patientAgeGroup' | 'requiredResources' | 'requiredCapabilities' | 'declinedHospitalIds' | 'regionId'> & { preferredCapabilities?: Capability[] };
  hospitals: EngineHospital[];
  eta: Record<string, EtaEntry | undefined>;
  /** active incoming cases per hospital (pending or accepted, incident still open) */
  workload: Record<string, number>;
  config: SystemConfig;
  serviceAreas: ServiceArea[];
  nowIso: string;
}

const COUNT_FIELD: Record<CountedResource, keyof HospitalResourceStatus> = {
  ER_BED: 'availableErBeds',
  ICU_BED: 'availableIcuBeds',
  VENTILATOR: 'availableVentilators',
  TRAUMA_BAY: 'availableTraumaBays',
  ISOLATION_BED: 'availableIsolationBeds',
};

export function availableCount(s: HospitalResourceStatus, r: CountedResource): number {
  return s[COUNT_FIELD[r]] as number;
}

/** Counted resources actually enforced for this incident (an ER bed is implied when nothing else is counted). */
export function enforcedCounted(required: ResourceKey[]): CountedResource[] {
  const counted = required.filter((r): r is CountedResource => (COUNTED_RESOURCES as readonly string[]).includes(r));
  return counted.length ? counted : ['ER_BED'];
}

const FRESHNESS_SCORE = { LIVE: 100, RECENT: 75, STALE: 30, UNAVAILABLE: 0 } as const;

function hasSurgical(h: Hospital) {
  return h.capabilities.TRAUMA || h.capabilities.OBSTETRIC || h.capabilities.BURN;
}

export function describeNeeds(inc: EngineInput['incident']): string {
  const parts: string[] = [];
  for (const c of inc.requiredCapabilities) parts.push(CAPABILITY_LABEL[c].toLowerCase());
  for (const r of enforcedCounted(inc.requiredResources)) if (r !== 'ER_BED' || inc.requiredResources.length === 0 || parts.length === 0) parts.push(RESOURCE_SHORT[r]);
  for (const r of inc.requiredResources) if (!(COUNTED_RESOURCES as readonly string[]).includes(r) && !parts.includes(RESOURCE_SHORT[r])) {
    if (!CAPABILITY_FOR_RESOURCE[r]) parts.push(RESOURCE_SHORT[r]);
  }
  return [...new Set(parts)].join(' + ') || 'emergency care';
}

export function rankHospitals(input: EngineInput): HospitalRecommendation[] {
  const { incident, config, nowIso } = input;
  const w = config.weights;
  const wSum = w.resource + w.specialty + w.eta + w.freshness + w.workload || 1;
  const counted = enforcedCounted(incident.requiredResources);
  const preferred = incident.preferredCapabilities ?? [];
  const area = incident.regionId ? input.serviceAreas.find((a) => a.id === incident.regionId) : undefined;
  const needs = describeNeeds(incident);

  const out: HospitalRecommendation[] = input.hospitals.map(({ hospital: h, status: s }) => {
    const why: string[] = [];
    const warn: string[] = [];
    const bad: string[] = [];
    const eta = input.eta[h.id];

    // ---------- Step 1: eligibility ----------
    if (h.status === 'OFFLINE') bad.push('Not eligible: hospital is offline.');
    if (s.acceptanceStatus === 'UNAVAILABLE') bad.push('Not eligible: hospital marked unavailable for emergencies.');
    if (s.acceptanceStatus === 'DIVERTING') bad.push('Not eligible: hospital is diverting emergency cases.');
    if (s.freshness === 'UNAVAILABLE') bad.push('Not eligible: capacity data unavailable — call the hospital to verify.');
    else if (s.ageMinutes != null && s.ageMinutes > config.ineligibleAfterMinutes) {
      bad.push(`Not eligible: capacity data is ${Math.round(s.ageMinutes)} min old (limit ${config.ineligibleAfterMinutes} min).`);
    }
    for (const c of incident.requiredCapabilities) {
      if (!h.capabilities[c]) bad.push(`Not eligible: ${CAPABILITY_LABEL[c].toLowerCase()} service unavailable.`);
    }
    for (const r of incident.requiredResources) {
      if (r === 'OPERATING_THEATRE' && !hasSurgical(h)) bad.push('Not eligible: no operating theatre / surgical service.');
    }
    for (const r of counted) {
      if (availableCount(s, r) <= 0) bad.push(`Not eligible: no ${RESOURCE_PLURAL[r]} available.`);
    }
    if (incident.declinedHospitalIds.includes(h.id)) bad.push('Not eligible: hospital already declined this incident.');
    if (config.restrictToServiceArea && area && h.regionId !== area.id && !area.neighbors.includes(h.regionId)) {
      bad.push('Not eligible: outside the allowed service area.');
    }
    if (!eta) bad.push('Not eligible: no route/ETA available.');

    const eligible = bad.length === 0;

    // ---------- Step 2: scoring ----------
    // resource match: baseline 60 when every required resource is present, up to 100 with headroom (cap 3 per resource)
    let headroom = 0;
    for (const r of counted) headroom += Math.min(availableCount(s, r), 3) / 3;
    headroom = counted.length ? headroom / counted.length : 0;
    const resourceMatch = eligible ? 100 * (0.6 + 0.4 * headroom) : 0;

    let specialty = 100;
    if (incident.requiredCapabilities.length === 0 && preferred.length === 0) specialty = 100;
    if (preferred.length) {
      const hit = preferred.filter((c) => h.capabilities[c]).length / preferred.length;
      specialty = 100 * (0.8 + 0.2 * hit);
    }
    if (!eligible && incident.requiredCapabilities.some((c) => !h.capabilities[c])) specialty = 0;

    const etaMin = eta?.etaMinutes ?? null;
    const etaScore = etaMin == null ? 0 : Math.max(0, 100 * (1 - etaMin / config.etaCapMinutes));
    const freshnessScore = FRESHNESS_SCORE[s.freshness];
    const active = input.workload[h.id] ?? 0;
    const workloadScore = Math.max(0, 100 - 30 * active);

    let final = eligible
      ? (resourceMatch * w.resource + specialty * w.specialty + etaScore * w.eta + freshnessScore * w.freshness + workloadScore * w.workload) / wSum
      : 0;

    if (eligible) {
      const needsRes = counted.map((r) => `${RESOURCE_LABEL[r]} (${availableCount(s, r)} available)`).join(', ');
      why.push(`Has required resources: ${needsRes}.`);
      if (incident.requiredCapabilities.length) {
        why.push(`Specialty match: ${incident.requiredCapabilities.map((c) => CAPABILITY_LABEL[c]).join(', ')} service available.`);
      } else why.push('No specific specialty required.');
      if (eta) why.push(`ETA ${Math.round(eta.etaMinutes)} min over ${round(eta.distanceKm, 1)} km (traffic-aware).`);
      why.push(`Capacity data ${s.freshness}${s.ageMinutes != null ? ` — verified ${formatAgeShort(s.ageMinutes)}` : ''}.`);
      if (active > 0) why.push(`Workload: ${active} incoming case${active > 1 ? 's' : ''} already assigned.`);
      if (s.freshness === 'STALE') {
        final *= config.staleMultiplier;
        warn.push(`Low confidence: capacity information is stale (${formatAgeShort(s.ageMinutes)}). Verify by phone before relying on it.`);
      }
      if (s.acceptanceStatus === 'LIMITED_CAPACITY') {
        final *= config.limitedMultiplier;
        warn.push('Hospital reports limited capacity — confirm acceptance before treating as confirmed.');
      }
      if (preferred.length && !preferred.every((c) => h.capabilities[c])) {
        warn.push(`Preferred but unavailable: ${preferred.filter((c) => !h.capabilities[c]).map((c) => CAPABILITY_LABEL[c]).join(', ')}.`);
      }
    }

    return {
      id: `${incident.id}:${h.id}`,
      incidentId: incident.id,
      hospitalId: h.id,
      eligible,
      label: 'NOT_ELIGIBLE' as RecommendationLabel,
      ineligibilityReasons: bad,
      warnings: warn,
      reasons: why,
      summary: '',
      distanceKm: eta ? round(eta.distanceKm, 1) : null,
      etaMinutes: etaMin == null ? null : Math.round(etaMin),
      resourceMatchScore: round(resourceMatch, 1),
      specialtyMatchScore: round(specialty, 1),
      etaScore: round(etaScore, 1),
      freshnessScore,
      workloadScore,
      finalScore: round(final, 1),
      rank: null,
      freshness: s.freshness,
      capacityAgeMinutes: s.ageMinutes == null ? null : Math.round(s.ageMinutes),
      generatedAt: nowIso,
    };
  });

  // Eligible hospitals always outrank ineligible ones — distance can never rescue an unsuitable hospital.
  const eligible = out.filter((r) => r.eligible).sort((a, b) => b.finalScore - a.finalScore || (a.etaMinutes ?? 1e9) - (b.etaMinutes ?? 1e9));
  const ineligible = out.filter((r) => !r.eligible).sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));

  eligible.forEach((r, i) => {
    r.rank = i + 1;
    const stale = r.freshness === 'STALE';
    const limited = r.warnings.some((x) => x.startsWith('Hospital reports limited'));
    if (stale) r.label = 'STALE_VERIFY';
    else if (i === 0) r.label = 'BEST_MATCH';
    else if (limited) r.label = 'LIMITED_CAPACITY';
    else r.label = 'ELIGIBLE_ALTERNATIVE';
    if (i === 0 && !stale) r.summary = `Recommended: best match for ${needs}, ETA ${r.etaMinutes} min.`;
    else if (i === 0 && stale) r.summary = `Low confidence: top match for ${needs} but capacity data is stale — verify by phone. ETA ${r.etaMinutes} min.`;
    else if (stale) r.summary = `Low confidence: capacity information is stale. ETA ${r.etaMinutes} min.`;
    else if (limited) r.summary = `Limited capacity: eligible alternative, ETA ${r.etaMinutes} min.`;
    else r.summary = `Eligible alternative: ETA ${r.etaMinutes} min.`;
  });
  ineligible.forEach((r) => {
    r.label = 'NOT_ELIGIBLE';
    r.summary = r.ineligibilityReasons[0] ?? 'Not eligible.';
  });
  return [...eligible, ...ineligible];
}

export const LABEL_TEXT: Record<RecommendationLabel, string> = {
  BEST_MATCH: 'BEST MATCH',
  ELIGIBLE_ALTERNATIVE: 'ELIGIBLE ALTERNATIVE',
  LIMITED_CAPACITY: 'LIMITED CAPACITY',
  NOT_ELIGIBLE: 'NOT ELIGIBLE',
  STALE_VERIFY: 'STALE DATA — VERIFY BY PHONE',
};

export function pointInAreas(p: { lat: number; lng: number }, areas: ServiceArea[]): string | null {
  for (const a of areas) if (inBounds(p, a.bounds)) return a.id;
  return null;
}
