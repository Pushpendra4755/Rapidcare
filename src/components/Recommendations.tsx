import { useState } from 'react';
import { formatAge } from '../lib/freshness';
import { CAPABILITY_LABEL, CALL_OUTCOMES, OVERRIDE_REASONS, RESOURCE_LABEL, REQUEST_STATUS_LABEL } from '../lib/labels';
import type { Hospital, HospitalRecommendation, HospitalRequest, HospitalResourceStatus, Incident } from '../lib/types';
import { useApp, useNow } from '../state/app';
import { AcceptanceBadge, Banner, Btn, ConfirmDialog, Empty, Field, FreshnessBadge, Icon, Modal, RecLabelBadge, fmtTime, mmss } from './ui';

interface PanelProps {
  incident: Incident;
  recs: HospitalRecommendation[];
  hospitals: Hospital[];
  status: Record<string, HospitalResourceStatus>;
  requests: HospitalRequest[];
  previewId: string | null;
  onPreview: (hospitalId: string | null) => void;
  onHighlight: (hospitalId: string | null) => void;
}

/** Ranked hospital recommendations with explanations. "Recommended destination" only — hospital acceptance confirms it. */
export function RecommendationPanel(p: PanelProps) {
  const [showAlt, setShowAlt] = useState(false);
  const [override, setOverride] = useState(false);
  const [sendTo, setSendTo] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const eligible = p.recs.filter((r) => r.eligible);
  const ineligible = p.recs.filter((r) => !r.eligible);
  const visible = override ? p.recs : showAlt ? [...eligible] : eligible.slice(0, 1);
  const activeReq = [...p.requests].reverse().find((r) => ['PENDING', 'INFO_REQUESTED', 'ACCEPTED'].includes(r.status));
  const hn = (id: string) => p.hospitals.find((h) => h.id === id)?.name ?? id;

  return (
    <div className="col">
      <div className="row between wrap">
        <h3>Recommended destination</h3>
        <div className="row wrap">
          {eligible.length > 1 && !override && <Btn size="sm" kind="secondary" onClick={() => setShowAlt((v) => !v)}>{showAlt ? 'Hide alternatives' : `View alternatives (${eligible.length - 1})`}</Btn>}
          <Btn size="sm" kind={override ? 'warn' : 'secondary'} onClick={() => setOverride((v) => !v)} aria-pressed={override}>{override ? 'Exit override mode' : 'Manually override recommendation'}</Btn>
        </div>
      </div>
      <Banner kind="info" icon="shield">Decision support only. A destination is <b>confirmed only when the hospital accepts</b> — sending an alert does not reserve a bed.</Banner>
      {override && <Banner kind="warn">Override mode: all hospitals are shown. Choosing a non-recommended or ineligible hospital requires a documented reason (and explicit confirmation if ineligible).</Banner>}
      {!eligible.length && <Banner kind="danger">No eligible hospital found. Call hospitals directly, review stale/unavailable data, or use override mode with a documented reason.</Banner>}
      {!p.incident.assignedAmbulanceId && eligible.length > 0 && <Banner kind="warn">Assign an ambulance before sending a hospital alert.</Banner>}
      {visible.length === 0 && <Empty>No hospitals to show.</Empty>}
      {visible.map((r) => {
        const h = p.hospitals.find((x) => x.id === r.hospitalId); const s = p.status[r.hospitalId];
        if (!h || !s) return null;
        const best = r.label === 'BEST_MATCH'; const stale = r.label === 'STALE_VERIFY';
        const isActive = activeReq?.hospitalId === r.hospitalId;
        return (
          <article key={r.id} className={`rec ${best ? 'best' : stale ? 'stale' : r.eligible ? '' : 'no'}`} aria-label={`${h.name}, ${r.label}`}
            onMouseEnter={() => p.onHighlight(r.hospitalId)} onMouseLeave={() => p.onHighlight(null)}>
          <div className="row between">
              <div className="grow"><div className="row wrap"><b>{r.rank ? `#${r.rank} ` : ''}{h.name}</b><RecLabelBadge l={r.label} /></div>
                <div className="row wrap gap4 mt8"><AcceptanceBadge s={s.acceptanceStatus} /><FreshnessBadge f={r.freshness} age={r.capacityAgeMinutes} />
                  {isActive && <span className="badge b-navy"><Icon name="bell" size={12} />{REQUEST_STATUS_LABEL[activeReq!.status]}</span>}</div></div>
              {r.eligible && <div className="right" style={{ textAlign: 'right' }}><div className="score" aria-label={`Score ${r.finalScore}`}>{r.finalScore}</div><div className="xs muted">score</div></div>}
            </div>
            <div className="metrics">
              <div><span className="muted">Distance</span><b>{r.distanceKm ?? '—'} km</b></div>
              <div><span className="muted">ETA</span><b>{r.etaMinutes ?? '—'} min</b></div>
              <div><span className="muted">ER / ICU beds</span><b>{s.availableErBeds} / {s.availableIcuBeds}</b></div>
              <div><span className="muted">Verified</span><b>{formatAge(r.capacityAgeMinutes)}</b></div>
            </div>
            {r.eligible && (
              <div className="grid2 small">
                <div>Resource match {r.resourceMatchScore}%<div className="bar"><i style={{ width: `${r.resourceMatchScore}%` }} /></div></div>
                <div>Specialty match {r.specialtyMatchScore}%<div className="bar"><i style={{ width: `${r.specialtyMatchScore}%` }} /></div></div>
              </div>
            )}
            <p className="small"><b>{r.summary}</b></p>
            {r.ineligibilityReasons.length > 0 && <ul className="why bad">{r.ineligibilityReasons.map((m, i) => <li key={i}><Icon name="x" size={12} /> {m}</li>)}</ul>}
            {r.warnings.length > 0 && <ul className="why" style={{ color: '#8a5a00', fontWeight: 600 }}>{r.warnings.map((m, i) => <li key={i}>{m}</li>)}</ul>}
            {r.reasons.length > 0 && <details><summary className="small" style={{ cursor: 'pointer' }}>Why this ranking</summary><ul className="why">{r.reasons.map((m, i) => <li key={i}>{m}</li>)}
              <li>Score = 40% resources {r.resourceMatchScore} · 25% specialty {r.specialtyMatchScore} · 20% ETA {r.etaScore} · 10% freshness {r.freshnessScore} · 5% workload {r.workloadScore}</li></ul></details>}
            <div className="row wrap">
              <Btn size="sm" kind={sel === r.hospitalId ? '' : 'secondary'} aria-pressed={sel === r.hospitalId} onClick={() => { setSel(r.hospitalId); p.onHighlight(r.hospitalId); }}>{sel === r.hospitalId ? '✓ Selected' : 'Select hospital'}</Btn>
              <Btn size="sm" kind="secondary" icon="route" onClick={() => p.onPreview(p.previewId === r.hospitalId ? null : r.hospitalId)}>{p.previewId === r.hospitalId ? 'Hide route' : 'View route'}</Btn>
              <Btn size="sm" kind={r.eligible ? '' : 'warn'} icon="bell" disabled={!p.incident.assignedAmbulanceId || isActive} onClick={() => { setSel(r.hospitalId); setSendTo(r.hospitalId); }}>
                {isActive ? 'Alert active' : r.eligible ? 'Send alert' : 'Override & send…'}</Btn>
              <a className="btn secondary sm" href={`tel:${h.emergencyContact}`}><Icon name="phone" size={14} />Call {h.emergencyContact}</a>
            </div>
          </article>
        );
      })}
      {!override && ineligible.length > 0 && <p className="small muted">{ineligible.length} hospital{ineligible.length > 1 ? 's' : ''} not eligible: {ineligible.map((r) => `${hn(r.hospitalId)} (${r.ineligibilityReasons[0]?.replace('Not eligible: ', '')})`).join(' · ')}</p>}
      {sendTo && <SendDialog incident={p.incident} rec={p.recs.find((r) => r.hospitalId === sendTo)!} top={eligible[0]} hospital={p.hospitals.find((h) => h.id === sendTo)!} activeReq={activeReq} hospitals={p.hospitals} onClose={() => setSendTo(null)} />}
    </div>
  );
}

