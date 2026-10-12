import { useEffect, useRef, useState } from 'react';
import { formatAge } from '../lib/freshness';
import { CAPABILITY_LABEL, DECLINE_REASONS, EMERGENCY_LABEL, PREP_LABEL, RESOURCE_LABEL } from '../lib/labels';
import { ACCEPTANCE_STATUSES, CAPABILITIES, PREP_ITEMS, type AcceptanceStatus, type Capability } from '../lib/types';
import type { IncomingCase } from '../server/views';
import { useApp, useNow } from '../state/app';
import { AcceptanceBadge, Banner, Btn, ConfirmDialog, Empty, Field, FreshnessBadge, GpsBadge, Icon, Modal, SeverityBadge, Spinner, fmtTime, mmss } from '../components/ui';
import { Kv, Timeline } from '../components/Panels';

const CAP_KEYS = [
  ['availableErBeds', 'totalErBeds', 'ER beds'], ['availableIcuBeds', 'totalIcuBeds', 'ICU beds'], ['availableVentilators', 'totalVentilators', 'Ventilators'],
  ['availableTraumaBays', 'totalTraumaBays', 'Trauma bays'], ['availableIsolationBeds', 'totalIsolationBeds', 'Isolation beds'],
] as const;

export function HospitalPage() {
  const { snap, user, call, backend } = useApp();
  const now = useNow(1000);
  const hospital = snap?.hospitals[0];
  const status = hospital ? snap?.resourceStatus[hospital.id] : undefined;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState(false);
  const [statusChange, setStatusChange] = useState<AcceptanceStatus | null>(null);
  const [busy, setBusy] = useState(false);

  // Adopt server values when the hospital changes or when the user has no unsaved edits; keep in-progress edits otherwise.
  const prevServer = useRef<{ id: string; vals: Record<string, string>; notes: string } | null>(null);
  const serverKey = status ? CAP_KEYS.map(([a]) => status[a]).join(',') + `|${status.operationalNotes}|${status.updatedAt}` : '';
  useEffect(() => {
    if (!status || !hospital) return;
    const vals = Object.fromEntries(CAP_KEYS.map(([a]) => [a, String(status[a])]));
    const p = prevServer.current;
    const untouched = !!p && p.id === hospital.id && CAP_KEYS.every(([a]) => draft[a] === p.vals[a]) && notes === p.notes;
    if (!p || p.id !== hospital.id || untouched) { setDraft(vals); setNotes(status.operationalNotes); setErrors({}); }
    prevServer.current = { id: hospital.id, vals, notes: status.operationalNotes };
  }, [hospital?.id, serverKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!snap || !user) return <Spinner label="Loading hospital dashboard…" />;
  if (!hospital || !status) return <div className="page"><Banner kind="danger">Your account is not linked to a hospital. Contact an administrator.</Banner></div>;
  const dirty = CAP_KEYS.some(([a]) => String(status[a]) !== draft[a]) || notes !== status.operationalNotes;
  const stale = status.freshness === 'STALE' || status.freshness === 'UNAVAILABLE';
  const pending = snap.incoming.filter((c) => ['PENDING', 'INFO_REQUESTED', 'NO_RESPONSE'].includes(c.request.status));
  const accepted = snap.incoming.filter((c) => c.request.status === 'ACCEPTED' && !['CLOSED', 'CANCELLED'].includes(c.incident.status));
  const history = snap.incoming.filter((c) => !pending.includes(c) && !accepted.includes(c)).slice(-6).reverse();

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    for (const [a, t, label] of CAP_KEYS) {
      const raw = (draft[a] ?? '').trim(); const v = Number(raw);
      if (raw === '' || !Number.isFinite(v) || !Number.isInteger(v)) e[a] = `${label} must be a whole number.`;
      else if (v < 0) e[a] = `${label} cannot be negative.`;
      else if (v > hospital[t]) e[a] = `${label} cannot exceed total capacity (${hospital[t]}).`;
    }
    return e;
  };
  const trySave = () => { const e = validate(); setErrors(e); if (Object.keys(e).length === 0) setConfirm(true); };
  const save = async () => {
    setBusy(true);
    const patch = Object.fromEntries(CAP_KEYS.map(([a]) => [a, Number(draft[a])]));
    const r = await call((t) => backend.updateCapacity(t, hospital.id, patch, true, notes), { ok: 'Capacity updated and verified.' });
    setBusy(false);
    if (r.ok) setConfirm(false); else if (r.fields) { setErrors(r.fields); setConfirm(false); }
  };

  return (
    <div className="page">
      <div className="card row between wrap">
        <div><h1>{hospital.name}</h1><p className="small muted">{hospital.address} · Emergency contact {hospital.emergencyContact}</p></div>
        <div className="col" style={{ alignItems: 'flex-end' }}>
          <div className="row wrap"><AcceptanceBadge s={status.acceptanceStatus} /><FreshnessBadge f={status.freshness} age={status.ageMinutes} /></div>
          <p className="small muted">Last verified: <b>{status.lastVerifiedAt ? `${fmtTime(status.lastVerifiedAt)} (${formatAge(status.ageMinutes)})` : 'never'}</b> by {status.updatedBy}</p>
        </div>
      </div>

      {stale && <Banner kind="warn" icon="clock"><b>Your capacity information is {status.freshness === 'UNAVAILABLE' ? 'unavailable' : `stale (${formatAge(status.ageMinutes)})`}.</b> Dispatchers see a low-confidence warning and your hospital is ranked lower{status.freshness === 'UNAVAILABLE' ? ' and treated as ineligible' : ''}. Confirm current availability now.
        <div className="mt8"><Btn kind="good" size="sm" icon="check" onClick={() => call((t) => backend.confirmAvailability(t, hospital.id), { ok: 'Availability confirmed.' })}>Confirm current availability</Btn></div></Banner>}

      <section aria-label="Incoming ambulance requests" className="col">
        <h2>Incoming cases {pending.length > 0 && <span className="badge b-solid-red">{pending.length} need response</span>}</h2>
        <Banner kind="info" icon="shield">Accepting a case tells dispatch and the crew that the destination is confirmed and the listed resources are reserved for the patient. Declining or requesting more information is always available.</Banner>
        {pending.length + accepted.length === 0 && <Empty>No incoming ambulances right now.</Empty>}
        {[...pending, ...accepted].map((c) => <CaseCard key={c.request.id} c={c} now={now} />)}
      </section>

      <section className="card col" aria-label="Capacity">
        <div className="row between wrap"><h2>Emergency capacity</h2>
          <div className="row wrap"><Btn kind="secondary" icon="check" onClick={() => call((t) => backend.confirmAvailability(t, hospital.id), { ok: 'Availability confirmed as current.' })}>Confirm current availability</Btn></div></div>
        <div className="capgrid">
          {CAP_KEYS.map(([a, t, label]) => {
            const val = Number(status[a]);
            return (
              <div key={a} className={`cap ${val === 0 ? 'zero' : ''}`}>
                <div className="small muted"><b>{label}</b> available</div><div className="n">{val}<span className="small muted"> / {hospital[t]}</span></div>
                <Field label={`Set ${label}`} error={errors[a]}>
                  <input type="number" inputMode="numeric" min={0} max={hospital[t]} step={1} value={draft[a] ?? ''} onChange={(e) => { setDraft({ ...draft, [a]: e.target.value }); setErrors({ ...errors, [a]: '' }); }} aria-invalid={!!errors[a]} />
                </Field>
                {hospital[t] === 0 && <p className="xs muted">No {label.toLowerCase()} configured.</p>}
              </div>
            );
          })}
        </div>
        <Field label="Operational note (shown to dispatchers)"><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={240} /></Field>
        <div className="row"><Btn disabled={!dirty} onClick={trySave}>Review &amp; save changes</Btn>{dirty && <Btn kind="ghost" onClick={() => { setDraft(Object.fromEntries(CAP_KEYS.map(([a]) => [a, String(status[a])]))); setNotes(status.operationalNotes); setErrors({}); }}>Discard</Btn>}</div>
      </section>

      <div className="grid2">
        <section className="card col" aria-label="Acceptance status">
          <h2>Acceptance status</h2>
          <div className="seg" role="group" aria-label="Emergency acceptance status" style={{ flexWrap: 'wrap' }}>
            {ACCEPTANCE_STATUSES.map((s) => <button key={s} aria-pressed={status.acceptanceStatus === s} onClick={() => s !== status.acceptanceStatus && setStatusChange(s)}>{s.replace('_', ' ')}</button>)}</div>
          <p className="small muted">Diverting or unavailable removes this hospital from recommendations immediately.</p>
        </section>
        <section className="card col" aria-label="Service availability">
          <h2>Service availability</h2>
          <div className="grid2">{CAPABILITIES.map((c: Capability) => (
            <label key={c} className={`chk ${hospital.capabilities[c] ? 'on' : ''}`}><input type="checkbox" checked={hospital.capabilities[c]} onChange={(e) => call((t) => backend.setCapabilities(t, hospital.id, { [c]: e.target.checked }), { ok: `${CAPABILITY_LABEL[c]} service ${e.target.checked ? 'available' : 'unavailable'}.` })} />{CAPABILITY_LABEL[c]}</label>))}</div>
        </section>
      </div>

      <section className="card col"><h2>Recent cases</h2>
        {history.length === 0 ? <Empty>No completed cases yet.</Empty> : <div className="tablewrap"><table className="t"><thead><tr><th>Incident</th><th>Type</th><th>Severity</th><th>Outcome</th><th>Responded</th></tr></thead><tbody>
          {history.map((c) => <tr key={c.request.id}><td>{c.incident.incidentCode}</td><td>{EMERGENCY_LABEL[c.incident.emergencyType]}</td><td><SeverityBadge s={c.incident.severity} /></td><td>{c.request.status.replace(/_/g, ' ').toLowerCase()}{c.request.declineReason ? ` — ${c.request.declineReason}` : ''}</td><td>{fmtTime(c.request.respondedAt)}</td></tr>)}</tbody></table></div>}
      </section>

      {confirm && (
        <ConfirmDialog title="Confirm capacity update" confirmText="Save & verify" busy={busy} onConfirm={save} onCancel={() => setConfirm(false)}>
          <p>These values will be visible to dispatchers immediately and recorded in the audit log.</p>
          <table className="t"><thead><tr><th>Resource</th><th>Current</th><th>New</th></tr></thead><tbody>{CAP_KEYS.map(([a, , label]) => <tr key={a}><td>{label}</td><td>{status[a]}</td><td><b>{draft[a]}</b></td></tr>)}</tbody></table>
        </ConfirmDialog>)}
      {statusChange && (
        <ConfirmDialog title={`Change status to ${statusChange.replace('_', ' ')}?`} confirmText="Change status" danger={statusChange === 'DIVERTING' || statusChange === 'UNAVAILABLE'} onCancel={() => setStatusChange(null)}
          onConfirm={async () => { const r = await call((t) => backend.setAcceptanceStatus(t, hospital.id, statusChange), { ok: `Status set to ${statusChange.replace('_', ' ').toLowerCase()}.` }); if (r.ok) setStatusChange(null); }}>
          {(statusChange === 'DIVERTING' || statusChange === 'UNAVAILABLE') ? <Banner kind="warn">Dispatchers will stop receiving this hospital as a recommended destination, and pending incoming cases will be flagged for review.</Banner> : <p>Dispatchers will see this status immediately.</p>}
        </ConfirmDialog>)}
    </div>
  );
}

