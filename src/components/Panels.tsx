import { useState } from 'react';
import type { AppNotification, Hospital, Incident, TimelineEvent, TimelineType } from '../lib/types';
import { useApp } from '../state/app';
import { Banner, Btn, Field, Icon, fmtTime } from './ui';
import type { Snapshot } from '../server/views';

const WARN: TimelineType[] = ['HOSPITAL_NO_RESPONSE', 'GPS_LOST', 'OVERRIDE', 'ESCALATED', 'HOSPITAL_INFO_REQUESTED', 'PHONE_CALL'];
const BAD: TimelineType[] = ['HOSPITAL_DECLINED', 'INCIDENT_CANCELLED'];
const GOOD: TimelineType[] = ['HOSPITAL_ACCEPTED', 'HANDOVER_COMPLETED', 'AMBULANCE_ARRIVED', 'GPS_RESTORED', 'INCIDENT_CLOSED'];

export function Timeline({ events, max }: { events: readonly TimelineEvent[]; max?: number }) {
  const list = max ? events.slice(-max) : events;
  if (!list.length) return <div className="empty small">No events yet.</div>;
  return (
    <ol className="tl" aria-label="Incident timeline">
      {list.map((e) => (
        <li key={e.id} className={BAD.includes(e.type) ? 'bad' : WARN.includes(e.type) ? 'warn' : GOOD.includes(e.type) ? 'good' : ''}>
          <time dateTime={e.at}>{fmtTime(e.at)} · {e.actor}</time>{e.message}
        </li>
      ))}
    </ol>
  );
}

export function NotificationBell() {
  const { snap, call, backend } = useApp();
  const [open, setOpen] = useState(false);
  const list = [...(snap?.notifications ?? [])].reverse();
  const unacked = list.filter((n) => n.requiresAck && n.status !== 'ACKNOWLEDGED').length;
  return (
    <div style={{ position: 'relative' }}>
      <button className="pill" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)} aria-label={`Notifications, ${unacked} need acknowledgement`}>
        <Icon name="bell" size={14} />Alerts{unacked > 0 && <span className="badge b-solid-red">{unacked}</span>}
      </button>
      {open && (
        <div className="card" role="dialog" aria-label="Notifications" style={{ position: 'absolute', right: 0, top: 36, width: 'min(420px, 92vw)', maxHeight: '70vh', overflow: 'auto', zIndex: 700, color: 'var(--gray-900)' }}>
          <div className="row between"><h3>Notifications</h3>
            <div className="row"><Btn size="sm" kind="secondary" disabled={!unacked} onClick={() => call((t) => backend.acknowledgeAll(t))}>Acknowledge all</Btn><button className="iconbtn" aria-label="Close notifications" onClick={() => setOpen(false)}><Icon name="x" /></button></div></div>
          {list.length === 0 && <div className="empty mt8">No notifications.</div>}
          <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {list.map((n) => <NotificationRow key={n.id} n={n} />)}
          </ul>
        </div>
      )}
    </div>
  );
}

function NotificationRow({ n }: { n: AppNotification }) {
  const { call, backend } = useApp();
  const tone = n.severity === 'CRITICAL' ? 'danger' : n.severity === 'WARNING' ? 'warn' : 'info';
  return (
    <li className={`banner ${tone}`} style={{ opacity: n.status === 'ACKNOWLEDGED' ? 0.6 : 1 }}>
      <Icon name={n.type.includes('GPS') ? 'signal' : n.type.includes('HOSPITAL') ? 'hospital' : 'bell'} />
      <div className="grow"><b>{n.title}</b> <span className="xs">{fmtTime(n.sentAt)}</span><div className="small">{n.message}</div></div>
      {n.requiresAck && n.status !== 'ACKNOWLEDGED' && <Btn size="sm" kind="secondary" onClick={() => call((t) => backend.acknowledgeNotification(t, n.id))}>Acknowledge</Btn>}
      {n.status === 'ACKNOWLEDGED' && <span className="badge b-green"><Icon name="check" size={12} />ACK</span>}
    </li>
  );
}