function SendDialog({ incident, rec, top, hospital, activeReq, hospitals, onClose }: { incident: Incident; rec: HospitalRecommendation; top?: HospitalRecommendation; hospital: Hospital; activeReq?: HospitalRequest; hospitals: Hospital[]; onClose: () => void }) {
  const { call, backend } = useApp();
  const needsOverride = !rec.eligible || (!!top && top.hospitalId !== rec.hospitalId);
  const [reasonKey, setReasonKey] = useState(OVERRIDE_REASONS[0]);
  const [custom, setCustom] = useState('');
  const [ackIneligible, setAckIneligible] = useState(false);
  const [ackStale, setAckStale] = useState(false);
  const [ackRedirect, setAckRedirect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const stale = rec.eligible && rec.freshness === 'STALE';
  const reason = reasonKey.startsWith('Other') ? custom : reasonKey;
  const redirecting = activeReq && ['PENDING', 'INFO_REQUESTED', 'ACCEPTED'].includes(activeReq.status);
  const ready = (!needsOverride || reason.trim().length >= 3) && (rec.eligible || ackIneligible) && (!stale || ackStale) && (!redirecting || ackRedirect);
  const submit = async () => {
    setBusy(true);
    const r = await call((t) => backend.sendHospitalRequest(t, incident.id, hospital.id, {
      overrideConfirmed: !rec.eligible ? ackIneligible : undefined, overrideReason: needsOverride ? reason : undefined, staleAcknowledged: ackStale, confirmReassignDestination: ackRedirect,
    }), { ok: `Incoming-case alert sent to ${hospital.name}. Awaiting hospital acceptance.` });
    setBusy(false);
    if (r.ok) onClose(); else setErr(r.fields ?? {});
  };
  return (
    <ConfirmDialog title={`Send incoming-case alert to ${hospital.name}?`} confirmText="Send alert" busy={busy} disabled={!ready} onConfirm={submit} onCancel={onClose} danger={!rec.eligible}>
      <Banner kind="info" icon="shield">This sends an alert only. <b>No bed is reserved</b> until {hospital.name} explicitly accepts. The hospital has {backend.ctx.db.config.ackTimeoutSec} s to acknowledge.</Banner>
      <dl className="kv"><dt>Incident</dt><dd>{incident.incidentCode} · {incident.severity}</dd><dt>Needs</dt><dd>{[...incident.requiredResources.map((r) => RESOURCE_LABEL[r]), ...incident.requiredCapabilities.map((c) => CAPABILITY_LABEL[c])].join(', ') || 'ER bed'}</dd>
        <dt>ETA</dt><dd>{rec.etaMinutes ?? '—'} min · {rec.distanceKm ?? '—'} km</dd><dt>Emergency contact</dt><dd>{hospital.emergencyContact}</dd></dl>
      {!rec.eligible && (<><Banner kind="danger">{rec.ineligibilityReasons.join(' ')}</Banner>
        <label className="chk"><input type="checkbox" checked={ackIneligible} onChange={(e) => setAckIneligible(e.target.checked)} /> I understand this hospital is <b>not eligible</b> and explicitly override.</label></>)}
      {stale && (<><Banner kind="warn">Capacity data is stale. Verify by phone before relying on it.</Banner>
        <label className="chk"><input type="checkbox" checked={ackStale} onChange={(e) => setAckStale(e.target.checked)} /> I will verify capacity with the hospital by phone.</label></>)}
      {needsOverride && (<>
        <Field label="Override reason (required)" error={err.overrideReason}>
          <select value={reasonKey} onChange={(e) => setReasonKey(e.target.value)}>{OVERRIDE_REASONS.map((r) => <option key={r}>{r}</option>)}</select></Field>
        {reasonKey.startsWith('Other') && <Field label="Describe the reason" error={err.overrideReason}><input value={custom} onChange={(e) => setCustom(e.target.value)} maxLength={200} /></Field>}
        <p className="small muted">Recommended: {top ? hospitals.find((h) => h.id === top.hospitalId)?.name : 'none'}. The override and reason are recorded in the incident timeline and audit log.</p></>)}
      {redirecting && (<><Banner kind="warn">An alert to {hospitals.find((h) => h.id === activeReq!.hospitalId)?.name} is {activeReq!.status === 'ACCEPTED' ? 'already accepted' : 'pending'}. Sending a new alert cancels it.</Banner>
        <label className="chk"><input type="checkbox" checked={ackRedirect} onChange={(e) => setAckRedirect(e.target.checked)} /> Cancel the existing request and redirect.</label></>)}
    </ConfirmDialog>
  );
}

/** Live status of the active hospital request with timeout countdown, phone fallback and escalation. */
export function RequestStatusCard({ incident, requests, hospitals, recs }: { incident: Incident; requests: HospitalRequest[]; hospitals: Hospital[]; recs: HospitalRecommendation[] }) {
  const { call, backend } = useApp();
  const now = useNow(1000);
  const [callFor, setCallFor] = useState<HospitalRequest | null>(null);
  const [confirmEsc, setConfirmEsc] = useState(false);
  const [reply, setReply] = useState('');
  const mine = requests.filter((r) => r.incidentId === incident.id);
  const r = [...mine].reverse().find((x) => x.status !== 'CANCELLED' && x.status !== 'ESCALATED') ?? mine[mine.length - 1];
  if (!r) return null;
  const h = hospitals.find((x) => x.id === r.hospitalId);
  const cfg = backend.ctx.db.config;
  const left = r.status === 'PENDING' ? (Date.parse(r.sentAt) + (r.acknowledgedAt ? 0 : cfg.ackTimeoutSec * 1000) - now) / 1000 : null;
  const alt = recs.filter((x) => x.eligible && x.hospitalId !== r.hospitalId);
  const tone = r.status === 'ACCEPTED' ? 'ok' : r.status === 'DECLINED' || r.status === 'NO_RESPONSE' ? 'danger' : 'warn';
  return (
    <div className="col">
      <Banner kind={tone as 'ok' | 'danger' | 'warn'} icon={r.status === 'ACCEPTED' ? 'check' : 'bell'}>
        <b>{h?.name}</b>: {REQUEST_STATUS_LABEL[r.status]}
        {r.status === 'ACCEPTED' && <> — destination confirmed{r.reservedResources.length ? `; hospital reserved ${r.reservedResources.map((x) => RESOURCE_LABEL[x]).join(', ')}` : r.decision === 'PHONE_ACCEPT' ? ' by phone' : ''}.</>}
        {r.status === 'PENDING' && !r.acknowledgedAt && left != null && <> — not yet acknowledged · timeout in <b className="mono">{mmss(left)}</b></>}
        {r.status === 'PENDING' && r.acknowledgedAt && <> — acknowledged {fmtTime(r.acknowledgedAt)}, awaiting decision.</>}
        {r.status === 'DECLINED' && <> — reason: {r.declineReason}</>}
        {r.status === 'NO_RESPONSE' && <><br />Hospital request timed out. Review alternatives or call emergency contact: <b>{h?.emergencyContact}</b></>}
        {r.status === 'INFO_REQUESTED' && <><br />Hospital asks: “{r.infoRequestMessage}”</>}
        {r.status !== 'ACCEPTED' && r.status !== 'PENDING' && r.status !== 'INFO_REQUESTED' && !incident.destinationConfirmed && <><br />No confirmed destination — no bed is reserved.</>}
      </Banner>
      {r.status === 'INFO_REQUESTED' && (
        <div className="row"><input className="inp" placeholder="Reply to hospital…" value={reply} onChange={(e) => setReply(e.target.value)} maxLength={240} aria-label="Reply to hospital" />
          <Btn size="sm" disabled={reply.trim().length < 3} onClick={async () => { const x = await call((t) => backend.replyToInfoRequest(t, r.id, reply), { ok: 'Reply sent.' }); if (x.ok) setReply(''); }}>Send reply</Btn></div>)}
      <div className="row wrap">
        {h && <a className="btn secondary sm" href={`tel:${h.emergencyContact}`}><Icon name="phone" size={14} />Contact hospital</a>}
        {['PENDING', 'INFO_REQUESTED', 'NO_RESPONSE'].includes(r.status) && <Btn size="sm" kind="secondary" onClick={() => setCallFor(r)}>Record phone call</Btn>}
        {(r.status === 'NO_RESPONSE' || r.status === 'DECLINED' || incident.severity === 'CRITICAL') && <Btn size="sm" kind="warn" icon="alert" onClick={() => setConfirmEsc(true)}>Escalate incident</Btn>}
        {r.status === 'NO_RESPONSE' && alt.length > 0 && <span className="small muted">Next best: <b>{hospitals.find((x) => x.id === alt[0].hospitalId)?.name}</b> (ETA {alt[0].etaMinutes} min) — review below.</span>}
      </div>
      {r.phoneCalls.length > 0 && <ul className="why">{r.phoneCalls.map((c, i) => <li key={i}>{fmtTime(c.at)} — called by {c.by}: {c.outcome.replace(/_/g, ' ').toLowerCase()} {c.note && `(${c.note})`}</li>)}</ul>}
      {callFor && <CallDialog req={callFor} hospital={h} onClose={() => setCallFor(null)} />}
      {confirmEsc && <ConfirmDialog title="Escalate incident?" confirmText="Escalate" danger onConfirm={async () => { await call((t) => backend.escalateIncident(t, incident.id, r.status === 'NO_RESPONSE' ? `No response from ${h?.name}` : ''), { ok: 'Incident escalated. Supervisors notified.' }); setConfirmEsc(false); }} onCancel={() => setConfirmEsc(false)}>
        <p>Escalation notifies dispatch supervisors and administrators. It does not dispatch or reserve anything automatically.</p></ConfirmDialog>}
    </div>
  );
}

function CallDialog({ req, hospital, onClose }: { req: HospitalRequest; hospital?: Hospital; onClose: () => void }) {
  const { call, backend } = useApp();
  const [outcome, setOutcome] = useState<(typeof CALL_OUTCOMES)[number]>('NO_ANSWER');
  const [note, setNote] = useState('');
  return (
    <Modal title={`Record call to ${hospital?.name ?? 'hospital'}`} small onClose={onClose}
      footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn onClick={async () => { const r = await call((t) => backend.recordPhoneCall(t, req.id, outcome, note), { ok: 'Call outcome recorded.' }); if (r.ok) onClose(); }}>Save outcome</Btn></>}>
      <p>Emergency contact: <b>{hospital?.emergencyContact}</b></p>
      <Field label="Call outcome"><select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>{CALL_OUTCOMES.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ').toLowerCase()}</option>)}</select></Field>
      <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></Field>
      {outcome === 'ACCEPTED' && <Banner kind="warn">Recording “accepted” confirms the destination based on a phone call. Make sure the hospital explicitly agreed to receive the patient.</Banner>}
    </Modal>
  );
}
