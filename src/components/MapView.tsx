import { useEffect, useMemo, useRef, useState } from 'react';
import type { LatLng } from '../lib/types';
import { Icon } from './ui';

export type HTone = 'green' | 'yellow' | 'red';
export type ATone = 'blue' | 'orange' | 'purple' | 'gray';
export interface MapHospital { id: string; name: string; lat: number; lng: number; tone: HTone; status: string; selected?: boolean; recommended?: boolean }
export interface MapAmbulance { id: string; code: string; lat: number; lng: number; tone: ATone; status: string; warn?: string; selected?: boolean }
export interface MapPickup { id: string; lat: number; lng: number; label: string; selected?: boolean }
export interface MapRoute { id: string; kind: 'pickup' | 'hospital' | 'preview' | 'trail'; points: LatLng[]; label?: string }
export interface MapHeat { id: string; lat: number; lng: number; tone: HTone; label: string }
export interface MapZone { id: string; name: string; bounds: [number, number, number, number] }

export interface MapProps {
  hospitals?: MapHospital[];
  ambulances?: MapAmbulance[];
  pickups?: MapPickup[];
  routes?: MapRoute[];
  heat?: MapHeat[];
  zones?: MapZone[];
  pin?: LatLng | null;
  onMapClick?: (p: LatLng) => void;
  onSelect?: (kind: 'hospital' | 'ambulance' | 'pickup', id: string) => void;
  fitKey?: string;
  height?: number | string;
  clickHint?: string;
  forceSchematic?: boolean;
}

const HC: Record<HTone, string> = { green: '#0b7a3b', yellow: '#c98a00', red: '#b3151b' };
const HS: Record<HTone, string> = { green: '✓', yellow: '!', red: '✕' };
const AC: Record<ATone, string> = { blue: '#1558b0', orange: '#d9650f', purple: '#6b35b8', gray: '#6c778a' };
const RC: Record<MapRoute['kind'], { color: string; dash?: string; w: number }> = {
  pickup: { color: '#d9650f', w: 5 }, hospital: { color: '#6b35b8', w: 5 }, preview: { color: '#0b2545', dash: '8 8', w: 4 }, trail: { color: '#6c778a', dash: '2 6', w: 3 },
};

// ---------------------------------------------------------------- Leaflet loader (CDN, with offline fallback)
type LeafletNS = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let leafletPromise: Promise<LeafletNS | null> | null = null;
function loadLeaflet(): Promise<LeafletNS | null> {
  const w = window as unknown as { L?: LeafletNS };
  if (w.L) return Promise.resolve(w.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve) => {
    const base = 'https://unpkg.com/leaflet@1.9.4/dist/';
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = `${base}leaflet.css`; css.crossOrigin = '';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = `${base}leaflet.js`; s.crossOrigin = '';
    const timer = setTimeout(() => resolve(null), 7000);
    s.onload = () => { clearTimeout(timer); resolve(w.L ?? null); };
    s.onerror = () => { clearTimeout(timer); resolve(null); };
    document.head.appendChild(s);
  });
  return leafletPromise;
}

