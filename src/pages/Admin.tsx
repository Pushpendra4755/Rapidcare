import { useEffect, useMemo, useRef, useState } from 'react';
import { CAPABILITY_LABEL, EMERGENCY_LABEL } from '../lib/labels';
import { CAPABILITIES, EMERGENCY_TYPES, type Ambulance, type AuditLog, type Capability, type EmergencyCategory, type Hospital, type Role, type ServiceArea, type User } from '../lib/types';
import { useApp } from '../state/app';
import { MapLegend, MapView, type MapRoute } from '../components/MapView';
import { mapHeat, mapHospitals } from '../components/mapData';
import { Timeline } from '../components/Panels';
import { AcceptanceBadge, AmbulanceBadge, Banner, Btn, ConfirmDialog, Empty, Field, FreshnessBadge, GpsBadge, Icon, Modal, Spinner, fmtDateTime, fmtDur, fmtTime } from '../components/ui';
import { navigate } from '../state/router';
import { EtaChart } from './Incident';

type Tab = 'overview' | 'hospitals' | 'ambulances' | 'users' | 'categories' | 'areas' | 'settings' | 'audit' | 'playback';
const TABS: [Tab, string][] = [['overview', 'Overview'], ['hospitals', 'Hospitals'], ['ambulances', 'Ambulances'], ['users', 'Users & roles'], ['categories', 'Emergency categories'], ['areas', 'Service areas'], ['settings', 'Routing & escalation'], ['audit', 'Audit log'], ['playback', 'Incident playback']];

export function AdminPage({ initialTab = 'overview' }: { initialTab?: Tab }) {
  const { snap, user } = useApp();
  const [tab, setTab] = useState<Tab>(initialTab);
  if (!snap || !user) return <Spinner label="Loading admin console…" />;
  return (
    <div className="page">
      <div className="row between wrap"><h1>Administration</h1><span className="small muted">All changes are written to the audit log.</span></div>
      <div className="tabs" role="tablist" aria-label="Admin sections">{TABS.map(([t, l]) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{l}</button>)}</div>
      {tab === 'overview' && <Overview go={setTab} />}
      {tab === 'hospitals' && <HospitalsAdmin />}
      {tab === 'ambulances' && <AmbulancesAdmin />}
      {tab === 'users' && <UsersAdmin />}
      {tab === 'categories' && <CategoriesAdmin />}
      {tab === 'areas' && <AreasAdmin />}
      {tab === 'settings' && <SettingsAdmin />}
      {tab === 'audit' && <AuditLogView />}
      {tab === 'playback' && <Playback />}
    </div>
  );
}