/** Demo-only helpers (clearly labelled). Every action is audit-logged. */
export function DemoControls({ snap, incident }: { snap: Snapshot; incident: Incident | null }) {
  const { call, backend, toast } = useApp();
  const [hid, setHid] = useState('');
  const req = incident ? [...snap.requests].reverse().find((r) => r.incidentId === incident.id && ['PENDING', 'INFO_REQUESTED', 'NO_RESPONSE'].includes(r.status)) : undefined;
  const amb = incident?.assignedAmbulanceId ? snap.ambulances.find((a) => a.id === incident.assignedAmbulanceId) : undefined;
  const hospitals: Hospital[] = snap.hospitals;
  const run = async (fn: (t: string) => unknown | Promise<unknown>, ok?: string) => { await call(fn, { ok }); };
  return (
    <details className="card flat" open>
      <summary style={{ cursor: 'pointer', fontWeight: 700 }}><span className="badge b-purple">DEMO</span> Simulation controls</summary>
      <div className="col mt8">
        <Banner kind="info">Demo mode: GPS moves every 10 s (×{snap.config.simCompression} time compression). Hospital responses can be simulated here for presentations. All actions are audit-logged.</Banner>
        <div className="row wrap">
          <Btn size="sm" kind="secondary" onClick={async () => { const r = await call((t) => backend.demoTriggerCapacityChange(t, hid || undefined)); if (r.ok) toast(String(r.value), 'info'); }}>Trigger capacity change</Btn>
          <select className="inp" style={{ width: 'auto', minHeight: 32 }} aria-label="Hospital for capacity actions" value={hid} onChange={(e) => setHid(e.target.value)}>
            <option value="">Random hospital</option>{hospitals.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</select>
          <Btn size="sm" kind="secondary" disabled={!hid} onClick={() => run((t) => backend.demoAgeCapacity(t, hid, 20), 'Capacity data aged by 20 minutes.')}>Age data +20 min</Btn>
        </div>
        <div className="row wrap">
          <Btn size="sm" kind="good" disabled={!req} onClick={() => run((t) => backend.demoRespond(t, req!.id, 'ACCEPT'), 'Hospital acceptance simulated.')}>Simulate hospital accept</Btn>
          <Btn size="sm" kind="danger" disabled={!req} onClick={() => run((t) => backend.demoRespond(t, req!.id, 'DECLINE'), 'Hospital decline simulated.')}>Simulate hospital decline</Btn>
        </div>
        <div className="row wrap">
          <Btn size="sm" kind="secondary" disabled={!amb || amb.status !== 'ASSIGNED'} onClick={() => run((t) => backend.demoCrewDepart(t, amb!.id), 'Crew trip started (simulated).')}>Crew: start trip &amp; depart</Btn>
          <Btn size="sm" kind="warn" disabled={!amb} onClick={async () => { const r = await call((t) => backend.demoToggleSignalLoss(t, amb!.id)); if (r.ok) toast(r.value ? 'GPS/network loss simulated.' : 'GPS signal restored.', 'info'); }}>Toggle GPS/network loss</Btn>
          <Btn size="sm" kind="secondary" onClick={() => run(() => backend.system.tick())}>Advance GPS now</Btn>
        </div>
        <div className="row wrap">
          <label className="small row">Speed ×<select className="inp" style={{ width: 'auto', minHeight: 32 }} value={snap.config.simCompression} onChange={(e) => run((t) => backend.demoSetCompression(t, Number(e.target.value)))}>
            {[1, 6, 12, 30].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <Btn size="sm" kind="ghost" onClick={() => { if (confirm('Reset all demo data to the seeded scenarios?')) void run((t) => backend.demoReset(t), 'Demo data reset.'); }}>Reset demo data</Btn>
        </div>
      </div>
    </details>
  );
}

export function Kv({ rows }: { rows: [string, React.ReactNode][] }) {
  return <dl className="kv">{rows.map(([k, v]) => <><dt key={`k${k}`}>{k}</dt><dd key={`v${k}`}>{v}</dd></>)}</dl>;
}

export { Field };
