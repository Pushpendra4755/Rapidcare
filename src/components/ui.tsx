import { Component, useEffect, useRef, type ReactNode } from 'react';
import { ACCEPTANCE_LABEL, AMBULANCE_STATUS_LABEL, SEVERITY_ICON, SEVERITY_LABEL } from '../lib/labels';
import type { AcceptanceStatus, AmbulanceStatus, GpsFreshness, HospitalFreshness, RecommendationLabel, Severity } from '../lib/types';
import { LABEL_TEXT } from '../lib/engine';

// ------------------------------------------------------------------ icons (consistent set)
const P: Record<string, string> = {
  ambulance: 'M3 7h11v8H3zM14 10h4l3 3v2h-7zM7 9v4M5 11h4M7 18a1.7 1.7 0 100 .01M17 18a1.7 1.7 0 100 .01',
  hospital: 'M4 21V6l8-3 8 3v15zM12 8v6M9 11h6M10 21v-4h4v4',
  icu: 'M3 18v-7h18v7M3 14h18M6 11V8h5v3M14 8h5',
  bed: 'M3 18V8M3 14h18v4M21 14v-2a3 3 0 00-3-3h-7v5M7 12a1.5 1.5 0 100 .01',
  route: 'M6 19a2 2 0 100-.01M18 5a2 2 0 100-.01M8 19h6a3 3 0 000-6h-4a3 3 0 010-6h6',
  alert: 'M12 3l10 18H2zM12 10v5M12 18v.5',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A15 15 0 013 6a2 2 0 012-2z',
  location: 'M12 21s7-6.2 7-11a7 7 0 10-14 0c0 4.8 7 11 7 11zM12 12a2.5 2.5 0 100-.01',
  check: 'M4 12l5 5L20 6',
  x: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 7v5l3 2',
  signal: 'M4 18v-3M9 18v-6M14 18V9M19 18V5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  plus: 'M12 5v14M5 12h14',
  bell: 'M6 16V11a6 6 0 1112 0v5l2 2H4zM10 20h4',
  user: 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0',
  gear: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19 12l2-1-2-4-2 1-2-1V5h-4v2l-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1v2h4v-2l2-1 2 1 2-4-2-1z',
  print: 'M7 9V4h10v5M7 17H5v-6h14v6h-2M7 14h10v6H7z',
  play: 'M7 4l13 8-13 8z',
  heat: 'M12 3c3 4 6 6 6 10a6 6 0 01-12 0c0-2 1-3 2-4 0 2 1 3 2 3 0-3 0-6 2-9z',
  refresh: 'M20 11a8 8 0 10-2 6M20 4v7h-7',
  logout: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  info: 'M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5v.5',
};

export function Icon({ name, size = 16, label }: { name: keyof typeof P | string; size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} style={{ flex: 'none' }}>
      <path d={P[name] ?? P.info} />
    </svg>
  );
}

// ------------------------------------------------------------------ badges
export function Badge({ tone = 'gray', icon, children, title }: { tone?: 'green' | 'amber' | 'red' | 'blue' | 'purple' | 'orange' | 'gray' | 'navy'; icon?: string; children: ReactNode; title?: string }) {
  return <span className={`badge b-${tone}`} title={title}>{icon && <Icon name={icon} size={12} />}{children}</span>;
}

export function FreshnessBadge({ f, age }: { f: HospitalFreshness; age?: number | null }) {
  const m = { LIVE: ['green', 'signal'], RECENT: ['blue', 'clock'], STALE: ['amber', 'alert'], UNAVAILABLE: ['red', 'x'] } as const;
  const [tone, icon] = m[f];
  return <Badge tone={tone} icon={icon} title={age != null ? `Verified ${Math.round(age)} min ago` : 'Never verified'}>{f}</Badge>;
}

export function GpsBadge({ f, age }: { f: GpsFreshness; age?: number | null }) {
  const m = { LIVE: ['green', 'signal', 'GPS LIVE'], STALE: ['amber', 'alert', 'GPS STALE'], LOST: ['red', 'x', 'GPS LOST'], NONE: ['gray', 'location', 'NOT SHARING'] } as const;
  const [tone, icon, text] = m[f];
  return <Badge tone={tone} icon={icon} title={age != null ? `Last update ${age}s ago` : undefined}>{text}{age != null && f !== 'NONE' ? ` · ${age}s` : ''}</Badge>;
}

export function SeverityBadge({ s }: { s: Severity }) {
  const tone = { CRITICAL: 'red', HIGH: 'orange', MODERATE: 'amber', LOW: 'green' } as const;
  return <span className={`badge b-${tone[s]} ${s === 'CRITICAL' ? 'b-solid-red' : ''}`}><span aria-hidden="true">{SEVERITY_ICON[s]}</span>{SEVERITY_LABEL[s].toUpperCase()}</span>;
}