// ------------------------------------------------------------------ overview
function Overview({ go }: { go: (t: Tab) => void }) {
  const { backend, token, snap } = useApp();
  if (!token || !snap) return null;
  const a = backend.getAnalytics(token);
  const maxType = Math.max(1, ...Object.values(a.activeByType));
  const maxReq = Math.max(1, ...a.perHospital.map((h) => h.total));
  return (
    <div className="col gap16">
      <div className="stats">
        <div className="stat"><div className="n" style={{ color: 'var(--green)' }}>✓</div><div className="l">System status: {a.systemStatus}{a.demoMode ? ' (demo)' : ''}</div></div>
        <div className="stat"><div className="n">{a.ambulances.online}<span className="small muted"> / {a.ambulances.online + a.ambulances.offline}</span></div><div className="l">Ambulances online · {a.ambulances.offline} offline{a.ambulances.gpsLost ? ` · ${a.ambulances.gpsLost} GPS lost` : ''}</div></div>
        <div className="stat"><div className="n">{a.avgAckSec != null ? fmtDur(a.avgAckSec) : '—'}</div><div className="l">Avg hospital acknowledgement time</div></div>
        <div className="stat"><div className="n">{a.avgResponseSec != null ? fmtDur(a.avgResponseSec) : '—'}</div><div className="l">Avg response time (created → at pickup)</div></div>
        <div className="stat"><div className="n">{a.avgHandoverSec != null ? fmtDur(a.avgHandoverSec) : '—'}</div><div className="l">Avg handover time (arrival → handover)</div></div>
      </div>
      <div className="grid2">
        <section className="card"><h3>Capacity data freshness</h3>
          <div className="row wrap mt8">{(['LIVE', 'RECENT', 'STALE', 'UNAVAILABLE'] as const).map((f) => <div key={f} className="row"><FreshnessBadge f={f} /><b>{a.capacityFreshness[f]}</b></div>)}</div>
          <div className="tablewrap mt12"><table className="t"><thead><tr><th>Hospital</th><th>Status</th><th>Freshness</th><th>Last verified</th></tr></thead><tbody>
            {snap.hospitals.map((h) => { const s = snap.resourceStatus[h.id]; return <tr key={h.id}><td>{h.name}</td><td><AcceptanceBadge s={s.acceptanceStatus} /></td><td><FreshnessBadge f={s.freshness} age={s.ageMinutes} /></td><td>{s.lastVerifiedAt ? fmtTime(s.lastVerifiedAt) : 'never'}</td></tr>; })}</tbody></table></div></section>
        <section className="card"><h3>Alerts requiring escalation</h3>
          {a.escalations.length === 0 ? <Empty>No incidents currently need escalation.</Empty> : <ul className="why">{a.escalations.map((e) => <li key={e.id}><a href={`#/app/incident/${e.id}`}>{e.code}</a> — {e.severity.toLowerCase()}{e.level ? `, escalated (level ${e.level})` : ', no hospital request yet'}</li>)}</ul>}
          <p className="small mt8"><b>{a.openAlerts}</b> unacknowledged notifications · <b>{a.totals.active}</b> active of {a.totals.incidents} incidents</p></section>
      </div>
      <div className="grid2">
        <section className="card"><h3>Active incident volume by emergency type</h3>
          <div className="col mt8" role="list" aria-label="Active incidents by type">{EMERGENCY_TYPES.map((t) => (
            <div key={t} role="listitem" className="row"><span style={{ width: 100 }} className="small">{EMERGENCY_LABEL[t]}</span><div className="bar grow" style={{ height: 14 }}><i style={{ width: `${(a.activeByType[t] / maxType) * 100}%` }} /></div><b style={{ width: 24, textAlign: 'right' }}>{a.activeByType[t]}</b></div>))}</div></section>
        <section className="card"><h3>Hospital acceptance / decline trends</h3>
          <div className="tablewrap mt8"><table className="t"><thead><tr><th>Hospital</th><th>Accepted</th><th>Declined</th><th>No response</th><th>Accept rate</th></tr></thead><tbody>
            {a.perHospital.map((h) => <tr key={h.hospitalId}><td>{h.name}</td><td>{h.accepted}</td><td>{h.declined}</td><td>{h.noResponse}</td><td><div className="row"><div className="bar grow" style={{ width: 70 }}><i style={{ width: `${h.total ? (h.accepted / h.total) * 100 : 0}%`, background: 'var(--green)' }} /></div>{h.total ? Math.round((h.accepted / h.total) * 100) : 0}%</div></td></tr>)}</tbody></table></div>
          <p className="xs muted mt8">Max requests per hospital: {maxReq}</p></section>
      </div>
      <section className="card"><h3>Regional ICU capacity</h3>
        <div className="mapbox" style={{ height: 380, marginTop: 8 }}><MapView hospitals={mapHospitals(snap.hospitals, snap.resourceStatus, undefined)} heat={mapHeat(snap.hospitals, snap.resourceStatus)} zones={snap.serviceAreas} fitKey="admin" /><MapLegend heat /></div></section>
      <div className="row wrap"><Btn kind="secondary" onClick={() => go('audit')}>Open audit log</Btn><Btn kind="secondary" onClick={() => go('playback')}>Incident playback</Btn><Btn kind="secondary" onClick={() => navigate('/app/dispatch')}>Operations dashboard</Btn></div>
    </div>
  );
}

// ------------------------------------------------------------------ hospitals
function HospitalsAdmin() {
  const { snap, call, backend } = useApp();
  const [edit, setEdit] = useState<Partial<Hospital> | null>(null);
  const [del, setDel] = useState<Hospital | null>(null);
  if (!snap) return null;
  return (
    <section className="col">
      <div className="row between"><h2>Hospitals, capabilities &amp; resource totals</h2><Btn icon="plus" onClick={() => setEdit({ status: 'ONLINE', lat: 12.9716, lng: 77.5946, totalErBeds: 4, totalIcuBeds: 2, totalVentilators: 2, totalTraumaBays: 0, totalIsolationBeds: 1, capabilities: Object.fromEntries(CAPABILITIES.map((c) => [c, false])) as Hospital['capabilities'] })}>Add hospital</Btn></div>
      <div className="tablewrap"><table className="t"><thead><tr><th>Name</th><th>Zone</th><th>Totals (ER/ICU/Vent/Trauma/Iso)</th><th>Capabilities</th><th>Contact</th><th>Status</th><th /></tr></thead><tbody>
        {snap.hospitals.map((h) => <tr key={h.id}><td><b>{h.name}</b><div className="xs muted">{h.address}</div></td><td>{snap.serviceAreas.find((z) => z.id === h.regionId)?.name ?? h.regionId}</td>
          <td>{h.totalErBeds}/{h.totalIcuBeds}/{h.totalVentilators}/{h.totalTraumaBays}/{h.totalIsolationBeds}</td>
          <td>{CAPABILITIES.filter((c) => h.capabilities[c]).map((c) => <span key={c} className="badge b-navy" style={{ marginRight: 3 }}>{CAPABILITY_LABEL[c]}</span>)}</td><td>{h.emergencyContact}</td>
          <td><span className={`badge ${h.status === 'ONLINE' ? 'b-green' : 'b-gray'}`}>{h.status}</span></td>
          <td><div className="row"><Btn size="sm" kind="secondary" onClick={() => setEdit(h)}>Edit</Btn><Btn size="sm" kind="ghost" onClick={() => setDel(h)}>Delete</Btn></div></td></tr>)}</tbody></table></div>
      {edit && <HospitalForm initial={edit} onClose={() => setEdit(null)} />}
      {del && <ConfirmDialog title={`Delete ${del.name}?`} danger confirmText="Delete" onCancel={() => setDel(null)} onConfirm={async () => { const r = await call((t) => backend.deleteHospital(t, del.id), { ok: 'Hospital deleted.' }); if (r.ok) setDel(null); }}><p>Hospitals with incident history cannot be deleted; set them to OFFLINE instead.</p></ConfirmDialog>}
    </section>
  );
}

