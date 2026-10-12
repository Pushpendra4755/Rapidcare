import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import type { RapidCareBackend } from './server/backend';
import { AppProvider, createBackend } from './state/app';
import { Spinner } from './components/ui';
import './styles.css';

function Boot() {
  const [backend, setBackend] = useState<RapidCareBackend | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { createBackend().then(setBackend).catch((e) => setErr(e instanceof Error ? e.message : String(e))); }, []);
  if (err) return <div className="page"><div className="banner danger" role="alert">RapidCare could not start: {err}. <button className="btn sm" onClick={() => location.reload()}>Retry</button></div></div>;
  if (!backend) return <Spinner label="Starting RapidCare…" />;
  return <AppProvider backend={backend}><App /></AppProvider>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Boot /></StrictMode>);
