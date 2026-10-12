import { useState } from 'react';
import { CAPABILITY_LABEL, EMERGENCY_LABEL, INCIDENT_STATUS_LABEL, PICKUP_SOURCE_LABEL, REQUEST_STATUS_LABEL, RESOURCE_LABEL } from '../lib/labels';
import type { EtaPoint } from '../lib/types';
import { useApp, useIncidentDetail } from '../state/app';
import { MapLegend, MapView, type MapRoute } from '../components/MapView';
import { mapAmbulances, mapHospitals, mapPickups } from '../components/mapData';
import { Kv, Timeline } from '../components/Panels';
import { RequestStatusCard } from '../components/Recommendations';
import { Banner, Btn, Empty, GpsBadge, Icon, SeverityBadge, Spinner, fmtDateTime, fmtDur, fmtTime } from '../components/ui';
import { navigate } from '../state/router';
import { ACTIVE_INCIDENT_STATUSES } from '../lib/types';

export function IncidentPage({ id }: { id: string }) {
  const { snap, user, backend, token } = useApp();
  const { detail, error } = useIncidentDetail(id);
  const [report, setReport] = useState(false);
  if (!snap || !user) return <Spinner />;
  if (error) return <div className="page"><Banner kind="danger">{error}</Banner><div><Btn kind="secondary" onClick={() => history.back()}>Back</Btn></div></div>;
  if (!detail) return <Spinner label="Loading incident…" />;
  const inc = detail.incident;
  const dispatch = user.role === 'ADMIN' || user.role === 'DISPATCHER';
  const hospitals = dispatch ? snap.hospitals : detail.hospitalName ? snap.hospitals : [];
  const trail: MapRoute[] = detail.trail.length > 1 ? [{ id: 'trail', kind: 'trail', points: detail.trail.map((p) => ({ lat: p.lat, lng: p.lng })), label: 'GPS trail' }] : [];
  const routes: MapRoute[] = [...trail];
  if (detail.route) routes.push({ id: 'route', kind: detail.route.leg === 'PICKUP' ? 'pickup' : 'hospital', points: detail.route.points, label: `${detail.route.distanceKm} km · ETA ${detail.route.etaMinutes} min` });
  const recs = detail.recommendations;
  const overrides = detail.timeline.filter((t) => t.type === 'OVERRIDE');
  const canEscalate = dispatch && ACTIVE_INCIDENT_STATUSES.includes(inc.status);
  const lastReq = [...detail.requests].reverse()[0];
  const noResponse = lastReq?.status === 'NO_RESPONSE';

  const doReport = () => { if (token) { try { backend.getIncidentReport(token, id); } catch { /* audited best-effort */ } } setReport(true); setTimeout(() => window.print(), 120); };

  return (
    <div className="page">
      <div className="row between wrap noprint">
        <div className="row wrap"><Btn kind="secondary" size="sm" onClick={() => history.back()}>← Back</Btn><h1>{inc.incidentCode}</h1><SeverityBadge s={inc.severity} /><span className="badge b-navy">{INCIDENT_STATUS_LABEL[inc.status]}</span></div>
        {dispatch && <Btn icon="print" kind="secondary" onClick={doReport}>Printable incident summary</Btn>}
      </div>
      <div className="print-title hide"><h1>RapidCare incident summary — {inc.incidentCode}</h1></div>
      {noResponse && canEscalate && <Banner kind="danger">No hospital response received. Review alternatives, call the emergency contact, or escalate below.</Banner>}
      <div className="ops" style={{ gridTemplateColumns: 'minmax(0,1fr) 420px' }}>
        <div className="col">
          <div className="mapbox" style={{ height: 420 }}>
            {user.role === 'HOSPITAL_STAFF' ? <div className="empty" style={{ margin: 12 }}>Map is not shared with hospital staff for privacy. ETA: {inc.etaMinutes ?? '—'} min.</div> : (
              <><MapView hospitals={mapHospitals(hospitals, snap.resourceStatus, recs, inc.selectedHospitalId)} ambulances={detail.ambulance ? mapAmbulances([detail.ambulance], inc) : []} pickups={mapPickups([inc], inc.id)} routes={routes} fitKey={id} /><MapLegend /></>)}
          </div>
          {detail.ambulance && <div className="row wrap"><b>{detail.ambulance.code}</b><GpsBadge f={detail.ambulance.gpsFreshness} age={detail.ambulance.gpsAgeSeconds} />{detail.ambulance.lastLocationAt && <span className="small muted">Last GPS update {fmtTime(detail.ambulance.lastLocationAt)}</span>}</div>}
          <div className="card"><h3>ETA history</h3><EtaChart points={detail.etaHistory} /></div>
          {dispatch && lastReq && <div className="card noprint"><h3>Hospital response</h3><RequestStatusCard incident={inc} requests={detail.requests} hospitals={snap.hospitals} recs={recs} /></div>}
          {dispatch && (
            <div className="card"><h3>Hospital decision &amp; requests</h3>
              {detail.requests.length === 0 ? <Empty>No hospital has been alerted yet.</Empty> : (
                <div className="tablewrap"><table className="t"><thead><tr><th>Hospital</th><th>Sent</th><th>Ack</th><th>Responded</th><th>Status</th><th>Reason / note</th></tr></thead><tbody>
                  {detail.requests.map((r) => <tr key={r.id}><td>{r.hospitalName}</td><td>{fmtTime(r.sentAt)}</td><td>{r.acknowledgedAt ? fmtDur((Date.parse(r.acknowledgedAt) - Date.parse(r.sentAt)) / 1000) : '—'}</td><td>{fmtTime(r.respondedAt)}</td>
                    <td>{REQUEST_STATUS_LABEL[r.status]}</td><td>{r.declineReason ?? r.overrideReason ?? r.infoRequestMessage ?? '—'}</td></tr>)}</tbody></table></div>)}
              {overrides.length > 0 && <div className="mt12"><h4>Manual override reasons</h4><ul className="why">{overrides.map((o) => <li key={o.id}>{fmtTime(o.at)} — {o.message}</li>)}</ul></div>}
            </div>)}
        </div>
        <div className="col">
          <div className="card"><h3>Summary</h3>
            <Kv rows={[
              ['Type', `${EMERGENCY_LABEL[inc.emergencyType]} · ${inc.patientAgeGroup.toLowerCase()}`],
              ['Needs', [...inc.requiredResources.map((r) => RESOURCE_LABEL[r]), ...inc.requiredCapabilities.map((c) => `${CAPABILITY_LABEL[c]} service`)].join(', ') || 'ER bed'],
              ['Pickup', inc.pickupAddress ?? 'Not shared with your role'], ['Pickup method', PICKUP_SOURCE_LABEL[inc.pickupSource]],
              ['Ambulance', detail.ambulance?.code ?? '—'], ['Destination', <>{detail.hospitalName ?? '—'} {inc.destinationConfirmed ? <span className="badge b-green">CONFIRMED</span> : <span className="badge b-gray">NOT CONFIRMED</span>}</>],
              ['ETA', inc.etaMinutes != null ? `${inc.etaMinutes} min` : '—'], ['Created', fmtDateTime(inc.createdAt)], ['Closed', fmtDateTime(inc.closedAt)], ['Notes', inc.preArrivalNotes || '—'],
            ]} />
            {canEscalate && <div className="mt12 noprint"><Btn kind="warn" icon="alert" onClick={() => navigate('/app/dispatch')}>Open in operations dashboard to escalate</Btn></div>}
          </div>
          <div className="card"><h3>Timeline</h3><Timeline events={detail.timeline} /></div>
          {dispatch && detail.notifications.length > 0 && <div className="card"><h3>Notifications</h3><ul className="why">{detail.notifications.map((n) => <li key={n.id}>{fmtTime(n.sentAt)} — <b>{n.title}</b>: {n.message} <span className="xs muted">[{n.status.toLowerCase()}]</span></li>)}</ul></div>}
        </div>
      </div>
      {report && <p className="xs muted noprint">Report prepared with demo data only. Use your browser’s print dialog to save as PDF.</p>}
    </div>
  );
}