function HospitalForm({ initial, onClose }: { initial: Partial<Hospital>; onClose: () => void }) {
  const { call, backend, snap } = useApp();
  const [f, setF] = useState<Partial<Hospital>>({ ...initial, capabilities: { ...(initial.capabilities as Hospital['capabilities']) } });
  const [err, setErr] = useState<Record<string, string>>({});
  const set = <K extends keyof Hospital>(k: K, v: Hospital[K]) => setF((x) => ({ ...x, [k]: v }));
  const num = (k: keyof Hospital) => <input type="number" min={0} value={String(f[k] ?? 0)} onChange={(e) => set(k, Number(e.target.value) as never)} />;
  const save = async () => { const r = await call((t) => backend.upsertHospital(t, { ...(f as Hospital), name: f.name ?? '' }), { ok: 'Hospital saved.' }); if (r.ok) onClose(); else setErr(r.fields ?? {}); };
  return (
    <Modal title={f.id ? `Edit ${f.name}` : 'Add hospital'} onClose={onClose} footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn onClick={save}>Save hospital</Btn></>}>
      <div className="grid2"><Field label="Name" error={err.name}><input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} /></Field><Field label="Address" error={err.address}><input value={f.address ?? ''} onChange={(e) => set('address', e.target.value)} /></Field></div>
      <div className="grid2"><Field label="Latitude" error={err.lat}><input type="number" step="0.0001" value={f.lat ?? ''} onChange={(e) => set('lat', Number(e.target.value))} /></Field><Field label="Longitude" error={err.lng}><input type="number" step="0.0001" value={f.lng ?? ''} onChange={(e) => set('lng', Number(e.target.value))} /></Field></div>
      <div className="grid2"><Field label="Emergency entrance latitude" error={err.entranceLat} hint="Routes end here."><input type="number" step="0.0001" value={f.entranceLat ?? f.lat ?? ''} onChange={(e) => set('entranceLat', Number(e.target.value))} /></Field><Field label="Emergency entrance longitude" error={err.entranceLng}><input type="number" step="0.0001" value={f.entranceLng ?? f.lng ?? ''} onChange={(e) => set('entranceLng', Number(e.target.value))} /></Field></div>
      <div className="grid2"><Field label="Phone"><input value={f.phone ?? ''} onChange={(e) => set('phone', e.target.value)} /></Field><Field label="Operational fallback contact number" error={err.emergencyContact}><input value={f.emergencyContact ?? ''} onChange={(e) => set('emergencyContact', e.target.value)} /></Field></div>
      <div className="grid3"><Field label="Total ER beds" error={err.totalErBeds}>{num('totalErBeds')}</Field><Field label="Total ICU beds" error={err.totalIcuBeds}>{num('totalIcuBeds')}</Field><Field label="Total ventilators" error={err.totalVentilators}>{num('totalVentilators')}</Field>
        <Field label="Total trauma bays" error={err.totalTraumaBays}>{num('totalTraumaBays')}</Field><Field label="Total isolation beds" error={err.totalIsolationBeds}>{num('totalIsolationBeds')}</Field>
        <Field label="Service area"><select value={f.regionId ?? ''} onChange={(e) => set('regionId', e.target.value)}><option value="">Auto from location</option>{snap?.serviceAreas.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}</select></Field></div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ fontWeight: 600 }}>Emergency capabilities</legend><div className="grid3">{CAPABILITIES.map((c: Capability) => <label key={c} className={`chk ${f.capabilities?.[c] ? 'on' : ''}`}><input type="checkbox" checked={!!f.capabilities?.[c]} onChange={(e) => setF((x) => ({ ...x, capabilities: { ...(x.capabilities as Hospital['capabilities']), [c]: e.target.checked } }))} />{CAPABILITY_LABEL[c]}</label>)}</div></fieldset>
      <Field label="Hospital status"><select value={f.status ?? 'ONLINE'} onChange={(e) => set('status', e.target.value as Hospital['status'])}><option>ONLINE</option><option>OFFLINE</option></select></Field>
    </Modal>
  );
}

