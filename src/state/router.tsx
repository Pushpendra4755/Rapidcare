import { useEffect, useState, type ReactNode } from 'react';

/** Minimal hash router (no dependency). Routes look like "#/app/incident/inc_1001". */
export function currentPath(): string {
  const h = typeof location === 'undefined' ? '' : location.hash.replace(/^#/, '');
  return (h.split('?')[0] || '/').replace(/\/+$/, '') || '/';
}

export function usePath(): string {
  const [p, setP] = useState(currentPath());
  useEffect(() => {
    const on = () => setP(currentPath());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return p;
}

export function navigate(path: string) { location.hash = `#${path}`; }

export function Link({ to, children, className, ...rest }: { to: string; children: ReactNode; className?: string } & React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const path = usePath();
  const active = path === to || (to !== '/' && path.startsWith(`${to}/`));
  return <a href={`#${to}`} className={className} aria-current={active ? 'page' : undefined} {...rest}>{children}</a>;
}

export function matchRoute(path: string, pattern: string): Record<string, string> | null {
  const a = path.split('/').filter(Boolean);
  const b = pattern.split('/').filter(Boolean);
  if (a.length !== b.length && !pattern.endsWith('/*')) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < b.length; i++) {
    if (b[i] === '*') return params;
    if (b[i].startsWith(':')) params[b[i].slice(1)] = decodeURIComponent(a[i] ?? '');
    else if (a[i] !== b[i]) return null;
  }
  return params;
}
