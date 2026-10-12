import { useEffect, useRef, useState } from 'react';
import { AMBULANCE_STATUS_LABEL, CAPABILITY_LABEL, EMERGENCY_LABEL, INCIDENT_STATUS_LABEL, RESOURCE_LABEL } from '../lib/labels';
import type { LatLng } from '../lib/types';
import type { AmbulanceAction } from '../server/workflows';
import { useApp, useIncidentDetail, useNow } from '../state/app';
import { MapLegend, MapView, type MapRoute } from '../components/MapView';
import { mapAmbulances, mapHospitals, mapPickups } from '../components/mapData';
import { Timeline } from '../components/Panels';
import { AmbulanceBadge, Banner, Btn, ConfirmDialog, Field, GpsBadge, Icon, Modal, SeverityBadge, Spinner, fmtTime, mmss } from '../components/ui';

type GeoState = 'idle' | 'asking' | 'active' | 'denied' | 'unavailable';

export function AmbulancePage() {
  const { snap, call, backend, user, toast } = useApp();
  const now = useNow(1000);
  const [geo, setGeo] = useState<GeoState>('idle');
  const [confirm, setConfirm] = useState<null | { label: string; action: AmbulanceAction; body: string }>(null);
  const [fallback, setFallback] = useState(false);
  const [contact, setContact] = useState(false);
  const watch = useRef<number | null>(null);
  const amb = snap?.ambulances[0];
  const inc = snap?.incidents[0];
  const { detail } = useIncidentDetail(inc?.id ?? null);

  const stopWatch = () => { if (watch.current != null && navigator.geolocation) navigator.geolocation.clearWatch(watch.current); watch.current = null; };
  useEffect(() => () => stopWatch(), []);
  // stop device GPS as soon as the server says sharing is off (incident closed, duty ended, manual stop)
  useEffect(() => { if (amb && !amb.locationSharing && watch.current != null) { stopWatch(); setGeo('idle'); } }, [amb?.locationSharing]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!snap || !user) return <Spinner label="Loading crew dashboard…" />;
  if (!amb) return <div className="page"><Banner kind="danger">Your account is not linked to an ambulance. Contact an administrator.</Banner></div>;

  const route = inc ? snap.routes[inc.id] : undefined;
  const hospital = snap.hospitals[0];
  const req = snap.requests[0];
  const onDuty = amb.status !== 'OFFLINE';
  const needsGpsWarning = amb.locationSharing && (amb.gpsFreshness === 'LOST' || amb.gpsFreshness === 'STALE');
  const act = async (action: AmbulanceAction, ok: string, payload?: { source?: 'SIMULATED' | 'DEVICE'; manual?: boolean }) => call((t) => backend.ambulanceAction(t, amb.id, action, payload), { ok });

  // Real device GPS: ONLY after an explicit tap, and only while duty/trip is active.
  const startSharing = async () => {
    if (!onDuty) { toast('Start duty before sharing location.', 'warn'); return; }
    if (!('geolocation' in navigator)) {
      setGeo('unavailable');
      await act('START_SHARING', 'Location sharing started (simulated GPS — demo).', { source: 'SIMULATED' });
      return;
    }
    setGeo('asking');
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const r = await act('START_SHARING', 'Location sharing started from device GPS.', { source: 'DEVICE' });
      if (!r.ok) { setGeo('idle'); return; }
      setGeo('active');
      push(pos);
      watch.current = navigator.geolocation.watchPosition(push, () => setGeo('denied'), { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    }, async (err) => {
      setGeo(err.code === 1 ? 'denied' : 'unavailable');
      // demo fallback: simulated movement (clearly labelled), so the demo works without device permission
      await act('START_SHARING', 'GPS unavailable — sharing with simulated demo positions. Use manual fallback if needed.', { source: 'SIMULATED' });
    }, { enableHighAccuracy: true, timeout: 12000 });
  };
  const push = (pos: GeolocationPosition) => {
    void call((t) => backend.updateLocation(t, amb.id, { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyMeters: pos.coords.accuracy, speedKmph: Math.round((pos.coords.speed ?? 0) * 3.6), headingDegrees: pos.coords.heading ?? 0 }), { quiet: true });
  };
  const stopSharing = async () => { stopWatch(); setGeo('idle'); await act('STOP_SHARING', 'Location sharing stopped.'); };

  const routes: MapRoute[] = route ? [{ id: 'r', kind: route.leg === 'PICKUP' ? 'pickup' : 'hospital', points: route.points, label: `${route.distanceKm} km · ETA ${route.etaMinutes} min` }] : [];
  const etaSec = route ? route.etaMinutes * 60 : null;
  const nextStep = (): { label: string; action: AmbulanceAction; ok: string; confirm?: string; kind?: 'good' | 'danger' | ''; disabled?: string } | null => {
    if (!onDuty) return null;
    if (!inc) return null;
    switch (amb.status) {
      case 'ASSIGNED': return !inc.tripStarted ? { label: 'Start emergency trip', action: 'START_TRIP', ok: 'Trip started. Location sharing is on.' } : { label: 'Begin route to pickup', action: 'BEGIN_ROUTE_PICKUP', ok: 'En route to pickup.' };
      case 'EN_ROUTE_PICKUP': return { label: 'Arrived at pickup', action: 'ARRIVED_PICKUP', ok: 'Arrival at pickup recorded.' };
      case 'AT_PICKUP': return { label: 'Patient onboard', action: 'PATIENT_ONBOARD', ok: 'Patient onboard recorded.', confirm: 'Confirm the patient is onboard? Dispatch will review hospital destinations.' };
      case 'PATIENT_ONBOARD': return { label: 'Begin route to hospital', action: 'BEGIN_ROUTE_HOSPITAL', ok: 'Routing to hospital emergency entrance.', disabled: inc.destinationConfirmed ? undefined : 'Waiting for hospital acceptance from dispatch.' };
      case 'EN_ROUTE_HOSPITAL': return { label: 'Arrived at hospital', action: 'ARRIVED_HOSPITAL', ok: 'Arrival at hospital recorded.' };
      case 'AT_HOSPITAL': return { label: 'Complete incident', action: 'COMPLETE_INCIDENT', ok: 'Incident completed. Location sharing stopped.', confirm: 'Complete this incident? Location sharing will stop and the ambulance becomes available.', kind: 'good', disabled: inc.handoverConfirmed ? undefined : undefined };
      default: return null;
    }
  };
  const step = nextStep();

  return (
    <div className="crew">
      <div className="card col">
        <div className="row between"><div><div className="small muted">Ambulance</div><div className="big">{amb.code}</div></div><AmbulanceBadge s={amb.status} /></div>
        <div className="row between wrap"><span className="small">Crew: {user.fullName}</span><GpsBadge f={amb.gpsFreshness} age={amb.gpsAgeSeconds} /></div>
        <div className={`sharing ${amb.locationSharing ? 'on' : 'off'}`} role="status" aria-live="polite">
          <Icon name="location" size={22} />{amb.locationSharing ? <div>Location sharing ACTIVE<div className="small" style={{ fontWeight: 500 }}>{geo === 'active' ? 'Using device GPS' : 'Simulated demo GPS (updates every 10 s)'}</div></div> : <div>Location sharing OFF<div className="small" style={{ fontWeight: 500 }}>Your position is not being shared</div></div>}</div>
        <div className="grid2">
          {!onDuty ? <Btn size="lg" kind="good" onClick={() => act('START_DUTY', 'On duty.')}>Start duty</Btn>
            : <Btn size="lg" kind="secondary" disabled={!!inc} onClick={() => setConfirm({ label: 'End duty', action: 'END_DUTY', body: 'End duty? Location sharing will stop and you will no longer receive assignments.' })}>End duty</Btn>}
          {amb.locationSharing ? <Btn size="lg" kind="warn" onClick={stopSharing}>Stop location sharing</Btn> : <Btn size="lg" disabled={!onDuty || geo === 'asking'} onClick={startSharing}>{geo === 'asking' ? 'Requesting permission…' : 'Start location sharing'}</Btn>}
        </div>
        {!onDuty && <p className="small muted">Location sharing is only available while on duty or on an active emergency trip.</p>}
        {(geo === 'denied' || geo === 'unavailable' || needsGpsWarning) && (
          <Banner kind="danger" icon="signal"><b>GPS unavailable — use manual fallback.</b> {needsGpsWarning ? 'Dispatch has not received your location recently.' : ''}
            <div className="row wrap mt8"><Btn size="sm" kind="secondary" icon="location" onClick={() => setFallback(true)}>Update location by map pin</Btn>
              <Btn size="sm" kind="secondary" onClick={() => { void call((t) => backend.updateLocation(t, amb.id, { lat: amb.lat, lng: amb.lng }, 'LAST_KNOWN'), { ok: 'Last known location reported to dispatch.' }); }}>Report last known location</Btn>
              <Btn size="sm" kind="secondary" icon="phone" onClick={() => setContact(true)}>Contact dispatcher</Btn></div></Banner>)}
      </div>

      {!inc ? (
        <div className="card col"><h2>No active assignment</h2><p className="muted">{onDuty ? 'You are available. Dispatch will assign an emergency — you will be notified here.' : 'Start duty to receive assignments.'}</p></div>
      ) : (
        <>
          <div className="card col" style={{ borderLeft: `6px solid var(${inc.severity === 'CRITICAL' ? '--red' : '--orange'})` }}>
            <div className="row between wrap"><h2>{inc.incidentCode}</h2><SeverityBadge s={inc.severity} /></div>
            <p><b>{EMERGENCY_LABEL[inc.emergencyType]}</b> · {INCIDENT_STATUS_LABEL[inc.status]}</p>
            <dl className="kv"><dt>Pickup</dt><dd><b>{inc.pickupAddress}</b></dd><dt>Needs</dt><dd>{[...inc.requiredResources.map((r) => RESOURCE_LABEL[r]), ...inc.requiredCapabilities.map((c) => `${CAPABILITY_LABEL[c]} service`)].join(', ') || 'ER bed'}</dd>
              <dt>Notes</dt><dd>{inc.preArrivalNotes || '—'}</dd><dt>Destination</dt><dd>{hospital ? <><b>{hospital.name}</b> {inc.destinationConfirmed ? <span className="badge b-green">CONFIRMED</span> : <span className="badge b-amber">PENDING HOSPITAL ACCEPTANCE</span>}</> : <span className="muted">Not selected yet</span>}</dd>
              <dt>ETA</dt><dd><b style={{ fontSize: '1.3rem' }}>{etaSec != null ? mmss(etaSec) : inc.etaMinutes != null ? `${inc.etaMinutes} min` : '—'}</b> {route && <span className="muted small">· {route.distanceKm} km · {route.trafficLevel.toLowerCase()} traffic</span>}</dd></dl>
            {hospital && req && !inc.destinationConfirmed && <Banner kind="warn">The hospital has not accepted yet. Do not treat the destination as confirmed. {req.status === 'DECLINED' && 'The hospital declined — dispatch is choosing another.'}</Banner>}
            {hospital && inc.destinationConfirmed && <p className="small">Emergency entrance: <a href={`https://www.openstreetmap.org/?mlat=${hospital.entranceLat}&mlon=${hospital.entranceLng}#map=17/${hospital.entranceLat}/${hospital.entranceLng}`} target="_blank" rel="noreferrer">open navigation preview</a></p>}
          </div>

          <div className="mapbox" style={{ height: 280 }}>
            <MapView hospitals={hospital ? mapHospitals([hospital], snap.resourceStatus, undefined, hospital.id) : []} ambulances={mapAmbulances([amb], inc)} pickups={mapPickups([inc], inc.id)} routes={routes} fitKey={`${inc.id}-${amb.status}`} />
            <MapLegend />
          </div>

          {step && (
            <div className="col">
              <Btn size="lg" kind={step.kind ?? ''} disabled={!!step.disabled} onClick={() => step.confirm ? setConfirm({ label: step.label, action: step.action, body: step.confirm }) : act(step.action, step.ok)}>{step.label}</Btn>
              {step.disabled && <p className="small muted" style={{ textAlign: 'center' }}>{step.disabled}</p>}
            </div>)}
          <Btn size="lg" kind="danger" icon="phone" onClick={() => setContact(true)}>Emergency fallback — contact dispatcher</Btn>
          <div className="card"><h3>Case timeline</h3><Timeline events={detail?.timeline ?? []} max={10} /></div>
        </>
      )}
      <p className="xs muted" style={{ textAlign: 'center' }}>Decision support only. Follow your protocols and dispatcher instructions.</p>

      {confirm && <ConfirmDialog title={confirm.label} confirmText={confirm.label} danger={confirm.action === 'END_DUTY'} onCancel={() => setConfirm(null)} onConfirm={async () => { const r = await act(confirm.action, `${confirm.label} — done.`); if (r.ok) { if (confirm.action === 'COMPLETE_INCIDENT' || confirm.action === 'END_DUTY') { stopWatch(); setGeo('idle'); } setConfirm(null); } }}><p>{confirm.body}</p></ConfirmDialog>}
      {fallback && <PinDialog start={{ lat: amb.lat, lng: amb.lng }} onClose={() => setFallback(false)} onSave={async (p) => { const r = await call((t) => backend.updateLocation(t, amb.id, p, 'MAP_PIN'), { ok: 'Location updated from map pin.' }); if (r.ok) setFallback(false); }} />}
      {contact && <ContactDialog onClose={() => setContact(false)} />}
      <span className="sr-only" aria-live="polite">{AMBULANCE_STATUS_LABEL[amb.status]} {fmtTime(new Date(now).toISOString())}</span>
    </div>
  );
}