// ------------------------------------------------------------------ ambulances
function AmbulancesAdmin() {
  const { snap, call, backend } = useApp();
  const [edit, setEdit] = useState<Partial<Ambulance> | null>(null);
  const [del, setDel] = useState<Ambulance | null>(null);
  if (!snap) return null;
  return (
    <section className="col">
      <div className="row between"><h2>Ambulances</h2><Btn icon="plus" onClick={() => setEdit({ vehicleType: 'ALS' })}>Add ambulance</Btn></div>
      <div className="tablewrap"><table className="t"><thead><tr><th>Code</th><th>Type</th><th>Operator</th><th>Status</th><th>GPS</th><th /></tr></thead><tbody>
        {snap.ambulances.map((a) => <tr key={a.id}><td><b>{a.code}</b></td><td>{a.vehicleType}</td><td>{a.operatorName}</td><td><AmbulanceBadge s={a.status} /></td><td><GpsBadge f={a.gpsFreshness} age={a.gpsAgeSeconds} /></td>
          <td><div className="row"><Btn size="sm" kind="secondary" onClick={() => setEdit(a)}>Edit</Btn><Btn size="sm" kind="ghost" onClick={() => setDel(a)}>Delete</Btn></div></td></tr>)}</tbody></table></div>
      {edit && <AmbForm initial={edit} onClose={() => setEdit(null)} />}
      {del && <ConfirmDialog title={`Delete ${del.code}?`} danger confirmText="Delete" onCancel={() => setDel(null)} onConfirm={async () => { const r = await call((t) => backend.deleteAmbulance(t, del.id), { ok: 'Ambulance deleted.' }); if (r.ok) setDel(null); }}><p>Ambulances with incident history cannot be deleted; take them off duty instead.</p></ConfirmDialog>}
    </section>
  );
}
function AmbForm({ initial, onClose }: { initial: Partial<Ambulance>; onClose: () => void }) {
  const { call, backend } = useApp();
  const [f, setF] = useState({ id: initial.id, code: initial.code ?? '', vehicleType: (initial.vehicleType ?? 'ALS') as Ambulance['vehicleType'], operatorName: initial.operatorName ?? '' });
  const [err, setErr] = useState<Record<string, string>>({});
  return (
    <Modal title={f.id ? `Edit ${f.code}` : 'Add ambulance'} small onClose={onClose} footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn onClick={async () => { const r = await call((t) => backend.upsertAmbulance(t, f), { ok: 'Ambulance saved.' }); if (r.ok) onClose(); else setErr(r.fields ?? {}); }}>Save</Btn></>}>
      <Field label="Ambulance code" error={err.code}><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="AMB-006" /></Field>
      <Field label="Vehicle type" error={err.vehicleType}><select value={f.vehicleType} onChange={(e) => setF({ ...f, vehicleType: e.target.value as Ambulance['vehicleType'] })}><option value="ALS">ALS</option><option value="BLS">BLS</option><option value="NEONATAL_TRANSPORT">Neonatal transport</option></select></Field>
      <Field label="Operator" error={err.operatorName}><input value={f.operatorName} onChange={(e) => setF({ ...f, operatorName: e.target.value })} /></Field>
    </Modal>
  );
}

// ------------------------------------------------------------------ users
function UsersAdmin() {
  const { backend, token, snap, call, user: me } = useApp();
  const [edit, setEdit] = useState<Partial<User> | null>(null);
  const [temp, setTemp] = useState<string | null>(null);
  if (!token || !snap) return null;
  const users = backend.listUsers(token);
  return (
    <section className="col">
      <div className="row between"><h2>Users &amp; roles</h2><Btn icon="plus" onClick={() => setEdit({ role: 'DISPATCHER', active: true })}>Add user</Btn></div>
      {temp && <Banner kind="ok">User created. One-time temporary password: <b className="mono">{temp}</b> (shown once; not stored in readable form).</Banner>}
      <div className="tablewrap"><table className="t"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Linked to</th><th>Active</th><th /></tr></thead><tbody>
        {users.map((u) => <tr key={u.id}><td><b>{u.fullName}</b></td><td>{u.email}</td><td><span className="badge b-navy">{u.role.replace('_', ' ')}</span></td>
          <td>{u.hospitalId ? snap.hospitals.find((h) => h.id === u.hospitalId)?.name : u.ambulanceId ? snap.ambulances.find((a) => a.id === u.ambulanceId)?.code : '—'}</td>
          <td>{u.active ? <span className="badge b-green">ACTIVE</span> : <span className="badge b-gray">DISABLED</span>}</td><td><Btn size="sm" kind="secondary" onClick={() => setEdit(u)} disabled={u.id === me?.id && false}>Edit</Btn></td></tr>)}</tbody></table></div>
      {edit && <UserForm initial={edit} onClose={() => setEdit(null)} onTemp={setTemp} call={call} />}
    </section>
  );
}
function UserForm({ initial, onClose, onTemp, call }: { initial: Partial<User>; onClose: () => void; onTemp: (p: string | null) => void; call: ReturnType<typeof useApp>['call'] }) {
  const { backend, snap } = useApp();
  const [f, setF] = useState({ id: initial.id, fullName: initial.fullName ?? '', email: initial.email ?? '', role: (initial.role ?? 'DISPATCHER') as Role, hospitalId: initial.hospitalId ?? '', ambulanceId: initial.ambulanceId ?? '', active: initial.active ?? true, password: '' });
  const [err, setErr] = useState<Record<string, string>>({});
  return (
    <Modal title={f.id ? 'Edit user' : 'Add user'} onClose={onClose} footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn onClick={async () => {
      const r = await call((t) => backend.upsertUser(t, { ...f, hospitalId: f.hospitalId || null, ambulanceId: f.ambulanceId || null }), { ok: 'User saved.' });
      if (r.ok) { onTemp(r.value?.tempPassword ?? null); onClose(); } else setErr(r.fields ?? {}); }}>Save user</Btn></>}>
      <div className="grid2"><Field label="Full name" error={err.fullName}><input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field><Field label="Email" error={err.email}><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field></div>
      <div className="grid2"><Field label="Role" error={err.role}><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}>{(['ADMIN', 'DISPATCHER', 'HOSPITAL_STAFF', 'AMBULANCE_CREW'] as Role[]).map((r) => <option key={r}>{r}</option>)}</select></Field>
        <Field label="Status"><select value={f.active ? '1' : '0'} onChange={(e) => setF({ ...f, active: e.target.value === '1' })}><option value="1">Active</option><option value="0">Disabled</option></select></Field></div>
      {f.role === 'HOSPITAL_STAFF' && <Field label="Hospital" error={err.hospitalId}><select value={f.hospitalId} onChange={(e) => setF({ ...f, hospitalId: e.target.value })}><option value="">Select…</option>{snap?.hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select></Field>}
      {f.role === 'AMBULANCE_CREW' && <Field label="Ambulance" error={err.ambulanceId}><select value={f.ambulanceId} onChange={(e) => setF({ ...f, ambulanceId: e.target.value })}><option value="">Select…</option>{snap?.ambulances.map((a) => <option key={a.id} value={a.id}>{a.code}</option>)}</select></Field>}
      <Field label={f.id ? 'New password (leave blank to keep)' : 'Initial password (blank = generate)'} error={err.password} hint="Minimum 10 characters."><input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
    </Modal>
  );
}