export function MapView(props: MapProps) {
  const [mode, setMode] = useState<'loading' | 'leaflet' | 'schematic'>(props.forceSchematic ? 'schematic' : 'loading');
  useEffect(() => {
    if (props.forceSchematic) return;
    let alive = true;
    loadLeaflet().then((L) => { if (alive) setMode(L ? 'leaflet' : 'schematic'); });
    return () => { alive = false; };
  }, [props.forceSchematic]);
  const h = props.height ?? '100%';
  return (
    <div style={{ position: 'absolute', inset: 0, height: h === '100%' ? undefined : h }}>
      {mode === 'loading' && <div className="row" style={{ position: 'absolute', inset: 0, justifyContent: 'center' }} role="status"><span className="spinner" /> <span className="muted">Loading map…</span></div>}
      {mode === 'leaflet' && <LeafletMap {...props} />}
      {mode === 'schematic' && <SchematicMap {...props} />}
      {mode === 'schematic' && !props.forceSchematic && (
        <div className="mapoffline" role="status"><Icon name="alert" size={14} /><span>Map tiles unavailable (offline) — schematic map shown; positions and routes remain accurate.</span></div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- Leaflet implementation
function LeafletMap(p: MapProps) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletNS>(null);
  const layer = useRef<LeafletNS>(null);
  const pinLayer = useRef<LeafletNS>(null);
  const fitted = useRef<string | null>(null);
  const clickRef = useRef(p.onMapClick);
  clickRef.current = p.onMapClick;
  const selRef = useRef(p.onSelect);
  selRef.current = p.onSelect;

  useEffect(() => {
    const L = (window as unknown as { L: LeafletNS }).L;
    const m = L.map(el.current!, { zoomControl: true, attributionControl: true }).setView([12.9716, 77.5946], 12);
    const tile = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    L.tileLayer(tile, { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    pinLayer.current = L.layerGroup().addTo(m);
    m.on('click', (e: { latlng: { lat: number; lng: number } }) => clickRef.current?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
    map.current = m;
    setTimeout(() => m.invalidateSize(), 100);
    return () => { m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const L = (window as unknown as { L: LeafletNS }).L;
    const g = layer.current; const m = map.current;
    if (!g || !m) return;
    g.clearLayers();
    const bounds: [number, number][] = [];
    for (const z of p.zones ?? []) L.rectangle([[z.bounds[0], z.bounds[1]], [z.bounds[2], z.bounds[3]]], { color: '#13315c', weight: 1, dashArray: '4 6', fillOpacity: 0.02, interactive: false }).addTo(g);
    for (const hz of p.heat ?? []) L.circle([hz.lat, hz.lng], { radius: 3200, color: HC[hz.tone], weight: 1, fillColor: HC[hz.tone], fillOpacity: 0.22, interactive: false }).bindTooltip(hz.label).addTo(g);
    for (const r of p.routes ?? []) {
      if (r.points.length < 2) continue;
      const st = RC[r.kind];
      L.polyline(r.points.map((q) => [q.lat, q.lng]), { color: st.color, weight: st.w, opacity: 0.85, dashArray: st.dash }).bindTooltip(r.label ?? r.kind).addTo(g);
      if (r.kind !== 'trail') r.points.forEach((q) => bounds.push([q.lat, q.lng]));
    }
    const icon = (cls: string, color: string, text: string, sel?: boolean) => L.divIcon({ className: '', html: `<div class="mk ${cls} ${sel ? 'sel' : ''}" style="background:${color}">${text}</div>`, iconSize: cls === 'h' ? [30, 30] : [28, 28], iconAnchor: cls === 'h' ? [15, 15] : [14, 14] });
    for (const h of p.hospitals ?? []) {
      L.marker([h.lat, h.lng], { icon: icon('h', HC[h.tone], `H${HS[h.tone]}`, h.selected), title: h.name, keyboard: true })
        .bindTooltip(`${h.name} — ${h.status}${h.recommended ? ' (recommended)' : ''}`).on('click', () => selRef.current?.('hospital', h.id)).addTo(g);
      bounds.push([h.lat, h.lng]);
    }
    for (const a of p.ambulances ?? []) {
      L.marker([a.lat, a.lng], { icon: icon('a', AC[a.tone], a.warn ? '!' : 'A', a.selected), title: a.code, keyboard: true, zIndexOffset: 500 })
        .bindTooltip(`${a.code} — ${a.status}${a.warn ? ` — ${a.warn}` : ''}`).on('click', () => selRef.current?.('ambulance', a.id)).addTo(g);
      if (a.selected) bounds.push([a.lat, a.lng]);
    }
    for (const q of p.pickups ?? []) {
      L.marker([q.lat, q.lng], { icon: L.divIcon({ className: '', html: `<div class="mk p ${q.selected ? 'sel' : ''}"></div>`, iconSize: [26, 26], iconAnchor: [4, 26] }), title: q.label, zIndexOffset: 600 })
        .bindTooltip(`Pickup: ${q.label}`).on('click', () => selRef.current?.('pickup', q.id)).addTo(g);
      if (q.selected) bounds.push([q.lat, q.lng]);
    }
    const key = p.fitKey ?? 'default';
    if (fitted.current !== key) {
      fitted.current = key;
      const pts = bounds.length ? bounds : (p.hospitals ?? []).map((h) => [h.lat, h.lng] as [number, number]);
      if (pts.length) m.fitBounds(pts, { padding: [40, 40], maxZoom: 14 });
    }
  }, [p.hospitals, p.ambulances, p.pickups, p.routes, p.heat, p.zones, p.fitKey]);

  useEffect(() => {
    const L = (window as unknown as { L: LeafletNS }).L;
    const g = pinLayer.current;
    if (!g) return;
    g.clearLayers();
    if (p.pin) L.marker([p.pin.lat, p.pin.lng], { icon: L.divIcon({ className: '', html: '<div class="mk p sel"></div>', iconSize: [26, 26], iconAnchor: [4, 26] }) }).bindTooltip('Dropped pin').addTo(g);
  }, [p.pin]);

  return <div ref={el} className="map" role="application" aria-label="Interactive map" style={{ position: 'absolute', inset: 0 }} />;
}

// ---------------------------------------------------------------- Schematic (offline) implementation
function SchematicMap(p: MapProps) {
  const [zoom, setZoom] = useState(1);
  const svg = useRef<SVGSVGElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 1000, h: 640 });
  useEffect(() => {
    const el = wrap.current; if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width > 50 && r.height > 50) setSize({ w: Math.round(r.width), h: Math.round(r.height) }); });
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const W = size.w, H = size.h;
  const view = useMemo(() => {
    const pts: LatLng[] = [];
    (p.hospitals ?? []).forEach((h) => pts.push(h));
    (p.pickups ?? []).forEach((q) => pts.push(q));
    (p.ambulances ?? []).forEach((a) => pts.push(a));
    (p.routes ?? []).forEach((r) => r.kind !== 'trail' && r.points.forEach((q) => pts.push(q)));
    if (p.pin) pts.push(p.pin);
    if (!pts.length) pts.push({ lat: 12.9716, lng: 77.5946 });
    let s = Math.min(...pts.map((q) => q.lat)), n = Math.max(...pts.map((q) => q.lat));
    let w = Math.min(...pts.map((q) => q.lng)), e = Math.max(...pts.map((q) => q.lng));
    const heatPad = p.heat?.length ? 0.03 : 0;
    const padLat = Math.max(0.012, (n - s) * 0.12) + heatPad, padLng = Math.max(0.015, (e - w) * 0.12) + heatPad;
    s -= padLat; n += padLat; w -= padLng; e += padLng;
    // keep geographic aspect (1 deg lng ≈ cos(lat) * 1 deg lat)
    const k = Math.cos(((s + n) / 2) * Math.PI / 180);
    const wKm = (e - w) * k, hKm = n - s;
    const scale = Math.min(W / wKm, H / hKm);
    const cx = (w + e) / 2, cy = (s + n) / 2;
    return { scale, cx, cy, k };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.fitKey, p.hospitals?.length, p.pickups?.length, p.routes?.length, p.pin?.lat, W, H, p.heat?.length]);
  const proj = (q: LatLng) => ({ x: W / 2 + (q.lng - view.cx) * view.k * view.scale * zoom, y: H / 2 - (q.lat - view.cy) * view.scale * zoom });
  const unproj = (x: number, y: number): LatLng => ({ lat: view.cy - (y - H / 2) / (view.scale * zoom), lng: view.cx + (x - W / 2) / (view.k * view.scale * zoom) });

  const onClick = (ev: React.MouseEvent<SVGSVGElement>) => {
    if (!p.onMapClick || !svg.current) return;
    const r = svg.current.getBoundingClientRect();
    const sx = W / r.width, sy = H / r.height;
    // preserveAspectRatio meet: compute actual scale/offset
    const sc = Math.max(sx, sy);
    const offX = (r.width - W / sc) / 2, offY = (r.height - H / sc) / 2;
    const x = (ev.clientX - r.left - offX) * sc, y = (ev.clientY - r.top - offY) * sc;
    p.onMapClick(unproj(x, y));
  };
  const pl = (pts: LatLng[]) => pts.map((q) => { const a = proj(q); return `${a.x.toFixed(1)},${a.y.toFixed(1)}`; }).join(' ');

  return (
    <div ref={wrap} style={{ position: 'absolute', inset: 0, background: '#e4ebf3' }}>
      <svg ref={svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: '100%', display: 'block', cursor: p.onMapClick ? 'crosshair' : 'default' }}
        onClick={onClick} role="img" aria-label="Schematic map of hospitals, ambulances and routes">
        <defs><pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="#cbd6e4" strokeWidth="1" /></pattern></defs>
        <rect width={W} height={H} fill="url(#grid)" />
        {(p.zones ?? []).map((z) => { const a = proj({ lat: z.bounds[2], lng: z.bounds[1] }), b = proj({ lat: z.bounds[0], lng: z.bounds[3] }); return (
          <g key={z.id}><rect x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} fill="none" stroke="#13315c" strokeDasharray="4 6" opacity=".45" /><text x={a.x + 6} y={a.y + 16} fontSize="12" fill="#13315c" opacity=".7">{z.name}</text></g>); })}
        {(p.heat ?? []).map((hz) => { const c = proj(hz); return <circle key={hz.id} cx={c.x} cy={c.y} r={3.2 * view.k * 0 + (3.2 / 111) * view.scale * zoom} fill={HC[hz.tone]} opacity=".2"><title>{hz.label}</title></circle>; })}
        {(p.routes ?? []).map((r) => r.points.length > 1 && <polyline key={r.id + r.kind} points={pl(r.points)} fill="none" stroke={RC[r.kind].color} strokeWidth={RC[r.kind].w} strokeDasharray={RC[r.kind].dash} strokeLinejoin="round" opacity=".85"><title>{r.label ?? r.kind}</title></polyline>)}
        {(p.pickups ?? []).map((q) => { const c = proj(q); return (
          <g key={q.id} transform={`translate(${c.x},${c.y})`} onClick={(e) => { e.stopPropagation(); p.onSelect?.('pickup', q.id); }} style={{ cursor: 'pointer' }}>
            <path d="M0 0C-12-14-12-26 0-26S12-14 0 0z" fill="#b3151b" stroke="#fff" strokeWidth="2" /><circle cy="-17" r="4" fill="#fff" /><title>{`Pickup: ${q.label}`}</title>{q.selected && <circle cy="-14" r="20" fill="none" stroke="#1b6cff" strokeWidth="3" />}</g>); })}
        {p.pin && (() => { const c = proj(p.pin); return <g transform={`translate(${c.x},${c.y})`}><path d="M0 0C-12-14-12-26 0-26S12-14 0 0z" fill="#b3151b" stroke="#1b6cff" strokeWidth="3" /><circle cy="-17" r="4" fill="#fff" /><title>Dropped pin</title></g>; })()}
        {(p.hospitals ?? []).map((h) => { const c = proj(h); return (
          <g key={h.id} transform={`translate(${c.x},${c.y})`} onClick={(e) => { e.stopPropagation(); p.onSelect?.('hospital', h.id); }} style={{ cursor: 'pointer' }} tabIndex={0} role="button" aria-label={`${h.name}, ${h.status}`}
            onKeyDown={(e) => { if (e.key === 'Enter') p.onSelect?.('hospital', h.id); }}>
            <rect x="-15" y="-15" width="30" height="30" rx="7" fill={HC[h.tone]} stroke="#fff" strokeWidth="2" />{h.selected && <rect x="-19" y="-19" width="38" height="38" rx="9" fill="none" stroke="#1b6cff" strokeWidth="3" />}
            <text textAnchor="middle" y="5" fontSize="13" fontWeight="800" fill="#fff">H{HS[h.tone]}</text>
            <text y="30" textAnchor="middle" fontSize="11" fontWeight="700" fill="#0b2545" stroke="#fff" strokeWidth="3" paintOrder="stroke">{h.name.split(' ').slice(0, 2).join(' ')}</text><title>{`${h.name} — ${h.status}`}</title></g>); })}
        {(p.ambulances ?? []).map((a) => { const c = proj(a); return (
          <g key={a.id} transform={`translate(${c.x},${c.y})`} onClick={(e) => { e.stopPropagation(); p.onSelect?.('ambulance', a.id); }} style={{ cursor: 'pointer' }} tabIndex={0} role="button" aria-label={`${a.code}, ${a.status}`}
            onKeyDown={(e) => { if (e.key === 'Enter') p.onSelect?.('ambulance', a.id); }}>
            <circle r="14" fill={AC[a.tone]} stroke="#fff" strokeWidth="2" />{a.selected && <circle r="18" fill="none" stroke="#1b6cff" strokeWidth="3" />}
            <text textAnchor="middle" y="5" fontSize="13" fontWeight="800" fill="#fff">{a.warn ? '!' : 'A'}</text>
            <text y="-19" textAnchor="middle" fontSize="11" fontWeight="700" fill="#0b2545" stroke="#fff" strokeWidth="3" paintOrder="stroke">{a.code}</text><title>{`${a.code} — ${a.status}${a.warn ? ` — ${a.warn}` : ''}`}</title></g>); })}
      </svg>
      <div className="row" style={{ position: 'absolute', right: 8, bottom: 8, zIndex: 450 }}>
        <button className="iconbtn" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(6, z * 1.4))}>+</button>
        <button className="iconbtn" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.5, z / 1.4))}>−</button>
      </div>
    </div>
  );
}

export function MapLegend({ heat }: { heat?: boolean }) {
  const sw = (c: string, t: string) => <span className="row gap4"><span className="dot" style={{ background: c }} />{t}</span>;
  return (
    <div className="maplegend" aria-label="Map legend">
      <b>Hospitals</b>{sw(HC.green, '✓ accepting & eligible')}{sw(HC.yellow, '! limited / stale')}{sw(HC.red, '✕ diverting / ineligible')}
      <b>Ambulances</b>{sw(AC.blue, 'A available')}{sw(AC.orange, 'to pickup')}{sw(AC.purple, 'patient onboard')}{sw(AC.gray, 'offline')}
      {heat && <span className="muted">Shaded circles = ICU pressure</span>}
    </div>
  );
}