function PinDialog({ start, onSave, onClose }: { start: LatLng; onSave: (p: LatLng) => void; onClose: () => void }) {
  const [pin, setPin] = useState<LatLng>(start);
  return (
    <Modal title="Update location by map pin" onClose={onClose} footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn onClick={() => onSave(pin)}>Save location</Btn></>}>
      <p className="small">Tap the map where you are now. This is recorded as a manual update, not live GPS.</p>
      <div className="mapbox" style={{ height: 320 }}><MapView pin={pin} onMapClick={setPin} ambulances={[{ id: 'me', code: 'Last known', lat: start.lat, lng: start.lng, tone: 'gray', status: 'last known' }]} fitKey="pin" /></div>
    </Modal>
  );
}

function ContactDialog({ onClose }: { onClose: () => void }) {
  const { call, backend } = useApp();
  const [msg, setMsg] = useState('Need dispatcher assistance.');
  return (
    <Modal title="Contact dispatcher" small onClose={onClose} footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn kind="danger" disabled={msg.trim().length < 3} onClick={async () => { const r = await call((t) => backend.contactDispatcher(t, msg), { ok: 'Dispatcher alerted.' }); if (r.ok) onClose(); }}>Send alert</Btn></>}>
      <Banner kind="info" icon="phone">If the app is unreliable, call the dispatch centre directly by radio or phone.</Banner>
      <Field label="Message"><input value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={200} /></Field>
    </Modal>
  );
}