// ------------------------------------------------------------------ categories & areas
function CategoriesAdmin() {
  const { snap, call, backend } = useApp();
  if (!snap) return null;
  return (
    <section className="col"><h2>Emergency categories</h2><p className="small muted">Defaults pre-fill the Create emergency form. Disabling a category hides it from dispatchers.</p>
      <div className="tablewrap"><table className="t"><thead><tr><th>Category</th><th>Label</th><th>Default specialty</th><th>Default resources</th><th>Active</th></tr></thead><tbody>
        {snap.categories.map((c) => <CategoryRow key={c.id} c={c} onSave={(patch) => call((t) => backend.upsertCategory(t, { ...c, ...patch }), { ok: 'Category saved.' })} />)}</tbody></table></div></section>
  );
}
function CategoryRow({ c, onSave }: { c: EmergencyCategory; onSave: (p: Partial<EmergencyCategory>) => unknown }) {
  const [label, setLabel] = useState(c.label);
  return (<tr><td className="mono">{c.id}</td><td><input className="inp" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => label !== c.label && onSave({ label })} aria-label={`Label for ${c.id}`} /></td>
    <td>{c.defaultCapabilities.map((x) => CAPABILITY_LABEL[x]).join(', ') || '—'}</td><td>{c.defaultResources.join(', ').replace(/_/g, ' ').toLowerCase()}</td>
    <td><input type="checkbox" checked={c.active} onChange={(e) => onSave({ active: e.target.checked })} aria-label={`${c.id} active`} /></td></tr>);
}

