import type { GpsFreshness, HospitalFreshness, SystemConfig } from './types';

/**
 * Hospital capacity freshness.
 *  LIVE <= liveMinutes (5), RECENT <= recentMinutes (15), STALE older, UNAVAILABLE = never verified or hospital offline.
 */
export function hospitalFreshness(
  lastVerifiedAt: string | null,
  nowMs: number,
  cfg: Pick<SystemConfig, 'liveMinutes' | 'recentMinutes'>,
  hospitalOnline = true,
): { freshness: HospitalFreshness; ageMinutes: number | null } {
  if (!hospitalOnline || !lastVerifiedAt) return { freshness: 'UNAVAILABLE', ageMinutes: null };
  const t = Date.parse(lastVerifiedAt);
  if (!Number.isFinite(t)) return { freshness: 'UNAVAILABLE', ageMinutes: null };
  const ageMinutes = Math.max(0, (nowMs - t) / 60000);
  if (ageMinutes <= cfg.liveMinutes) return { freshness: 'LIVE', ageMinutes };
  if (ageMinutes <= cfg.recentMinutes) return { freshness: 'RECENT', ageMinutes };
  return { freshness: 'STALE', ageMinutes };
}

/**
 * Ambulance GPS freshness while on an active trip: LIVE <= 30s, STALE > 30s, LOST > 120s.
 * `NONE` when the ambulance is not sharing location (never presented as live).
 */
export function gpsFreshness(
  lastLocationAt: string | null,
  nowMs: number,
  sharing: boolean,
  cfg: Pick<SystemConfig, 'gpsStaleSec' | 'gpsLostSec'>,
): { freshness: GpsFreshness; ageSeconds: number | null } {
  if (!lastLocationAt) return { freshness: 'NONE', ageSeconds: null };
  const ageSeconds = Math.max(0, (nowMs - Date.parse(lastLocationAt)) / 1000);
  if (!sharing) return { freshness: 'NONE', ageSeconds };
  if (ageSeconds <= cfg.gpsStaleSec) return { freshness: 'LIVE', ageSeconds };
  if (ageSeconds <= cfg.gpsLostSec) return { freshness: 'STALE', ageSeconds };
  return { freshness: 'LOST', ageSeconds };
}

export function formatAge(minutes: number | null): string {
  if (minutes == null) return 'never verified';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} min ago`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${Math.round(minutes - h * 60)} min ago`;
}
