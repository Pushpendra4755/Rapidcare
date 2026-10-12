import { haversineKm, pathLengthKm } from './geo';
import type { LatLng, Route, Severity } from './types';

export interface RouteOptions {
  severity?: Severity;
  /** Epoch ms of departure; drives the traffic model. */
  departureMs?: number;
}

/**
 * Routing provider abstraction. The app only ever depends on this interface.
 * Swap MockRoutingProvider for a server-side proxy to Google Routes / Mapbox / OpenRouteService
 * (see README "Switching routing providers"). Only coordinates are sent — never patient data.
 */
export interface RoutingProvider {
  readonly name: string;
  getRoute(from: LatLng, to: LatLng, opts?: RouteOptions): Promise<Route>;
}

export function trafficFor(ms: number): { level: Route['trafficLevel']; factor: number } {
  const h = new Date(ms).getHours();
  if ((h >= 8 && h < 11) || (h >= 17 && h < 21)) return { level: 'HEAVY', factor: 0.7 };
  if ((h >= 7 && h < 8) || (h >= 11 && h < 13) || (h >= 21 && h < 22)) return { level: 'MODERATE', factor: 0.85 };
  return { level: 'LIGHT', factor: 1 };
}

const BASE_URBAN_KMPH = 42;

/** Deterministic, offline "road-like" geometry: a stair-step path with light jitter. */
export class MockRoutingProvider implements RoutingProvider {
  readonly name = 'mock';
  private cache = new Map<string, Route>();

  async getRoute(from: LatLng, to: LatLng, opts: RouteOptions = {}): Promise<Route> {
    return this.compute(from, to, opts);
  }

  /** Synchronous variant used by the simulator and tests. */
  compute(from: LatLng, to: LatLng, opts: RouteOptions = {}): Route {
    const when = opts.departureMs ?? Date.now();
    const traffic = trafficFor(when);
    const key = [from.lat.toFixed(4), from.lng.toFixed(4), to.lat.toFixed(4), to.lng.toFixed(4), traffic.level, opts.severity ?? ''].join('|');
    const hit = this.cache.get(key);
    if (hit) return hit;

    const pts = stairStep(from, to);
    const distanceKm = pathLengthKm(pts);
    const priority = opts.severity === 'CRITICAL' ? 1.12 : opts.severity === 'HIGH' ? 1.06 : 1;
    const speed = BASE_URBAN_KMPH * traffic.factor * priority;
    const route: Route = {
      points: pts,
      distanceKm,
      durationSec: Math.max(30, (distanceKm / speed) * 3600),
      trafficLevel: traffic.level,
      provider: this.name,
    };
    if (this.cache.size > 400) this.cache.clear();
    this.cache.set(key, route);
    return route;
  }
}

function stairStep(a: LatLng, b: LatLng): LatLng[] {
  const direct = haversineKm(a, b);
  if (direct < 0.25) return [a, b];
  // deterministic jitter from the coordinates so the same trip always draws the same path
  const seed = Math.abs(Math.sin(a.lat * 12.9898 + b.lng * 78.233) * 43758.5453) % 1;
  const f1 = 0.35 + seed * 0.1;
  const f2 = 0.62 + seed * 0.1;
  const p1: LatLng = { lat: a.lat + (b.lat - a.lat) * f1, lng: a.lng };
  const p2: LatLng = { lat: p1.lat, lng: a.lng + (b.lng - a.lng) * f2 };
  const p3: LatLng = { lat: b.lat, lng: p2.lng };
  return [a, p1, p2, p3, b];
}

/**
 * Production adapter: calls YOUR server/edge function (never the vendor directly from the browser,
 * so the API key stays server-side). Falls back to the mock provider if the proxy is unreachable.
 */
export class ProxyRoutingProvider implements RoutingProvider {
  readonly name: string;
  constructor(
    name: string,
    private endpoint: string,
    private fallback: RoutingProvider = new MockRoutingProvider(),
  ) {
    this.name = name;
  }

  async getRoute(from: LatLng, to: LatLng, opts: RouteOptions = {}): Promise<Route> {
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // coordinates only — no incident id, no patient details
        body: JSON.stringify({ from, to, departureMs: opts.departureMs, priority: opts.severity === 'CRITICAL' }),
      });
      if (!res.ok) throw new Error(`routing proxy ${res.status}`);
      const data = (await res.json()) as Route;
      if (!Array.isArray(data.points) || data.points.length < 2) throw new Error('bad route payload');
      return { ...data, provider: this.name };
    } catch {
      const r = await this.fallback.getRoute(from, to, opts);
      return { ...r, provider: `${r.provider} (fallback)` };
    }
  }
}

export function createRoutingProvider(kind: string | undefined, endpoint = '/api/route'): RoutingProvider {
  if (!kind || kind === 'mock') return new MockRoutingProvider();
  return new ProxyRoutingProvider(kind, endpoint);
}
