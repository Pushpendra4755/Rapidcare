import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createRoutingProvider } from '../lib/routing';
import type { Role, User } from '../lib/types';
import { RapidCareBackend } from '../server/backend';
import { ApiError } from '../server/core';
import type { IncidentDetail, Snapshot } from '../server/views';
import { navigate } from './router';

export interface Toast { id: number; kind: 'ok' | 'err' | 'warn' | 'info'; text: string }
export interface CallResult<T> { ok: boolean; value?: T; error?: string; fields?: Record<string, string>; code?: string }

export interface AppApi {
  backend: RapidCareBackend;
  token: string | null;
  user: User | null;
  snap: Snapshot | null;
  online: boolean;
  toasts: Toast[];
  login(email: string, password: string): Promise<CallResult<User>>;
  demoLogin(role: Role): Promise<void>;
  switchAccount(userId: string): Promise<void>;
  logout(): void;
  call<T>(fn: (token: string) => T | Promise<T>, o?: { ok?: string; quiet?: boolean }): Promise<CallResult<T>>;
  toast(text: string, kind?: Toast['kind']): void;
  dismiss(id: number): void;
  refresh(): void;
  now(): number;
}

const Ctx = createContext<AppApi | null>(null);
export const useApp = () => { const c = useContext(Ctx); if (!c) throw new Error('AppProvider missing'); return c; };

/** Re-renders every `ms` and returns the backend clock (ms). Used for countdowns and freshness ages. */
export function useNow(ms = 1000): number {
  const { backend } = useApp();
  const [n, setN] = useState(backend.ctx.now());
  useEffect(() => { const t = setInterval(() => setN(backend.ctx.now()), ms); return () => clearInterval(t); }, [backend, ms]);
  return n;
}

export function roleHome(role: Role): string {
  return { ADMIN: '/app/admin', DISPATCHER: '/app/dispatch', HOSPITAL_STAFF: '/app/hospital', AMBULANCE_CREW: '/app/ambulance' }[role];
}

const TOKEN_KEY = 'rapidcare.session';

