import { useMemo, useState } from 'react';
import { AGE_LABEL, CALLER_CONSENT_TEXT, CAPABILITY_LABEL, EMERGENCY_LABEL, RESOURCE_LABEL, SEVERITY_LABEL } from '../lib/labels';
import { AGE_GROUPS, CAPABILITIES, EMERGENCY_TYPES, RESOURCES, SEVERITIES, type AgeGroup, type Capability, type EmergencyType, type LatLng, type PickupSource, type ResourceKey, type Severity } from '../lib/types';
import { GAZETTEER } from '../server/seed';
import { geocodeDemo } from '../server/workflows';
import { useApp } from '../state/app';
import { MapView, MapLegend } from './MapView';
import { Banner, Btn, Field, Icon, Modal, SeverityBadge } from './ui';

export function CreateEmergencyModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { snap, call, backend, toast } = useApp();
  const [type, setType] = useState<EmergencyType>('TRAUMA');
  const [severity, setSeverity] = useState<Severity>('CRITICAL');
  const [age, setAge] = useState<AgeGroup>('ADULT');
  const [resources, setResources] = useState<ResourceKey[]>(['TRAUMA_BAY', 'ICU_BED']);
  const [specialty, setSpecialty] = useState<Capability | ''>('');
  const [method, setMethod] = useState<PickupSource>('MAP_PIN');
  const [address, setAddress] = useState('');
  const [pin, setPin] = useState<LatLng | null>(null);
  const [caller, setCaller] = useState<LatLng | null>(null);
  const [consent, setConsent] = useState(false);
  const [notes, setNotes] = useState('');
  const [ambulanceId, setAmbulanceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const nextCode = useMemo(() => `INC-2026-${(backend.ctx.db.seq.inc ?? 1000) + 1}`, [backend]);
  const cats = snap?.categories.filter((c) => c.active) ?? [];
  const available = (snap?.ambulances ?? []).filter((a) => a.status === 'AVAILABLE');
  const geo = method === 'ADDRESS' ? geocodeDemo(address) : null;
  const preview: LatLng | null = method === 'MAP_PIN' ? pin : method === 'CALLER_SHARED' ? (consent ? caller : null) : geo;

  const chooseType = (t: EmergencyType) => {
    setType(t);
    const c = snap?.categories.find((x) => x.id === t);
    if (c) { setResources(c.defaultResources); setSpecialty(c.defaultCapabilities[0] ?? ''); }
    if (t === 'PEDIATRIC') setAge('CHILD');
    if (t === 'OBSTETRIC') setAge('ADULT');
  };
  const toggle = (r: ResourceKey) => setResources((x) => (x.includes(r) ? x.filter((y) => y !== r) : [...x, r]));

  // Simulated caller-shared location (demo): a point near the centre. Only generated after explicit consent.
  const simulateCaller = () => {
    const g = GAZETTEER[Math.floor(Math.random() * GAZETTEER.length)];
    setCaller({ lat: g.lat + (Math.random() - 0.5) * 0.006, lng: g.lng + (Math.random() - 0.5) * 0.006 });
  };

  const submit = async () => {
    setBusy(true); setErrors({});
    const pickup = method === 'MAP_PIN' ? { method, lat: pin?.lat, lng: pin?.lng } : method === 'ADDRESS' ? { method, address } : { method, lat: caller?.lat, lng: caller?.lng, consent };
    const r = await call((t) => backend.createIncident(t, { emergencyType: type, severity, patientAgeGroup: age, requiredResources: resources, requiredSpecialty: specialty || null, pickup, notes, assignedAmbulanceId: ambulanceId || null }),
      { ok: 'Emergency created. Recommendations generated.' });
    setBusy(false);
    if (r.ok && r.value) { onCreated(r.value.id); onClose(); } else if (r.fields) { setErrors(r.fields); toast('Please correct the highlighted fields.', 'warn'); }
  };

  return (
    <Modal title="Create emergency" onClose={onClose} footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn kind={severity === 'CRITICAL' ? 'danger' : ''} onClick={submit} disabled={busy} icon="plus">{busy ? 'Creating…' : 'Create emergency'}</Btn></>}>
      <Banner kind="info" icon="shield">Keep patient information minimal. Do <b>not</b> enter names, ID numbers, phone numbers, insurance or detailed medical history.</Banner>
      <div className="grid2">
        <Field label="Incident ID"><input value={nextCode} readOnly aria-readonly="true" className="mono" /></Field>
        <Field label="Emergency type" error={errors.emergencyType}>
          <select value={type} onChange={(e) => chooseType(e.target.value as EmergencyType)}>{(cats.length ? cats.map((c) => c.id) : [...EMERGENCY_TYPES]).map((t) => <option key={t} value={t}>{EMERGENCY_LABEL[t]}</option>)}</select></Field>
      </div>
      <div className="grid2">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Severity</legend>
          <div className="seg" role="group" aria-label="Severity">{SEVERITIES.map((s) => <button key={s} type="button" aria-pressed={severity === s} onClick={() => setSeverity(s)}>{SEVERITY_LABEL[s]}</button>)}</div>
          <div className="mt8"><SeverityBadge s={severity} /></div>{errors.severity && <span className="err small">{errors.severity}</span>}</fieldset>
        <Field label="Patient age group" error={errors.patientAgeGroup}><select value={age} onChange={(e) => setAge(e.target.value as AgeGroup)}>{AGE_GROUPS.map((a) => <option key={a} value={a}>{AGE_LABEL[a]}</option>)}</select></Field>
      </div>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Required resources</legend>
        <div className="grid3">{RESOURCES.map((r) => <label key={r} className={`chk ${resources.includes(r) ? 'on' : ''}`}><input type="checkbox" checked={resources.includes(r)} onChange={() => toggle(r)} />{RESOURCE_LABEL[r]}</label>)}</div>
        {errors.requiredResources && <span className="err small">{errors.requiredResources}</span>}
        <p className="xs muted mt8">An ER bed is assumed when no counted resource is selected.</p></fieldset>
      <Field label="Required specialty" error={errors.requiredSpecialty} hint="Hospitals without this service are not eligible.">
        <select value={specialty} onChange={(e) => setSpecialty(e.target.value as Capability | '')}><option value="">None / not specified</option>{CAPABILITIES.map((c) => <option key={c} value={c}>{CAPABILITY_LABEL[c]}</option>)}</select></Field>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="small" style={{ fontWeight: 600, marginBottom: 4 }}>Pickup location method</legend>
        <div className="seg" role="group" aria-label="Pickup location method">
          {([['ADDRESS', 'Enter address'], ['MAP_PIN', 'Drop map pin'], ['CALLER_SHARED', 'Caller-shared (simulated)']] as const).map(([m, l]) => <button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(m)}>{l}</button>)}</div></fieldset>
      {method === 'ADDRESS' && (
        <Field label="Address" error={errors.pickup} hint={geo ? `Matched: ${geo.name}` : 'Demo gazetteer — type a place name or pick a suggestion.'}>
          <input list="rc-places" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="e.g. Riverside Market" autoComplete="off" />
          <datalist id="rc-places">{GAZETTEER.map((g) => <option key={g.name} value={g.name} />)}</datalist></Field>)}
      {method === 'CALLER_SHARED' && (
        <div className="col">
          <Banner kind="info" icon="location">{CALLER_CONSENT_TEXT}</Banner>
          <label className="chk"><input type="checkbox" checked={consent} onChange={(e) => { setConsent(e.target.checked); if (!e.target.checked) setCaller(null); }} /> The caller has consented to share their location (simulated).</label>
          <div className="row"><Btn size="sm" kind="secondary" icon="location" disabled={!consent} onClick={simulateCaller}>{caller ? 'Re-simulate caller location' : 'Receive caller location'}</Btn>
            {caller && <span className="small muted">Received {caller.lat.toFixed(4)}, {caller.lng.toFixed(4)}</span>}</div>
          {errors.pickup && <span className="err small">{errors.pickup}</span>}</div>)}
      {method === 'MAP_PIN' && errors.pickup && <span className="err small" role="alert">{errors.pickup}</span>}
      <div className="mapbox" style={{ height: 260 }}>
        <MapView hospitals={(snap?.hospitals ?? []).map((h) => ({ id: h.id, name: h.name, lat: h.entranceLat, lng: h.entranceLng, tone: 'green', status: 'hospital' }))} pin={preview}
          onMapClick={method === 'MAP_PIN' ? setPin : undefined} fitKey="create" />
        <MapLegend />
        {method === 'MAP_PIN' && <div className="mapnote"><div className="banner info small"><Icon name="location" /> Click the map to drop the pickup pin{pin ? ` — ${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}` : '.'}</div></div>}
      </div>
      <Field label="Short clinical / pre-arrival notes" error={errors.notes} hint={`${notes.length}/400 — anonymous, operational information only.`}>
        <textarea rows={3} value={notes} maxLength={400} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Adult, unresponsive, bleeding controlled." /></Field>
      <Field label="Assigned ambulance (optional)" hint={available.length ? 'You can also assign after creation.' : 'No ambulance is currently available.'}>
        <select value={ambulanceId} onChange={(e) => setAmbulanceId(e.target.value)}><option value="">Assign later</option>{available.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.vehicleType}</option>)}</select></Field>
    </Modal>
  );
}
