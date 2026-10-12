import { useEffect } from 'react';
import { DISCLAIMER } from './lib/labels';
import type { Role } from './lib/types';
import { DEMO_DOMAIN } from './server/seed';
import { roleHome, useApp } from './state/app';
import { Link, matchRoute, navigate, usePath } from './state/router';
import { AdminPage } from './pages/Admin';
import { AmbulancePage } from './pages/Ambulance';
import { DispatcherPage } from './pages/Dispatcher';
import { HospitalPage } from './pages/Hospital';
import { IncidentPage } from './pages/Incident';
import { LandingPage, LoginPage, Logo } from './pages/Public';
import { NotificationBell } from './components/Panels';
import { Banner, ErrorBoundary, Icon, Spinner } from './components/ui';

const ROLE_LABEL: Record<Role, string> = { ADMIN: 'Admin', DISPATCHER: 'Dispatcher', HOSPITAL_STAFF: 'Hospital staff', AMBULANCE_CREW: 'Ambulance crew' };

/** Which role may open which route. The backend independently enforces the same rules on every call. */
const ALLOWED: Record<string, Role[]> = {
  '/app/dispatch': ['DISPATCHER', 'ADMIN'],
  '/app/hospital': ['HOSPITAL_STAFF'],
  '/app/ambulance': ['AMBULANCE_CREW'],
  '/app/admin': ['ADMIN'],
  '/app/incident': ['DISPATCHER', 'ADMIN', 'HOSPITAL_STAFF', 'AMBULANCE_CREW'],
};

export default function App() {
  const path = usePath();
  const { user, token } = useApp();

  // protected routes
  useEffect(() => {
    if (path.startsWith('/app') && !token) navigate('/login');
  }, [path, token]);

  if (path === '/' || path === '') return <LandingPage />;
  if (path === '/login') return <LoginPage />;
  if (path.startsWith('/app')) {
    if (!token) return <Spinner label="Redirecting to sign in…" />;
    if (!user) return <Spinner label="Loading…" />;
    const key = Object.keys(ALLOWED).find((k) => path === k || path.startsWith(`${k}/`));
    if (path === '/app' || !key) { navigate(roleHome(user.role)); return null; }
    if (!ALLOWED[key].includes(user.role)) {
      return <Shell><div className="page"><Banner kind="danger"><b>Access denied.</b> Your role ({ROLE_LABEL[user.role]}) cannot open this page. <a href={`#${roleHome(user.role)}`}>Go to your dashboard</a>.</Banner></div></Shell>;
    }
    const inc = matchRoute(path, '/app/incident/:id');
    return (
      <Shell>
        <ErrorBoundary key={user.id}>
          {key === '/app/dispatch' && <DispatcherPage />}
          {key === '/app/hospital' && <HospitalPage />}
          {key === '/app/ambulance' && <AmbulancePage />}
          {key === '/app/admin' && <AdminPage />}
          {key === '/app/incident' && inc && <IncidentPage id={inc.id} />}
        </ErrorBoundary>
      </Shell>
    );
  }
  return <div className="page"><Banner kind="warn">Page not found. <a href="#/">Go home</a></Banner></div>;
}

function Shell({ children }: { children: React.ReactNode }) {
  const { user, logout, online, backend, switchAccount, snap } = useApp();
  if (!user) return null;
  const demo = backend.demoAccounts();
  const nav: [string, string, Role[]][] = [['/app/dispatch', 'Operations', ['DISPATCHER', 'ADMIN']], ['/app/admin', 'Admin', ['ADMIN']], ['/app/hospital', 'Hospital', ['HOSPITAL_STAFF']], ['/app/ambulance', 'My ambulance', ['AMBULANCE_CREW']]];
  const exp = snap?.sessionExpiresAt;
  return (
    <div className="shell">
      <div className="disclaimer noprint" role="note">{DISCLAIMER}</div>
      <header className="topbar noprint">
        <Link to="/" className="brand"><Logo />RapidCare</Link>
        <nav aria-label="Primary">{nav.filter(([, , r]) => r.includes(user.role)).map(([to, l]) => <Link key={to} to={to}>{l}</Link>)}</nav>
        <div className="right row wrap">
          <span className={`pill ${online ? 'live' : 'down'}`} title={online ? 'Realtime channels connected' : 'Offline — showing last known data'}>{online ? 'Realtime' : 'Offline'}</span>
          <NotificationBell />
          {demo.length > 0 && (
            <select aria-label="Switch demo account" value={user.id} onChange={(e) => switchAccount(e.target.value)} title="Demo only: switch between seeded role accounts">
              {(['ADMIN', 'DISPATCHER', 'HOSPITAL_STAFF', 'AMBULANCE_CREW'] as Role[]).map((r) => <optgroup key={r} label={ROLE_LABEL[r]}>{demo.filter((d) => d.role === r).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</optgroup>)}
            </select>)}
          <span className="pill" title={`Signed in as ${user.email}`}><Icon name="user" size={13} />{ROLE_LABEL[user.role]}</span>
          <button className="pill" onClick={logout} aria-label="Sign out"><Icon name="logout" size={13} />Logout</button>
        </div>
      </header>
      {!online && <div className="banner warn noprint" role="alert" style={{ borderRadius: 0 }}><Icon name="signal" />You are offline. Data shown may be out of date; actions will fail until the connection returns.</div>}
      {exp && exp - backend.ctx.now() < 120_000 && <div className="banner warn noprint" role="alert" style={{ borderRadius: 0 }}><Icon name="clock" />Your session expires soon due to inactivity. Interact with the page to stay signed in.</div>}
      <main id="main" style={{ flex: 1 }}>{children}</main>
      <footer className="small muted noprint" style={{ padding: '8px 14px', textAlign: 'center' }}>RapidCare demo · {DEMO_DOMAIN} accounts · Decision support only · Verify stale capacity by phone</footer>
      <Toasts />
    </div>
  );
}

function Toasts() {
  const { toasts, dismiss } = useApp();
  return (
    <div className="toasts noprint" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role={t.kind === 'err' ? 'alert' : 'status'}>
          <div className="grow small">{t.text}</div><button className="iconbtn" style={{ background: 'transparent', color: '#fff', borderColor: '#ffffff55', width: 26, height: 26 }} aria-label="Dismiss" onClick={() => dismiss(t.id)}><Icon name="x" size={12} /></button>
        </div>))}
    </div>
  );
}