export function AcceptanceBadge({ s }: { s: AcceptanceStatus }) {
  const m = { ACCEPTING: ['green', 'check'], LIMITED_CAPACITY: ['amber', 'alert'], DIVERTING: ['red', 'x'], UNAVAILABLE: ['red', 'x'] } as const;
  return <Badge tone={m[s][0]} icon={m[s][1]}>{ACCEPTANCE_LABEL[s].toUpperCase()}</Badge>;
}

export function AmbulanceBadge({ s }: { s: AmbulanceStatus }) {
  const tone = s === 'OFFLINE' ? 'gray' : s === 'AVAILABLE' ? 'blue' : ['ASSIGNED', 'EN_ROUTE_PICKUP', 'AT_PICKUP'].includes(s) ? 'orange' : 'purple';
  return <Badge tone={tone} icon="ambulance">{AMBULANCE_STATUS_LABEL[s]}</Badge>;
}

export function RecLabelBadge({ l }: { l: RecommendationLabel }) {
  const m = { BEST_MATCH: ['green', 'check'], ELIGIBLE_ALTERNATIVE: ['blue', 'hospital'], LIMITED_CAPACITY: ['amber', 'alert'], NOT_ELIGIBLE: ['red', 'x'], STALE_VERIFY: ['amber', 'phone'] } as const;
  return <Badge tone={m[l][0]} icon={m[l][1]}>{LABEL_TEXT[l]}</Badge>;
}

export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
export const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtDur = (sec: number | null | undefined) => (sec == null ? '—' : sec < 90 ? `${Math.round(sec)} s` : `${Math.floor(sec / 60)} min ${Math.round(sec % 60)} s`);
export const mmss = (sec: number) => { const s = Math.max(0, Math.round(sec)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

// ------------------------------------------------------------------ layout helpers
export function Banner({ kind = 'info', children, icon }: { kind?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode; icon?: string }) {
  return <div className={`banner ${kind}`} role={kind === 'danger' || kind === 'warn' ? 'alert' : 'status'}><Icon name={icon ?? (kind === 'ok' ? 'check' : kind === 'info' ? 'info' : 'alert')} size={18} /><div className="grow">{children}</div></div>;
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <div className="row" role="status" style={{ justifyContent: 'center', padding: 24 }}><span className="spinner" aria-hidden="true" /><span className="muted">{label}</span></div>;
}

export function Empty({ children }: { children: ReactNode }) { return <div className="empty">{children}</div>; }

export function Btn({ children, kind = '', size = '', icon, ...rest }: { children?: ReactNode; kind?: '' | 'secondary' | 'danger' | 'good' | 'warn' | 'ghost'; size?: '' | 'sm' | 'lg'; icon?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" {...rest} className={`btn ${kind} ${size} ${rest.className ?? ''}`}>{icon && <Icon name={icon} size={size === 'lg' ? 20 : 15} />}{children}</button>;
}

export function Field({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: ReactNode }) {
  return <label className={`field ${error ? 'invalid' : ''}`}><span>{label}</span>{children}{hint && !error && <span className="hint">{hint}</span>}{error && <span className="err" role="alert">{error}</span>}</label>;
}

// ------------------------------------------------------------------ modal (focus trap, Esc to close)
export function Modal({ title, onClose, children, footer, small }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; small?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusable = () => Array.from(el?.querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])') ?? []).filter((x) => !x.hasAttribute('disabled'));
    (focusable()[1] ?? focusable()[0])?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
      if (e.key === 'Tab') {
        const f = focusable(); if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); prev?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${small ? 'sm' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <header><h2>{title}</h2><button className="iconbtn" aria-label="Close dialog" onClick={onClose}><Icon name="x" /></button></header>
        <div className="body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, children, confirmText = 'Confirm', danger, busy, disabled, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmText?: string; danger?: boolean; busy?: boolean; disabled?: boolean; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Modal title={title} small onClose={onCancel} footer={<><Btn kind="secondary" onClick={onCancel}>Cancel</Btn><Btn kind={danger ? 'danger' : ''} onClick={onConfirm} disabled={busy || disabled}>{busy ? 'Working…' : confirmText}</Btn></>}>
      {children}
    </Modal>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) {
      return (
        <div className="page"><Banner kind="danger">Something went wrong displaying this page: {this.state.err.message}</Banner>
          <div><Btn onClick={() => { this.setState({ err: null }); location.hash = '#/'; }}>Back to start</Btn></div></div>
      );
    }
    return this.props.children;
  }
}