function AreasAdmin() {
  const { snap, call, backend } = useApp();
  const [edit, setEdit] = useState<Partial<ServiceArea> | null>(null);
  if (!snap) return null;
  return (
    <section className="col">
      <div className="row between"><h2>Service areas</h2><Btn icon="plus" onClick={() => setEdit({ bounds: [12.9, 77.5, 13.0, 77.6], neighbors: [] })}>Add area</Btn></div>
      <Banner kind="info">When “Restrict recommendations to service area” is on (Routing &amp; escalation), hospitals outside the incident’s zone and its neighbours are not eligible.</Banner>
      <div className="tablewrap"><table className="t"><thead><tr><th>Name</th><th>Bounds (S, W, N, E)</th><th>Neighbours</th><th>Hospitals</th><th /></tr></thead><tbody>
        {snap.serviceAreas.map((z) => <tr key={z.id}><td><b>{z.name}</b></td><td className="mono">{z.bounds.join(', ')}</td><td>{z.neighbors.map((n) => snap.serviceAreas.find((x) => x.id === n)?.name).join(', ') || '—'}</td>
          <td>{snap.hospitals.filter((h) => h.regionId === z.id).map((h) => h.name).join(', ') || '—'}</td>
          <td><div className="row"><Btn size="sm" kind="secondary" onClick={() => setEdit(z)}>Edit</Btn><Btn size="sm" kind="ghost" onClick={() => call((t) => backend.deleteServiceArea(t, z.id), { ok: 'Area deleted.' })}>Delete</Btn></div></td></tr>)}</tbody></table></div>
      {edit && <AreaForm initial={edit} onClose={() => setEdit(null)} />}
    </section>
  );
}
function AreaForm({ initial, onClose }: { initial: Partial<ServiceArea>; onClose: () => void }) {
  const { snap, call, backend } = useApp();
  const [name, setName] = useState(initial.name ?? '');
  const [b, setB] = useState<number[]>(initial.bounds ?? [0, 0, 0, 0]);
  const [nb, setNb] = useState<string[]>(initial.neighbors ?? []);
  const [err, setErr] = useState<Record<string, string>>({});
  return (
    <Modal title={initial.id ? 'Edit service area' : 'Add service area'} onClose={onClose} footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn onClick={async () => { const r = await call((t) => backend.upsertServiceArea(t, { id: initial.id ?? '', name, bounds: b as ServiceArea['bounds'], neighbors: nb }), { ok: 'Service area saved.' }); if (r.ok) onClose(); else setErr(r.fields ?? {}); }}>Save</Btn></>}>
      <Field label="Name" error={err.name}><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="grid2">{['South latitude', 'West longitude', 'North latitude', 'East longitude'].map((l, i) => <Field key={l} label={l} error={i === 0 ? err.bounds : undefined}><input type="number" step="0.001" value={b[i]} onChange={(e) => setB(b.map((x, j) => (j === i ? Number(e.target.value) : x)))} /></Field>)}</div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ fontWeight: 600 }}>Neighbouring areas</legend><div className="grid3">{snap?.serviceAreas.filter((z) => z.id !== initial.id).map((z) => <label key={z.id} className={`chk ${nb.includes(z.id) ? 'on' : ''}`}><input type="checkbox" checked={nb.includes(z.id)} onChange={(e) => setNb(e.target.checked ? [...nb, z.id] : nb.filter((x) => x !== z.id))} />{z.name}</label>)}</div></fieldset>
    </Modal>
  );
}

// ------------------------------------------------------------------ settings
function SettingsAdmin() {
  const { snap, call, backend } = useApp();
  const cfg = snap?.config;
  const [f, setF] = useState<Record<string, number | boolean>>({});
  const [err, setErr] = useState<Record<string, string>>({});
  useEffect(() => { if (cfg) setF({ wResource: cfg.weights!.resource, wSpecialty: cfg.weights!.specialty, wEta: cfg.weights!.eta, wFresh: cfg.weights!.freshness, wWork: cfg.weights!.workload,
    liveMinutes: cfg.liveMinutes!, recentMinutes: cfg.recentMinutes!, ineligibleAfterMinutes: cfg.ineligibleAfterMinutes!, staleMultiplier: cfg.staleMultiplier!, limitedMultiplier: cfg.limitedMultiplier!, etaCapMinutes: cfg.etaCapMinutes!,
    ackTimeoutSec: cfg.ackTimeoutSec!, decisionTimeoutSec: cfg.decisionTimeoutSec!, gpsStaleSec: cfg.gpsStaleSec!, gpsLostSec: cfg.gpsLostSec!, escalateCriticalAfterSec: cfg.escalateCriticalAfterSec!,
    restrictToServiceArea: cfg.restrictToServiceArea!, notifyAdminsOnEscalation: cfg.notifyAdminsOnEscalation!, sessionIdleMinutes: cfg.sessionIdleMinutes! }); }, [cfg]);
  if (!cfg || f.wResource === undefined) return null;
  const n = (k: string, label: string, step = 1, hint?: string) => <Field label={label} error={err[k]} hint={hint}><input type="number" step={step} value={String(f[k])} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} /></Field>;
  const total = Number(f.wResource) + Number(f.wSpecialty) + Number(f.wEta) + Number(f.wFresh) + Number(f.wWork);
  const save = async () => {
    const r = await call((t) => backend.updateConfig(t, {
      weights: { resource: Number(f.wResource), specialty: Number(f.wSpecialty), eta: Number(f.wEta), freshness: Number(f.wFresh), workload: Number(f.wWork) },
      liveMinutes: Number(f.liveMinutes), recentMinutes: Number(f.recentMinutes), ineligibleAfterMinutes: Number(f.ineligibleAfterMinutes), staleMultiplier: Number(f.staleMultiplier), limitedMultiplier: Number(f.limitedMultiplier), etaCapMinutes: Number(f.etaCapMinutes),
      ackTimeoutSec: Number(f.ackTimeoutSec), decisionTimeoutSec: Number(f.decisionTimeoutSec), gpsStaleSec: Number(f.gpsStaleSec), gpsLostSec: Number(f.gpsLostSec), escalateCriticalAfterSec: Number(f.escalateCriticalAfterSec),
      restrictToServiceArea: !!f.restrictToServiceArea, notifyAdminsOnEscalation: !!f.notifyAdminsOnEscalation, sessionIdleMinutes: Number(f.sessionIdleMinutes) }), { ok: 'Configuration saved; recommendations recalculated.' });
    setErr(r.ok ? {} : r.fields ?? {});
  };
  return (
    <section className="col gap16">
      <h2>Routing, scoring &amp; escalation</h2>
      <Banner kind="info">Medical eligibility filters always run before scoring; weights only rank hospitals that are already eligible. Weights are normalised, so they need not sum to 1 (currently {total.toFixed(2)}).</Banner>
      <div className="card col"><h3>Scoring weights</h3><div className="grid3">{n('wResource', 'Resource availability', 0.05)}{n('wSpecialty', 'Specialty / capability', 0.05)}{n('wEta', 'ETA', 0.05)}{n('wFresh', 'Capacity freshness', 0.05)}{n('wWork', 'Lower workload', 0.05)}{n('etaCapMinutes', 'ETA at which score reaches 0 (min)')}</div></div>
      <div className="card col"><h3>Freshness &amp; penalties</h3><div className="grid3">{n('liveMinutes', 'LIVE within (min)')}{n('recentMinutes', 'RECENT within (min)')}{n('ineligibleAfterMinutes', 'Ineligible when older than (min)')}{n('staleMultiplier', 'Stale score multiplier', 0.05)}{n('limitedMultiplier', 'Limited-capacity multiplier', 0.05)}
        {n('gpsStaleSec', 'GPS STALE after (s)')}{n('gpsLostSec', 'GPS LOST after (s)')}</div></div>
      <div className="card col"><h3>Notification escalation</h3><div className="grid3">{n('ackTimeoutSec', 'Hospital acknowledgement timeout (s)')}{n('decisionTimeoutSec', 'Decision timeout after acknowledgement (s)')}{n('escalateCriticalAfterSec', 'Critical incident with no hospital request (s)')}{n('sessionIdleMinutes', 'Session idle timeout (min)')}</div>
        <label className="chk"><input type="checkbox" checked={!!f.notifyAdminsOnEscalation} onChange={(e) => setF({ ...f, notifyAdminsOnEscalation: e.target.checked })} />Notify administrators on escalation</label>
        <label className="chk"><input type="checkbox" checked={!!f.restrictToServiceArea} onChange={(e) => setF({ ...f, restrictToServiceArea: e.target.checked })} />Restrict recommendations to the incident’s service area and its neighbours</label></div>
      <div className="card"><h3>Routing provider</h3><p className="small muted">Currently: <b>{backend.ctx.routing.name}</b>. Set <span className="mono">VITE_ROUTING_PROVIDER</span> and the server-side proxy as described in the README to switch to Google, Mapbox or OpenRouteService.</p></div>
      <div><Btn onClick={save}>Save configuration</Btn></div>
    </section>
  );
}