export function AppProvider({ backend, children }: { backend: RapidCareBackend; children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } });
  const [user, setUser] = useState<User | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const seen = useRef<Set<string> | null>(null);
  const tid = useRef(1);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = tid.current++;
    setToasts((t) => [...t.slice(-2), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 8000 : kind === 'warn' ? 6000 : 3500);
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const saveToken = (t: string | null) => { setToken(t); try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } };

  const endSession = useCallback((msg?: string) => {
    saveToken(null); setUser(null); setSnap(null); seen.current = null; setToasts([]);
    if (msg) toast(msg, 'warn');
    navigate('/login');
  }, [toast]);

  const refresh = useCallback(() => {
    if (!token) return;
    try {
      const s = backend.getSnapshot(token);
      setSnap(s); setUser(s.me);
      // surface newly arrived alerts as toasts (not on first load)
      const ids = new Set(s.notifications.map((n) => n.id));
      if (seen.current) for (const n of s.notifications) if (!seen.current.has(n.id) && n.severity !== 'INFO' && n.status === 'SENT') toast(`${n.title}: ${n.message}`, n.severity === 'CRITICAL' ? 'err' : 'warn');
      seen.current = ids;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401)) endSession(e.code === 'SESSION_EXPIRED' ? 'Your session expired. Please sign in again.' : undefined);
      else if (e instanceof ApiError && e.status === 429) { /* back off silently */ }
    }
  }, [backend, token, toast, endSession]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  // initial load + realtime subscriptions (authorised per role by the backend)
  useEffect(() => {
    if (!token) return;
    refresh();
    let pending: ReturnType<typeof setTimeout> | null = null;
    const bump = () => { if (!pending) pending = setTimeout(() => { pending = null; refreshRef.current(); }, 60); };
    const unsubs: (() => void)[] = [];
    try {
      const me = backend.me(token).user;
      const channels = me.role === 'HOSPITAL_STAFF' ? [`hospital:${me.hospitalId}`] : me.role === 'AMBULANCE_CREW' ? [`ambulance:${me.ambulanceId}`] : ['dispatcher:operations'];
      for (const c of channels) unsubs.push(backend.subscribe(token, c, bump));
    } catch (e) { if (e instanceof ApiError && e.status === 401) endSession(); }
    const poll = setInterval(() => refreshRef.current(), 3000); // keeps derived ages (freshness) current
    return () => { unsubs.forEach((u) => u()); clearInterval(poll); if (pending) clearTimeout(pending); };
  }, [backend, token, refresh, endSession]);

  // simulation + housekeeping (a worker/cron in production; timers in the browser demo)
  useEffect(() => {
    const sim = setInterval(() => { void backend.system.tick(); }, 10_000);
    const hk = setInterval(() => { void backend.system.housekeeping(); }, 2000);
    return () => { clearInterval(sim); clearInterval(hk); };
  }, [backend]);

  useEffect(() => {
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const call = useCallback(async function <T>(fn: (t: string) => T | Promise<T>, o: { ok?: string; quiet?: boolean } = {}): Promise<CallResult<T>> {
    if (!token) return { ok: false, error: 'Not signed in.' };
    try {
      const value = await fn(token);
      if (o.ok) toast(o.ok, 'ok');
      refreshRef.current();
      return { ok: true, value };
    } catch (e) {
      if (e instanceof ApiError) {
        if (e.status === 401) { endSession(e.code === 'SESSION_EXPIRED' ? 'Your session expired. Please sign in again.' : undefined); return { ok: false, error: e.message, code: e.code }; }
        if (!o.quiet && e.code !== 'VALIDATION') toast(e.message, 'err');
        return { ok: false, error: e.message, fields: e.fields, code: e.code };
      }
      const msg = e instanceof Error ? e.message : 'Unexpected error';
      if (!o.quiet) toast(msg, 'err');
      return { ok: false, error: msg };
    }
  }, [token, toast, endSession]);

  const api = useMemo<AppApi>(() => ({
    backend, token, user, snap, online, toasts,
    async login(email, password) {
      try {
        const r = backend.login(email, password);
        saveToken(r.session.token); setUser(r.user); seen.current = null;
        return { ok: true, value: r.user };
      } catch (e) {
        const err = e as ApiError;
        return { ok: false, error: err.message, fields: err.fields, code: err.code };
      }
    },
    async demoLogin(role) {
      const r = backend.demoLogin(role);
      saveToken(r.session.token); setUser(r.user); seen.current = null;
      navigate(roleHome(role));
    },
    async switchAccount(userId) {
      if (token) backend.logout(token);
      const r = backend.demoLoginAs(userId);
      saveToken(r.session.token); setUser(r.user); setSnap(null); seen.current = null; setToasts([]);
      navigate(roleHome(r.user.role));
    },
    logout() { if (token) backend.logout(token); endSession(); },
    call, toast, dismiss, refresh, now: () => backend.ctx.now(),
  }), [backend, token, user, snap, online, toasts, call, toast, dismiss, refresh, endSession]);

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

/** Fetch an incident detail and keep it fresh as the snapshot/incident channel changes. */
export function useIncidentDetail(id: string | null): { detail: IncidentDetail | null; error: string | null; reload: () => void } {
  const { backend, token, snap } = useApp();
  const [detail, setDetail] = useState<IncidentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!token || !id) return;
    try { setDetail(backend.getIncidentDetail(token, id)); setError(null); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to load incident'); }
  }, [backend, token, id]);
  useEffect(() => { load(); }, [load, snap?.serverTime]);
  return { detail, error, reload: load };
}

export async function createBackend(): Promise<RapidCareBackend> {
  const kind = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_ROUTING_PROVIDER;
  return RapidCareBackend.create({ routing: createRoutingProvider(kind), demoMode: true });
}