function CaseCard({ c, now }: { c: IncomingCase; now: number }) {
  const { call, backend } = useApp();
  const { request: r, incident: inc } = c;
  const [decline, setDecline] = useState(false);
  const [info, setInfo] = useState(false);
  const [detail, setDetail] = useState(false);
  const arrivalSec = inc.etaMinutes != null && inc.etaUpdatedAt ? Math.max(0, inc.etaMinutes * 60 - (now - Date.parse(inc.etaUpdatedAt)) / 1000) : null;
  const ackLeft = (Date.parse(r.sentAt) + backend.ctx.db.config.ackTimeoutSec * 1000 - now) / 1000;
  const needs = [...inc.requiredResources.map((x) => RESOURCE_LABEL[x]), ...inc.requiredCapabilities.map((x) => `${CAPABILITY_LABEL[x]} service`)];
  const isAccepted = r.status === 'ACCEPTED';
  const arrived = ['ARRIVED'].includes(inc.status);
  return (
    <article className={`case ${inc.severity === 'CRITICAL' ? 'crit' : ''} ${isAccepted ? 'accepted' : ''}`} aria-label={`Incoming ${inc.incidentCode}`}>
      <div className="row between wrap"><div className="row wrap"><b style={{ fontSize: '1.1rem' }}>{inc.incidentCode}</b><SeverityBadge s={inc.severity} /><span className="badge b-navy">{EMERGENCY_LABEL[inc.emergencyType]}</span>
        {isAccepted ? <span className="badge b-green"><Icon name="check" size={12} />ACCEPTED</span> : r.status === 'NO_RESPONSE' ? <span className="badge b-red">TIMED OUT — dispatcher may redirect</span> : r.status === 'INFO_REQUESTED' ? <span className="badge b-amber">INFO REQUESTED</span> : <span className="badge b-amber">AWAITING YOUR RESPONSE</span>}</div>
        <div style={{ textAlign: 'right' }}><div className="small muted">{arrived ? 'Arrived' : 'Ambulance ETA'}</div><div className="countdown" aria-live="off">{arrived ? '00:00' : arrivalSec != null ? mmss(arrivalSec) : '—'}</div></div></div>
      <div className="grid2 small"><div><span className="muted">Ambulance</span><div><b>{c.ambulanceCode ?? '—'}</b> {c.gpsFreshness && <GpsBadge f={c.gpsFreshness as 'LIVE' | 'STALE' | 'LOST' | 'NONE'} />}</div></div>
        <div><span className="muted">Required</span><div><b>{needs.join(', ') || 'ER bed'}</b></div></div></div>
      <p className="small"><span className="muted">Pre-arrival note: </span>{inc.preArrivalNotes || '—'}</p>
      {r.dispatcherReply && <Banner kind="info">Dispatcher replied: {r.dispatcherReply}</Banner>}
      {r.status === 'PENDING' && !r.acknowledgedAt && <p className="small muted">Dispatch auto-flags “no response” in <b className="mono">{mmss(ackLeft)}</b>. Please respond promptly.</p>}
      {!isAccepted && ['PENDING', 'INFO_REQUESTED', 'NO_RESPONSE'].includes(r.status) && (
        <div className="row wrap">
          <Btn kind="good" icon="check" onClick={async () => { await call((t) => backend.respondToRequest(t, r.id, { decision: 'ACCEPT', reservedResources: inc.requiredResources }), { ok: 'Case accepted. Dispatch and crew notified.' }); }}>Accept</Btn>
          <Btn kind="danger" icon="x" onClick={() => setDecline(true)}>Decline</Btn>
          <Btn kind="secondary" icon="info" onClick={() => setInfo(true)}>Request more information</Btn>
          <Btn kind="ghost" size="sm" onClick={() => setDetail(true)}>Case timeline</Btn>
        </div>)}
      {isAccepted && (
        <div className="col"><h4>Arrival preparation checklist <span className="xs muted">(operational only — not clinical advice)</span></h4>
          <div className="grid2">{PREP_ITEMS.map((p) => <label key={p} className={`chk ${r.prepChecklist[p] ? 'on' : ''}`}><input type="checkbox" checked={r.prepChecklist[p]} onChange={(e) => call((t) => backend.updatePrep(t, r.id, p, e.target.checked))} />{PREP_LABEL[p]}</label>)}</div>
          <div className="row wrap"><Btn size="sm" kind="ghost" onClick={() => setDetail(true)}>Case timeline</Btn>
            <Btn kind="good" disabled={!arrived} icon="check" onClick={() => call((t) => backend.confirmHandover(t, r.id), { ok: 'Patient handover confirmed.' })}>Confirm patient handover / arrival</Btn>
            {!arrived && <span className="small muted">Available once the ambulance has arrived.</span>}</div></div>)}
      {decline && <DeclineDialog id={r.id} onClose={() => setDecline(false)} />}
      {info && <InfoDialog id={r.id} onClose={() => setInfo(false)} />}
      {detail && <CaseTimeline id={inc.id} onClose={() => setDetail(false)} />}
    </article>
  );
}

function DeclineDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { call, backend } = useApp();
  const [reason, setReason] = useState(DECLINE_REASONS[0]);
  const [other, setOther] = useState('');
  const text = reason.startsWith('Other') ? other : reason;
  return (
    <ConfirmDialog title="Decline this incoming case?" confirmText="Decline case" danger disabled={text.trim().length < 3} onCancel={onClose}
      onConfirm={async () => { const r = await call((t) => backend.respondToRequest(t, id, { decision: 'DECLINE', declineReason: text }), { ok: 'Case declined. Dispatch is re-ranking alternatives.' }); if (r.ok) onClose(); }}>
      <Banner kind="warn">Declining immediately notifies dispatch, who will re-route the ambulance. Please be accurate.</Banner>
      <Field label="Decline reason (required)"><select value={reason} onChange={(e) => setReason(e.target.value)}>{DECLINE_REASONS.map((d) => <option key={d}>{d}</option>)}</select></Field>
      {reason.startsWith('Other') && <Field label="Describe the reason"><input value={other} onChange={(e) => setOther(e.target.value)} maxLength={160} /></Field>}
    </ConfirmDialog>
  );
}

function InfoDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { call, backend } = useApp();
  const [msg, setMsg] = useState('');
  return (
    <Modal title="Request more information" small onClose={onClose} footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn disabled={msg.trim().length < 3} onClick={async () => { const r = await call((t) => backend.respondToRequest(t, id, { decision: 'MORE_INFO', note: msg }), { ok: 'Question sent to dispatch.' }); if (r.ok) onClose(); }}>Send question</Btn></>}>
      <Field label="What do you need to know?" hint="Dispatch will reply in the incident thread. The case stays pending."><input value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={240} placeholder="e.g. Is the patient intubated?" /></Field>
    </Modal>
  );
}

function CaseTimeline({ id, onClose }: { id: string; onClose: () => void }) {
  const { backend, token } = useApp();
  const d = token ? backend.getIncidentDetail(token, id) : null;
  return (
    <Modal title="Case timeline" small onClose={onClose}>
      {d && <Kv rows={[['Incident', d.incident.incidentCode], ['Status', d.incident.status.replace(/_/g, ' ').toLowerCase()], ['Ambulance', d.ambulance?.code ?? '—']]} />}
      <Timeline events={d?.timeline ?? []} />
    </Modal>
  );
}
