import { useEffect, useMemo, useState } from 'react';
import { AGE_LABEL, CAPABILITY_LABEL, EMERGENCY_LABEL, INCIDENT_STATUS_LABEL, PICKUP_SOURCE_LABEL, RESOURCE_LABEL, SEVERITY_RANK } from '../lib/labels';
import { ACTIVE_INCIDENT_STATUSES, type Incident } from '../lib/types';
import { CreateEmergencyModal } from '../components/CreateEmergency';
import { MapLegend, MapView, type MapRoute } from '../components/MapView';
import { mapAmbulances, mapHeat, mapHospitals, mapPickups } from '../components/mapData';
import { DemoControls, Kv, Timeline } from '../components/Panels';
import { RecommendationPanel, RequestStatusCard } from '../components/Recommendations';
import { AmbulanceBadge, Banner, Btn, ConfirmDialog, Empty, Field, GpsBadge, Icon, Modal, SeverityBadge, Spinner, fmtDur, fmtTime } from '../components/ui';
import { useApp, useIncidentDetail, useNow } from '../state/app';
import { navigate } from '../state/router';

export function priorityScore(i: Incident, now: number, hasRequest: boolean) {
  const elapsedMin = Math.max(0, (now - Date.parse(i.createdAt)) / 60000);
  return SEVERITY_RANK[i.severity] * 1000 + (i.assignedAmbulanceId ? 0 : 400) + (hasRequest ? 0 : 150) + Math.min(elapsedMin, 60);
}

