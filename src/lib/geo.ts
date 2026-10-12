import type { LatLng } from './types';

const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function pathLengthKm(points: LatLng[]): number {
  let t = 0;
  for (let i = 1; i < points.length; i++) t += haversineKm(points[i - 1], points[i]);
  return t;
}

/** Point at `distKm` along the polyline, plus the index of the segment start and heading. */
export function pointAlong(points: LatLng[], distKm: number): { point: LatLng; heading: number; done: boolean } {
  if (points.length === 0) return { point: { lat: 0, lng: 0 }, heading: 0, done: true };
  if (points.length === 1) return { point: points[0], heading: 0, done: true };
  let remaining = Math.max(0, distKm);
  for (let i = 1; i < points.length; i++) {
    const seg = haversineKm(points[i - 1], points[i]);
    if (remaining <= seg) {
      const f = seg === 0 ? 0 : remaining / seg;
      return {
        point: {
          lat: points[i - 1].lat + (points[i].lat - points[i - 1].lat) * f,
          lng: points[i - 1].lng + (points[i].lng - points[i - 1].lng) * f,
        },
        heading: bearingDeg(points[i - 1], points[i]),
        done: false,
      };
    }
    remaining -= seg;
  }
  const last = points[points.length - 1];
  return { point: last, heading: bearingDeg(points[points.length - 2], last), done: true };
}

/** Remaining polyline starting at the point `distKm` along it. */
export function sliceFrom(points: LatLng[], distKm: number): LatLng[] {
  if (points.length < 2) return points.slice();
  let remaining = Math.max(0, distKm);
  for (let i = 1; i < points.length; i++) {
    const seg = haversineKm(points[i - 1], points[i]);
    if (remaining <= seg) {
      const { point } = pointAlong(points, distKm);
      return [point, ...points.slice(i)];
    }
    remaining -= seg;
  }
  return [points[points.length - 1]];
}

export function inBounds(p: LatLng, b: [number, number, number, number]): boolean {
  return p.lat >= b[0] && p.lat <= b[2] && p.lng >= b[1] && p.lng <= b[3];
}

export const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return typeof lat === 'number' && typeof lng === 'number' && Number.isFinite(lat) && Number.isFinite(lng)
    && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}
