import { useState } from 'react';
import { DISCLAIMER } from '../lib/labels';
import type { Role } from '../lib/types';
import { DEMO_DOMAIN, DEMO_PASSWORD } from '../server/seed';
import { roleHome, useApp } from '../state/app';
import { Banner, Btn, Field, Icon, Modal } from '../components/ui';
import { Link, navigate } from '../state/router';

export function Logo({ size = 28 }: { size?: number }) {
  return <span className="logo" style={{ width: size, height: size }} aria-hidden="true"><svg width={size * 0.64} height={size * 0.64} viewBox="0 0 24 24" fill="currentColor"><path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" /></svg></span>;
}

export function LandingPage() {
  const { demoLogin } = useApp();
  return (
    <div>
      <div className="disclaimer" role="note">{DISCLAIMER}</div>
      <header className="hero">
        <div className="in">
          <div className="row"><Logo size={36} /><b style={{ fontSize: '1.3rem', letterSpacing: '.02em' }}>RapidCare</b></div>
          <h1>Real-time emergency resource allocation</h1>
          <p>RapidCare helps dispatchers route ambulances to the most suitable hospital using live capacity, ambulance location, patient needs and traffic-aware ETA — with every recommendation reviewable by a person.</p>
          <div className="row wrap">
            <a className="btn lg" style={{ width: 'auto', background: '#fff', color: 'var(--navy-800)', borderColor: '#fff' }} href="#/login">Sign In</a>
            <button className="btn lg" style={{ width: 'auto', background: 'transparent', borderColor: '#9fb7da' }} onClick={() => demoLogin('DISPATCHER')}><Icon name="play" size={18} />Open Demo</button>
          </div>
          <p className="small" style={{ color: '#b7c9e6' }}>“Open Demo” loads simulated data and signs you in as a demo dispatcher. No real patient data is used or stored.</p>
        </div>
      </header>
      <section className="feat" aria-label="What RapidCare does">
        {[
          ['hospital', 'Suitability first', 'Hospitals are filtered on required beds, specialty, acceptance status and data freshness — distance never overrides medical eligibility.'],
          ['signal', 'Live, honest data', 'Capacity and GPS carry LIVE / RECENT / STALE badges. Old data is never silently treated as current.'],
          ['shield', 'Role-based access', 'Dispatchers, hospital staff, ambulance crews and admins each see only what they need. Every key action is audited.'],
          ['bell', 'Closed-loop alerts', 'Hospitals accept, decline or ask questions. No response? Dispatch is alerted and can escalate or call.'],
        ].map(([i, t, d]) => <div key={t} className="card"><div className="row"><Icon name={i} size={20} /><h3>{t}</h3></div><p className="small muted mt8">{d}</p></div>)}
      </section>
      <section style={{ maxWidth: 1000, margin: '0 auto', padding: '0 20px 40px' }}>
        <Banner kind="info" icon="shield"><b>Privacy &amp; demo notice.</b> This is a demonstration decision-support platform, not a clinically validated or autonomous dispatch system. It collects minimal, anonymous incident data. Location is requested only after an explicit action by an authorised crew member and stops when duty or the incident ends.</Banner>
      </section>
    </div>
  );
}

export function LoginPage() {
  const { login, demoLogin, backend, user, toast } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(false);
  if (user) { navigate(roleHome(user.role)); }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(''); setErrors({});
    const r = await login(email, password);
    setBusy(false);
    if (r.ok && r.value) navigate(roleHome(r.value.role)); else { setError(r.error ?? 'Sign-in failed.'); setErrors(r.fields ?? {}); }
  };
  const roles: [Role, string][] = [['ADMIN', 'Login as Admin'], ['DISPATCHER', 'Login as Dispatcher'], ['HOSPITAL_STAFF', 'Login as Hospital Staff'], ['AMBULANCE_CREW', 'Login as Ambulance Crew']];
  return (
    <div>
      <div className="disclaimer" role="note">{DISCLAIMER}</div>
      <div className="loginbox col gap16">
        <div className="row"><Link to="/" className="row" style={{ textDecoration: 'none', color: 'var(--navy-800)' }}><Logo /><b style={{ fontSize: '1.3rem' }}>RapidCare</b></Link></div>
        <form className="card col gap12" onSubmit={submit} noValidate aria-label="Sign in">
          <h1>Sign in</h1>
          {error && <Banner kind="danger">{error}</Banner>}
          <Field label="Email" error={errors.email}><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
          <Field label="Password" error={errors.password}><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
          <Btn type="submit" disabled={busy} className="lg">{busy ? 'Signing in…' : 'Sign in'}</Btn>
          <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setReset(true)}>Forgot password?</button>
        </form>
        <div className="card col">
          <h2>Demo access</h2>
          <p className="small muted">One-click role access with simulated data. Demo accounts use the <span className="mono">@{DEMO_DOMAIN}</span> domain with a shared demo password shown in the README — no real credentials are used.</p>
          <div className="rolebtns">{roles.map(([r, l]) => <Btn key={r} kind="secondary" onClick={() => demoLogin(r)}>{l}</Btn>)}</div>
        </div>
        <p className="small muted">Sessions expire after {backend.ctx.db.config.sessionIdleMinutes} minutes of inactivity.</p>
      </div>
      {reset && <ResetDialog onClose={() => setReset(false)} onDone={(m) => { toast(m, 'info'); setReset(false); }} />}
    </div>
  );
}

function ResetDialog({ onClose, onDone }: { onClose: () => void; onDone: (m: string) => void }) {
  const { backend } = useApp();
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  return (
    <Modal title="Reset password (placeholder)" small onClose={onClose} footer={<><Btn kind="secondary" onClick={onClose}>Cancel</Btn><Btn onClick={() => { try { onDone(backend.requestPasswordReset(email).message); } catch (e) { setErr(e instanceof Error ? e.message : 'Error'); } }}>Request reset</Btn></>}>
      <Banner kind="info">Placeholder flow. In production this triggers your identity provider’s reset email (e.g. Supabase Auth). No email is sent in demo mode.</Banner>
      <Field label="Email" error={err}><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
    </Modal>
  );
}

export { DEMO_PASSWORD };
