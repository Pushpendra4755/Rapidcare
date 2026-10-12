// Shared server-side primitives: errors, clock, realtime bus, rate limiter, hashing, validation.
// These modules have no DOM/React dependency, so the same backend runs in the browser demo and under Node tests.

export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 429,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface Clock { now(): number; advance(ms: number): void }

export function createClock(): Clock {
  let offset = 0;
  return { now: () => Date.now() + offset, advance: (ms) => { offset += ms; } };
}

export const iso = (ms: number) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------------------------
// Realtime bus. Events carry NO payload data — only "something changed on this channel".
// Clients then re-fetch their own role-scoped snapshot, so a subscriber can never receive data
// its role is not authorised to read, even if a channel were mis-subscribed.
// ---------------------------------------------------------------------------------------------
export interface BusEvent { channel: string; kind: string; entityId: string | null; at: number }
type Handler = (e: BusEvent) => void;

export class Bus {
  private subs = new Map<string, Set<Handler>>();
  subscribe(channel: string, h: Handler): () => void {
    let set = this.subs.get(channel);
    if (!set) this.subs.set(channel, (set = new Set()));
    set.add(h);
    return () => { set!.delete(h); };
  }
  publish(channel: string, kind: string, entityId: string | null, at: number) {
    const set = this.subs.get(channel);
    if (!set) return;
    for (const h of [...set]) {
      try { h({ channel, kind, entityId, at }); } catch { /* a bad subscriber must not break the bus */ }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Sliding-window rate limiter
// ---------------------------------------------------------------------------------------------
export class RateLimiter {
  private hits = new Map<string, number[]>();
  constructor(private clock: Clock) {}
  check(key: string, limit: number, windowMs: number): void {
    const now = this.clock.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (arr.length >= limit) {
      this.hits.set(key, arr);
      throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Please slow down and retry shortly.');
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 5000) this.hits.clear();
  }
  reset() { this.hits.clear(); }
}

// ---------------------------------------------------------------------------------------------
// Pure-JS SHA-256 (demo credential hashing; production uses Supabase Auth / bcrypt-class hashing).
// ---------------------------------------------------------------------------------------------
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256Hex(input: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let c = input.charCodeAt(i);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < input.length) {
      const c2 = input.charCodeAt(++i);
      c = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
      bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map((x) => x.toString(16).padStart(8, '0')).join('');
}

export function randomToken(): string {
  const arr = new Uint8Array(24);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(arr);
  else for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------------
// Input validation helpers (throw 422 with per-field messages)
// ---------------------------------------------------------------------------------------------
export class Check {
  fields: Record<string, string> = {};
  fail(field: string, msg: string) { if (!this.fields[field]) this.fields[field] = msg; }
  done() {
    if (Object.keys(this.fields).length) throw new ApiError(422, 'VALIDATION', 'Please correct the highlighted fields.', this.fields);
  }
  str(v: unknown, field: string, o: { min?: number; max?: number; optional?: boolean; label?: string } = {}): string {
    const label = o.label ?? field;
    if (v == null || v === '') {
      if (!o.optional) this.fail(field, `${label} is required.`);
      return '';
    }
    if (typeof v !== 'string') { this.fail(field, `${label} must be text.`); return ''; }
    const s = v.trim();
    if (o.min != null && s.length < o.min) this.fail(field, `${label} must be at least ${o.min} characters.`);
    if (o.max != null && s.length > o.max) this.fail(field, `${label} must be at most ${o.max} characters.`);
    // strip control characters
    // eslint-disable-next-line no-control-regex
    return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  }
  oneOf<T extends string>(v: unknown, allowed: readonly T[], field: string, label = field): T {
    if (typeof v === 'string' && (allowed as readonly string[]).includes(v)) return v as T;
    this.fail(field, `${label} must be one of: ${allowed.join(', ')}.`);
    return allowed[0];
  }
  int(v: unknown, field: string, o: { min?: number; max?: number; label?: string } = {}): number {
    const label = o.label ?? field;
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) { this.fail(field, `${label} must be a whole number.`); return 0; }
    if (o.min != null && n < o.min) this.fail(field, `${label} cannot be less than ${o.min}.`);
    if (o.max != null && n > o.max) this.fail(field, `${label} cannot exceed ${o.max}.`);
    return n;
  }
  num(v: unknown, field: string, o: { min?: number; max?: number; label?: string } = {}): number {
    const label = o.label ?? field;
    if (typeof v !== 'number' || !Number.isFinite(v)) { this.fail(field, `${label} must be a number.`); return 0; }
    if (o.min != null && v < o.min) this.fail(field, `${label} must be at least ${o.min}.`);
    if (o.max != null && v > o.max) this.fail(field, `${label} must be at most ${o.max}.`);
    return v;
  }
  email(v: unknown, field = 'email'): string {
    const s = this.str(v, field, { max: 120, label: 'Email' }).toLowerCase();
    if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) this.fail(field, 'Enter a valid email address.');
    return s;
  }
}