export function EtaChart({ points }: { points: EtaPoint[] }) {
  if (points.length < 2) return <Empty>ETA history appears as the ambulance moves.</Empty>;
  const W = 520, H = 130, pad = 28;
  const t0 = Date.parse(points[0].at), t1 = Date.parse(points[points.length - 1].at) || t0 + 1;
  const max = Math.max(...points.map((p) => p.etaMinutes), 1);
  const x = (t: number) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad * 2);
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const path = (leg: EtaPoint['leg']) => points.filter((p) => p.leg === leg).map((p, i) => `${i ? 'L' : 'M'}${x(Date.parse(p.at)).toFixed(1)},${y(p.etaMinutes).toFixed(1)}`).join(' ');
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`ETA history, ${points.length} points, from ${points[0].etaMinutes} to ${points[points.length - 1].etaMinutes} minutes`}>
        <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#c5cdd9" /><line x1={pad} y1={pad} x2={pad} y2={H - pad} stroke="#c5cdd9" />
        <text x={4} y={pad + 4} fontSize="10" fill="#566277">{max} min</text><text x={4} y={H - pad} fontSize="10" fill="#566277">0</text>
        <path d={path('PICKUP')} fill="none" stroke="#d9650f" strokeWidth="2.5" /><path d={path('HOSPITAL')} fill="none" stroke="#6b35b8" strokeWidth="2.5" />
        <text x={pad} y={H - 8} fontSize="10" fill="#566277">{fmtTime(points[0].at)}</text><text x={W - pad} y={H - 8} fontSize="10" textAnchor="end" fill="#566277">{fmtTime(points[points.length - 1].at)}</text>
      </svg>
      <figcaption className="xs muted row gap12"><span><Icon name="route" size={12} /> <span style={{ color: '#d9650f' }}>■</span> to pickup</span><span><span style={{ color: '#6b35b8' }}>■</span> to hospital</span><span>{points.length} samples</span></figcaption>
    </figure>
  );
}