export function DispatcherPage() {
  const { snap, user } = useApp();
  const now = useNow(1000);
  const [selected, setSelected] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [heat, setHeat] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [filter, setFilter] = useState<'active' | 'all'>('active');

  const active = useMemo(() => (snap?.incidents ?? []).filter((i) => ACTIVE_INCIDENT_STATUSES.includes(i.status)), [snap]);
  const queue = useMemo(() => {
    const reqIds = new Set((snap?.requests ?? []).filter((r) => ['PENDING', 'INFO_REQUESTED', 'ACCEPTED'].includes(r.status)).map((r) => r.incidentId));
    const list = filter === 'active' ? active : (snap?.incidents ?? []);
    return [...list].sort((a, b) => {
      const aa = ACTIVE_INCIDENT_STATUSES.includes(a.status), bb = ACTIVE_INCIDENT_STATUSES.includes(b.status);
      if (aa !== bb) return aa ? -1 : 1;
      return priorityScore(b, now, reqIds.has(b.id)) - priorityScore(a, now, reqIds.has(a.id));
    });
  }, [snap, active, filter, now]);

  // keep a valid selection
  useEffect(() => {
    if (!snap) return;
    if (selected && snap.incidents.some((i) => i.id === selected)) return;
    setSelected(queue[0]?.id ?? null);
  }, [snap, queue, selected]);
  useEffect(() => { setPreview(null); }, [selected]);
  const previewRoute = usePreview(selected, preview);

  if (!snap || !user) return <Spinner label="Loading operations…" />;
  const inc = snap.incidents.find((i) => i.id === selected) ?? null;
  const recs = inc ? snap.recommendations[inc.id] : undefined;
  const topRec = recs?.find((r) => r.rank === 1);
  const route = inc ? snap.routes[inc.id] : undefined;
  const sm = snap.summary;
  const routes: MapRoute[] = [];
  if (route && inc) routes.push({ id: `${inc.id}-active`, kind: route.leg === 'PICKUP' ? 'pickup' : 'hospital', points: route.points, label: `${route.leg === 'PICKUP' ? 'Ambulance → pickup' : 'Ambulance → hospital'} · ${route.distanceKm} km · ETA ${route.etaMinutes} min` });
  if (previewRoute) routes.push({ id: `${inc?.id}-preview`, kind: 'preview', points: previewRoute.points, label: `Preview · ${previewRoute.distanceKm} km · ${previewRoute.etaMinutes} min` });

  return (
    <div className="page">
      <section className="stats" aria-label="Summary">
        <Stat n={sm.activeEmergencies} l="Active emergencies" sub={sm.criticalActive ? `${sm.criticalActive} critical` : undefined} tone={sm.criticalActive ? 'alert' : undefined} />
        <Stat n={sm.availableAmbulances} l="Available ambulances" />
        <Stat n={sm.hospitalsAccepting} l="Hospitals accepting emergencies" sub={`of ${snap.hospitals.length}`} />
        <Stat n={`${sm.icuAvailable}`} l="Critical ICU availability" sub={`of ${sm.icuTotal} ICU beds`} tone={sm.icuAvailable <= 2 ? 'alert' : undefined} />
        <Stat n={sm.unackedAlerts} l="Unacknowledged alerts" tone={sm.unackedAlerts ? 'alert' : undefined} />
      </section>

      <div className="row wrap">
        <Btn icon="plus" kind="danger" onClick={() => setShowCreate(true)}>Create emergency</Btn>
        <QuickAssign inc={inc} />
        <Btn icon="hospital" kind="secondary" disabled={!inc} onClick={() => document.getElementById('rec-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Find suitable hospital</Btn>
        <ContactButton inc={inc} />
        <EscalateButton inc={inc} />
        <Btn kind="secondary" icon="heat" aria-pressed={heat} onClick={() => setHeat((h) => !h)}>{heat ? 'Hide' : 'Show'} ICU capacity heatmap</Btn>
        <span className="small muted right">Decision support only · Verify stale capacity by phone</span>
      </div>

      <div className="ops">
        <div className="col" aria-label="Active emergencies">
          <div className="row between"><h2>Incident queue</h2>
            <div className="seg" role="group" aria-label="Filter"><button aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>Active</button><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Recent</button></div></div>
          <p className="xs muted">Sorted by severity, unassigned status and elapsed time.</p>
          <div className="list">
            {queue.length === 0 && <Empty>No incidents. Create an emergency to begin.</Empty>}
            {queue.map((i) => {
              const needsAttention = i.severity === 'CRITICAL' && ACTIVE_INCIDENT_STATUSES.includes(i.status) && !i.destinationConfirmed;
              const elapsed = ((i.closedAt ? Date.parse(i.closedAt) : now) - Date.parse(i.createdAt)) / 1000;
              return (
                <button key={i.id} className={`inc sev-${i.severity} ${needsAttention ? 'pulse' : ''}`} aria-pressed={i.id === selected} onClick={() => setSelected(i.id)}>
                  <div className="row between"><b>{i.incidentCode}</b><SeverityBadge s={i.severity} /></div>
                  <div className="small">{EMERGENCY_LABEL[i.emergencyType]} · {AGE_LABEL[i.patientAgeGroup]}</div>
                  <div className="row wrap gap4 mt8">
                    <span className="badge b-navy">{INCIDENT_STATUS_LABEL[i.status]}</span>
                    {!i.assignedAmbulanceId && ACTIVE_INCIDENT_STATUSES.includes(i.status) && <span className="badge b-red"><Icon name="alert" size={12} />UNASSIGNED</span>}
                    {i.destinationConfirmed && <span className="badge b-green"><Icon name="check" size={12} />DESTINATION CONFIRMED</span>}
                    {needsAttention && <span className="badge b-solid-red">NEEDS ATTENTION</span>}
                  </div>
                  <div className="xs muted mt8">{fmtDur(elapsed)} elapsed{i.etaMinutes != null && ACTIVE_INCIDENT_STATUSES.includes(i.status) ? ` · ETA ${i.etaMinutes} min` : ''}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="col">
          <div className="mapbox" aria-label="Live operations map">
            <MapView
              hospitals={mapHospitals(snap.hospitals, snap.resourceStatus, recs, inc?.selectedHospitalId ?? highlight, topRec?.hospitalId)}
              ambulances={mapAmbulances(snap.ambulances, inc)} pickups={mapPickups(snap.incidents, selected)} routes={routes}
              heat={heat ? mapHeat(snap.hospitals, snap.resourceStatus) : undefined} zones={heat ? snap.serviceAreas : undefined} fitKey={selected ?? 'all'}
              onSelect={(k, id) => { if (k === 'pickup') setSelected(id); if (k === 'hospital') setHighlight(id); }} />
            <MapLegend heat={heat} />
            {route && inc && (
              <div className="mapnote"><div className="banner info small"><Icon name="route" />
                <div><b>{route.leg === 'PICKUP' ? 'To pickup' : `To ${snap.hospitals.find((h) => h.id === route.hospitalId)?.name ?? 'hospital'}`}</b> · {route.distanceKm} km · ETA {route.etaMinutes} min · {route.trafficLevel.toLowerCase()} traffic
                  {inc.assignedAmbulanceId && (() => { const a = snap.ambulances.find((x) => x.id === inc.assignedAmbulanceId); return a ? <> · <GpsBadge f={a.gpsFreshness} age={a.gpsAgeSeconds} /></> : null; })()}</div></div></div>)}
          </div>
          <AmbulanceStrip />
          <DemoControls snap={snap} incident={inc} />
        </div>

        <div className="col" aria-label="Selected incident">
          {!inc ? <Empty>Select an incident to see details and recommended hospitals.</Empty> : <IncidentSide inc={inc} preview={preview} setPreview={setPreview} setHighlight={setHighlight} />}
        </div>
      </div>
      {showCreate && <CreateEmergencyModal onClose={() => setShowCreate(false)} onCreated={(id) => setSelected(id)} />}
    </div>
  );
}

function usePreview(incidentId: string | null, hospitalId: string | null) {
  const { backend, token } = useApp();
  const [r, setR] = useState<{ points: { lat: number; lng: number }[]; distanceKm: number; etaMinutes: number } | null>(null);
  useEffect(() => {
    let alive = true;
    if (!incidentId || !hospitalId || !token) { setR(null); return; }
    backend.previewRoute(token, incidentId, hospitalId).then((x) => { if (alive) setR(x); }).catch(() => { if (alive) setR(null); });
    return () => { alive = false; };
  }, [backend, token, incidentId, hospitalId]);
  return r;
}

function Stat({ n, l, sub, tone }: { n: number | string; l: string; sub?: string; tone?: 'alert' }) {
  return <div className={`stat ${tone ?? ''}`}><div className="n">{n}</div><div className="l">{l}</div>{sub && <div className="xs muted">{sub}</div>}</div>;
}

function AmbulanceStrip() {
  const { snap } = useApp();
  if (!snap) return null;
  return (
    <div className="card flat">
      <h3>Ambulances</h3>
      <div className="tablewrap mt8"><table className="t"><thead><tr><th>Unit</th><th>Status</th><th>GPS</th><th>Speed</th><th>Last update</th></tr></thead><tbody>
        {snap.ambulances.map((a) => <tr key={a.id}><td><b>{a.code}</b> <span className="xs muted">{a.vehicleType}</span></td><td><AmbulanceBadge s={a.status} /></td>
          <td><GpsBadge f={a.gpsFreshness} age={a.gpsAgeSeconds} /></td><td>{a.locationSharing ? `${a.speedKmph} km/h` : '—'}</td><td>{a.lastLocationAt ? fmtTime(a.lastLocationAt) : '—'}</td></tr>)}
      </tbody></table></div>
      {snap.ambulances.some((a) => a.locationSharing && a.gpsFreshness === 'LOST') && <div className="mt8"><Banner kind="danger" icon="signal">GPS signal lost for {snap.ambulances.filter((a) => a.locationSharing && a.gpsFreshness === 'LOST').map((a) => a.code).join(', ')}. Showing last known location — contact the crew.</Banner></div>}
    </div>
  );
}

function QuickAssign({ inc }: { inc: Incident | null }) {
  const { snap } = useApp();
  const [open, setOpen] = useState(false);
  const can = !!inc && ACTIVE_INCIDENT_STATUSES.includes(inc.status) && !['PATIENT_ONBOARD', 'EN_ROUTE_HOSPITAL', 'ARRIVED', 'HANDED_OVER'].includes(inc.status);
  return <><Btn icon="ambulance" kind="secondary" disabled={!can || !snap} onClick={() => setOpen(true)}>Assign ambulance</Btn>{open && inc && <AssignDialog inc={inc} onClose={() => setOpen(false)} />}</>;
}

function AssignDialog({ inc, onClose }: { inc: Incident; onClose: () => void }) {
  const { snap, call, backend } = useApp();
  const [pick, setPick] = useState('');
  const [confirm, setConfirm] = useState(false);
  const cur = snap!.ambulances.find((a) => a.id === inc.assignedAmbulanceId);
  const pickup = inc.pickupLat != null ? { lat: inc.pickupLat, lng: inc.pickupLng! } : null;
  const list = snap!.ambulances.filter((a) => a.status === 'AVAILABLE').map((a) => ({ a, km: pickup ? Math.hypot((a.lat - pickup.lat) * 111, (a.lng - pickup.lng) * 108) : 0 })).sort((x, y) => x.km - y.km);
  return (
    <Modal title={`${cur ? 'Reassign' : 'Assign'} ambulance — ${inc.incidentCode}`} small onClose={onClose}
      footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn disabled={!pick || (!!cur && !confirm)} onClick={async () => { const r = await call((t) => backend.assignAmbulance(t, inc.id, pick, { confirmReassign: confirm }), { ok: 'Ambulance assigned.' }); if (r.ok) onClose(); }}>{cur ? 'Confirm reassignment' : 'Assign'}</Btn></>}>
      {cur && <Banner kind="warn">{cur.code} is currently assigned. Reassigning cancels its route and notifies the crew.</Banner>}
      {list.length === 0 && <Empty>No ambulance is currently available.</Empty>}
      <div className="col">{list.map(({ a, km }) => (
        <label key={a.id} className={`chk ${pick === a.id ? 'on' : ''}`}><input type="radio" name="amb" checked={pick === a.id} onChange={() => setPick(a.id)} /><b>{a.code}</b> <span className="muted small">{a.vehicleType} · ~{km.toFixed(1)} km from pickup</span></label>))}</div>
      {cur && <label className="chk"><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> Confirm reassignment from {cur.code}.</label>}
    </Modal>
  );
}

function ContactButton({ inc }: { inc: Incident | null }) {
  const { snap } = useApp();
  const [open, setOpen] = useState(false);
  return (<><Btn icon="phone" kind="secondary" disabled={!snap} onClick={() => setOpen(true)}>Contact hospital</Btn>
    {open && snap && (
      <Modal title="Hospital emergency contacts" small onClose={() => setOpen(false)}>
        <p className="small muted">Operational fallback numbers (demo values). Use when the app alert is unacknowledged or data is stale.</p>
        <div className="col">{snap.hospitals.map((h) => { const s = snap.resourceStatus[h.id]; return (
          <div key={h.id} className="row between card flat"><div><b>{h.name}</b><div className="xs muted">Capacity {s.freshness}{s.ageMinutes != null ? ` · ${Math.round(s.ageMinutes)} min old` : ''}{inc?.selectedHospitalId === h.id ? ' · selected' : ''}</div></div>
            <a className="btn sm" href={`tel:${h.emergencyContact}`}><Icon name="phone" size={14} />{h.emergencyContact}</a></div>); })}</div>
      </Modal>)}</>);
}

function EscalateButton({ inc }: { inc: Incident | null }) {
  const { call, backend } = useApp();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  return (<><Btn icon="alert" kind="warn" disabled={!inc || !ACTIVE_INCIDENT_STATUSES.includes(inc.status)} onClick={() => setOpen(true)}>Escalate incident</Btn>
    {open && inc && <ConfirmDialog title={`Escalate ${inc.incidentCode}?`} confirmText="Escalate" danger onCancel={() => setOpen(false)} onConfirm={async () => { const r = await call((t) => backend.escalateIncident(t, inc.id, note), { ok: 'Incident escalated.' }); if (r.ok) { setOpen(false); setNote(''); } }}>
      <p>Notifies dispatch supervisors and administrators. Nothing is dispatched or reserved automatically.</p><Field label="Reason (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></Field></ConfirmDialog>}</>);
}

function IncidentSide({ inc, preview, setPreview, setHighlight }: { inc: Incident; preview: string | null; setPreview: (id: string | null) => void; setHighlight: (id: string | null) => void }) {
  const { snap, call, backend } = useApp();
  const { detail } = useIncidentDetail(inc.id);
  const [tab, setTab] = useState<'hospital' | 'details' | 'timeline'>('hospital');
  const [confirmClose, setConfirmClose] = useState<null | 'close' | 'cancel'>(null);
  const [confirmOnboard, setConfirmOnboard] = useState(false);
  if (!snap) return null;
  const amb = snap.ambulances.find((a) => a.id === inc.assignedAmbulanceId);
  const recs = snap.recommendations[inc.id] ?? [];
  const activeInc = ACTIVE_INCIDENT_STATUSES.includes(inc.status);
  const needs = [...inc.requiredResources.map((r) => RESOURCE_LABEL[r]), ...inc.requiredCapabilities.map((c) => `${CAPABILITY_LABEL[c]} service`)];
  const dest = snap.hospitals.find((h) => h.id === inc.selectedHospitalId);
  return (
    <>
      <div className="card" style={{ borderLeft: `6px solid var(${inc.severity === 'CRITICAL' ? '--red' : inc.severity === 'HIGH' ? '--orange' : '--amber-bd'})` }}>
        <div className="row between wrap"><h2>{inc.incidentCode}</h2><SeverityBadge s={inc.severity} /></div>
        <p className="small muted">{EMERGENCY_LABEL[inc.emergencyType]} · {AGE_LABEL[inc.patientAgeGroup]} · {INCIDENT_STATUS_LABEL[inc.status]}</p>
        <div className="grid2 mt8 small">
          <div><span className="muted">Needs</span><div><b>{needs.join(', ') || 'ER bed'}</b></div></div>
          <div><span className="muted">Recommended destination</span><div><b>{dest ? dest.name : recs.find((r) => r.rank === 1) ? snap.hospitals.find((h) => h.id === recs.find((r) => r.rank === 1)!.hospitalId)?.name : 'None eligible'}</b>
            {inc.destinationConfirmed ? <span className="badge b-green"> CONFIRMED</span> : <span className="badge b-gray"> NOT CONFIRMED</span>}</div></div>
          <div><span className="muted">ETA</span><div><b>{inc.etaMinutes != null ? `${inc.etaMinutes} min` : '—'}</b> {inc.etaDistanceKm != null && <span className="muted">({inc.etaDistanceKm} km)</span>}</div></div>
          <div><span className="muted">Ambulance</span><div>{amb ? <><b>{amb.code}</b> <GpsBadge f={amb.gpsFreshness} age={amb.gpsAgeSeconds} /></> : <span className="badge b-red">UNASSIGNED</span>}</div></div>
        </div>
        <div className="row wrap mt12">
          <Btn size="sm" kind="secondary" icon="print" onClick={() => navigate(`/app/incident/${inc.id}`)}>Full detail &amp; report</Btn>
          {activeInc && amb && ['EN_ROUTE_PICKUP', 'AT_PICKUP'].includes(amb.status) && <Btn size="sm" kind="good" onClick={() => setConfirmOnboard(true)}>Mark patient onboard</Btn>}
          {activeInc && <Btn size="sm" kind="secondary" onClick={() => setConfirmClose(inc.status === 'ARRIVED' || inc.status === 'HANDED_OVER' ? 'close' : 'cancel')}>{inc.status === 'ARRIVED' || inc.status === 'HANDED_OVER' ? 'Close incident' : 'Cancel incident'}</Btn>}
        </div>
      </div>
      <div className="tabs" role="tablist">{(['hospital', 'details', 'timeline'] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t === 'hospital' ? 'Hospitals' : t === 'details' ? 'Details' : 'Timeline'}</button>)}</div>
      {tab === 'hospital' && (
        <div id="rec-panel" className="col">
          {activeInc && <RequestStatusCard incident={inc} requests={snap.requests} hospitals={snap.hospitals} recs={recs} />}
          {activeInc ? <RecommendationPanel incident={inc} recs={recs} hospitals={snap.hospitals} status={snap.resourceStatus} requests={snap.requests.filter((r) => r.incidentId === inc.id)} previewId={preview} onPreview={setPreview} onHighlight={setHighlight} />
            : <Banner kind="info">This incident is {inc.status.toLowerCase()}.</Banner>}
        </div>)}
      {tab === 'details' && (
        <div className="card flat"><Kv rows={[
          ['Pickup', inc.pickupAddress ?? '—'], ['Pickup method', PICKUP_SOURCE_LABEL[inc.pickupSource]], ['Created', fmtTime(inc.createdAt)],
          ['Notes', inc.preArrivalNotes || '—'], ['Escalation', inc.escalationLevel ? `Level ${inc.escalationLevel}` : 'None'],
          ['Declined by', inc.declinedHospitalIds.map((id) => snap.hospitals.find((h) => h.id === id)?.name).join(', ') || '—'],
        ]} />{inc.pickupPrecisionReduced && <div className="mt8"><Banner kind="info">Caller location expired with the incident; precision reduced.</Banner></div>}</div>)}
      {tab === 'timeline' && <div className="card flat"><h3>Live activity</h3><Timeline events={detail?.timeline ?? []} /></div>}
      {confirmOnboard && amb && <ConfirmDialog title="Mark patient onboard?" confirmText="Confirm onboard" onCancel={() => setConfirmOnboard(false)} onConfirm={async () => { await call((t) => backend.markPatientOnboard(t, inc.id), { ok: 'Patient marked onboard. Review recommended destinations.' }); setConfirmOnboard(false); setTab('hospital'); }}>
        <p>This records that {amb.code} has the patient and refreshes hospital recommendations from the ambulance’s current position.</p></ConfirmDialog>}
      {confirmClose && <CloseDialog inc={inc} mode={confirmClose} onClose={() => setConfirmClose(null)} />}
    </>
  );
}

function CloseDialog({ inc, mode, onClose }: { inc: Incident; mode: 'close' | 'cancel'; onClose: () => void }) {
  const { call, backend } = useApp();
  const [reason, setReason] = useState('');
  return (
    <ConfirmDialog title={mode === 'close' ? `Close ${inc.incidentCode}?` : `Cancel ${inc.incidentCode}?`} confirmText={mode === 'close' ? 'Close incident' : 'Cancel incident'} danger={mode === 'cancel'} onCancel={onClose}
      disabled={mode === 'cancel' && reason.trim().length < 3}
      onConfirm={async () => { const r = await call((t) => backend.closeIncident(t, inc.id, { cancel: mode === 'cancel', reason }), { ok: mode === 'close' ? 'Incident closed.' : 'Incident cancelled.' }); if (r.ok) onClose(); }}>
      <p>{mode === 'close' ? 'Closing releases the ambulance, stops location sharing and expires any caller-shared location.' : 'Cancelling releases the ambulance, notifies any alerted hospital and stops location sharing.'}</p>
      {mode === 'cancel' && <Field label="Reason (required)"><input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={160} /></Field>}
    </ConfirmDialog>
  );
}