// ------------------------------------------------------------------ audit
function AuditLogView() {
  const { backend, token, snap } = useApp();
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [open, setOpen] = useState<AuditLog | null>(null);
  const rows = useMemo(() => (token ? backend.getAuditLogs(token, { q, action: action || undefined, limit: 300 }) : []), [backend, token, q, action, snap?.serverTime]); // eslint-disable-line react-hooks/exhaustive-deps
  const actions = useMemo(() => [...new Set((token ? backend.getAuditLogs(token, { limit: 1000 }) : []).map((r) => r.actionType))].sort(), [backend, token, snap?.serverTime]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="col">
      <div className="row between wrap"><h2>Audit log</h2><span className="small muted">Append-only · {rows.length} shown</span></div>
      <div className="row wrap"><input className="inp" style={{ maxWidth: 300 }} placeholder="Search actor, entity, value…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search audit log" />
        <select className="inp" style={{ maxWidth: 260 }} value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action"><option value="">All actions</option>{actions.map((a) => <option key={a}>{a}</option>)}</select></div>
      <div className="tablewrap" style={{ maxHeight: 620 }}><table className="t"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th /></tr></thead><tbody>
        {rows.length === 0 && <tr><td colSpan={5}><Empty>No matching entries.</Empty></td></tr>}
        {rows.map((r) => <tr key={r.id}><td className="mono xs">{fmtDateTime(r.createdAt)}</td><td>{r.actorLabel}</td><td><span className={`badge ${/OVERRIDE|DECLINE|FAILED|DELETE|RESET/.test(r.actionType) ? 'b-amber' : /SENSITIVE/.test(r.actionType) ? 'b-purple' : 'b-navy'}`}>{r.actionType}</span></td>
          <td className="small">{r.entityType} <span className="mono xs muted">{r.entityId}</span></td><td><Btn size="sm" kind="ghost" onClick={() => setOpen(r)}>Details</Btn></td></tr>)}</tbody></table></div>
      {open && <Modal title={`${open.actionType} — ${fmtDateTime(open.createdAt)}`} onClose={() => setOpen(null)}>
        <div className="grid2"><div><h4>Previous value</h4><pre className="mono xs" style={{ whiteSpace: 'pre-wrap', background: 'var(--navy-50)', padding: 8, borderRadius: 6, maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(open.previousValue, null, 2) ?? 'null'}</pre></div>
          <div><h4>New value</h4><pre className="mono xs" style={{ whiteSpace: 'pre-wrap', background: 'var(--navy-50)', padding: 8, borderRadius: 6, maxHeight: 320, overflow: 'auto' }}>{JSON.stringify(open.newValue, null, 2) ?? 'null'}</pre></div></div></Modal>}
    </section>
  );
}

// ------------------------------------------------------------------ playback
function Playback() {
  const { backend, token, snap } = useApp();
  const closed = (snap?.incidents ?? []).filter((i) => !['NEW'].includes(i.status));
  const [id, setId] = useState(() => closed.find((i) => backend.getPlayback(token!, i.id).trail.length > 3)?.id ?? closed[0]?.id ?? '');
  const [pos, setPos] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(8);
  const data = useMemo(() => (token && id ? backend.getPlayback(token, id) : null), [backend, token, id]);
  const t0 = data?.trail.length ? Date.parse(data.trail[0].recordedAt) : data?.timeline.length ? Date.parse(data.timeline[0].at) : 0;
  const t1 = data?.trail.length ? Date.parse(data.trail[data.trail.length - 1].recordedAt) : data?.timeline.length ? Date.parse(data.timeline[data.timeline.length - 1].at) : 1;
  const span = Math.max(1, t1 - t0);
  const raf = useRef<number | null>(null);
  useEffect(() => { setPos(0); setPlaying(false); }, [id]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const loop = (t: number) => { const dt = t - last; last = t; setPos((p) => { const n = p + (dt * speed) / span; if (n >= 1) { setPlaying(false); return 1; } return n; }); raf.current = requestAnimationFrame(loop); };
    raf.current = requestAnimationFrame(loop);
    return () => { if (raf.current) cancelAnimationFrame(raf.current); };
  }, [playing, speed, span]);
  if (!snap || !token) return null;
  const tNow = t0 + pos * span;
  const trailSoFar = data?.trail.filter((p) => Date.parse(p.recordedAt) <= tNow) ?? [];
  const last = trailSoFar[trailSoFar.length - 1];
  const events = data?.timeline.filter((e) => Date.parse(e.at) <= tNow) ?? [];
  const hosp = data?.incident.selectedHospitalId;
  const routes: MapRoute[] = trailSoFar.length > 1 ? [{ id: 't', kind: 'hospital', points: trailSoFar.map((p) => ({ lat: p.lat, lng: p.lng })), label: 'Replayed path' }] : [];
  return (
    <section className="col">
      <h2>Incident playback <span className="badge b-purple">TRAINING / DEMO</span></h2>
      <div className="row wrap"><select className="inp" style={{ maxWidth: 360 }} value={id} onChange={(e) => setId(e.target.value)} aria-label="Incident to replay">{closed.map((i) => <option key={i.id} value={i.id}>{i.incidentCode} — {EMERGENCY_LABEL[i.emergencyType]} ({i.status.toLowerCase().replace(/_/g, ' ')})</option>)}</select>
        <Btn onClick={() => { if (pos >= 1) setPos(0); setPlaying((p) => !p); }} icon="play">{playing ? 'Pause' : pos >= 1 ? 'Replay' : 'Play'}</Btn>
        <label className="small row">Speed<select className="inp" style={{ width: 'auto', minHeight: 32 }} value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>{[1, 4, 8, 20, 60].map((s) => <option key={s} value={s}>{s}×</option>)}</select></label></div>
      <input type="range" min={0} max={1000} value={Math.round(pos * 1000)} onChange={(e) => { setPlaying(false); setPos(Number(e.target.value) / 1000); }} aria-label="Playback position" style={{ width: '100%' }} />
      <div className="small muted">{fmtTime(new Date(tNow).toISOString())} of {fmtTime(new Date(t1).toISOString())} · {trailSoFar.length}/{data?.trail.length ?? 0} GPS points</div>
      {data && !data.trail.length && <Banner kind="info">This incident has no recorded GPS trail — the timeline replays without map movement. Run a live trip to create one.</Banner>}
      <div className="grid2" style={{ gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)' }}>
        <div className="mapbox" style={{ height: 420 }}><MapView hospitals={mapHospitals(snap.hospitals, snap.resourceStatus, undefined, hosp)} ambulances={last ? [{ id: 'pb', code: 'Replay', lat: last.lat, lng: last.lng, tone: 'purple', status: `${last.speedKmph} km/h`, selected: true }] : []} routes={routes} pickups={data?.incident.pickupLat != null ? [{ id: 'p', lat: data.incident.pickupLat, lng: data.incident.pickupLng!, label: data.incident.incidentCode }] : []} fitKey={`pb-${id}`} /><MapLegend /></div>
        <div className="card" style={{ maxHeight: 420, overflow: 'auto' }}><h3>Timeline</h3><Timeline events={events} /></div>
      </div>
      <div className="card"><h3>ETA history</h3><EtaChart points={data?.etaHistory ?? []} /></div>
    </section>
  );
}
