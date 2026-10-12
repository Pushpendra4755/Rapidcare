# RapidCare — Real-Time Emergency Resource Allocator

> **Demo decision-support platform. Recommendations must be reviewed by authorized emergency and clinical personnel.**
> Not clinically validated. Not an autonomous dispatch system. The engine produces a **recommended destination**; a human dispatcher decides, and a hospital bed is only shown as reserved after that hospital **explicitly accepts**.

## 1. Overview

RapidCare helps dispatchers choose the most suitable hospital for an incoming emergency by combining live hospital capacity and capability, ambulance GPS, patient requirements, traffic-aware ETA and hospital acceptance.

Roles (enforced by the backend, not just the UI):

| Role | Can do |
|---|---|
| `ADMIN` | Everything: hospitals, ambulances, users, categories, service areas, scoring weights, escalation timeouts, analytics, audit log, playback |
| `DISPATCHER` | Create incidents, assign ambulances, view recommendations, send/cancel hospital requests, override (with reason), escalate, close |
| `HOSPITAL_STAFF` | See **only** incidents sent to **their** hospital (pickup location redacted); update **only** their capacity; accept / decline / ask for info; prep checklist |
| `AMBULANCE_CREW` | See **only** their ambulance and assigned incident; share GPS (or manual fallback); advance trip status |

## 2. Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

No API keys or database are needed. Open the app, click **Open Demo**, then pick a role. Production build: `npm run build` (type-checks, then Vite build) and `npm run preview`.

Other scripts: `npm run typecheck`, `npm test` (84-check end-to-end backend smoke test, runs with `tsx`), `npm run build:esbuild` (dependency-light alternative bundler, output in `dist/`).

### Demo access

All demo accounts use the fictional domain `@demo.rapidcare.test` and the shared password `rapidcare-demo` (demo only — never reuse).

| Role | Email |
|---|---|
| Admin | `admin@demo.rapidcare.test` |
| Dispatcher | `dispatcher@demo.rapidcare.test` (also `dispatcher2@…`) |
| Hospital staff | `hospital@demo.rapidcare.test` (Central), `hospital.north@…`, `.east@…`, `.west@…`, `.south@…` |
| Ambulance crew | `crew@demo.rapidcare.test` (AMB-001), `crew.amb-002@…` … |

The Login page also has one-click buttons for each role, and a header drop-down switches accounts.

## 3. Walkthrough (acceptance flow)

1. Sign in as **Dispatcher** → dashboard shows incidents, map, summary cards.
2. **New emergency** → type *Trauma*, severity *Critical*, required resources (trauma bay, ICU), pickup address or map pin, caller-consent checkbox.
3. Assign an ambulance (nearest available is suggested).
4. Open the **Recommendation panel**: ranked hospitals with score breakdown, ETA, capacity, freshness, labels and reasons. The nearest hospital may be *NOT ELIGIBLE* (e.g. no trauma bay) so a farther eligible one ranks first.
5. **Send alert** → a request goes to the hospital (status *Pending*, 60 s response timer). The UI says "alert sent", never "bed reserved".
6. Switch to **Hospital staff** for that hospital → see the incident (no pickup location) → **Accept** (or decline with a reason / request more info).
7. Only now do the dashboards show **Accepted — resources reserved**.
8. Switch to **Ambulance crew** → *Start trip → Arrived at pickup → Patient on board → En route to hospital*; GPS pings every 10 s (simulated), ETA updates live.
9. Capacity changes, declines (automatic re-rank), no-response timeout (phone fallback, escalation), GPS loss and stale hospital data are all demonstrable from **Demo controls**.
10. Close the incident, open **Incident detail** → timeline, ETA chart, **Print report**.

Seeded scenarios: trauma needing a farther eligible hospital, stroke, pediatric respiratory, decline → re-rank, stale-data hospital.

## 4. Architecture

```
src/
  lib/        pure domain logic (no I/O): types, geo, freshness, labels, routing abstraction, ranking engine
  server/     the backend: db interface, seed, auth/session, RBAC, validation, workflows, simulation, views
  state/      React providers (session, snapshots, realtime subscriptions), hash router
  components/ UI kit, map (Leaflet via CDN + offline SVG fallback), recommendation panel, timeline, create-emergency
  pages/      Landing, Login, Dispatcher, Hospital, Ambulance, Incident, Admin
supabase/schema.sql   production PostgreSQL schema + Row Level Security + realtime
scripts/              esbuild bundler, backend smoke test
```

**Important honesty note.** To run with zero infrastructure, the demo's "backend" (`RapidCareBackend`) runs **in the browser process**. It is written as a real service boundary: every call needs a session token, is rate-limited, authorised by role and tenant (hospital/ambulance), validated, and audited; clients only receive role-scoped snapshots. But browser code is not a security boundary — **in production the `src/server` logic must run on a server** (Supabase Edge Functions / a Node service) with `supabase/schema.sql` RLS as the second line of defence. Nothing sensitive should be trusted to the client.

### Ranking engine (`src/lib/engine.ts`)

1. **Eligibility filter first** — hospital must be online, accepting, not stale beyond the cutoff, have the required capabilities, and have ≥1 available of each required resource. Ineligible hospitals are shown with plain-language reasons and always rank below eligible ones.
2. **Weighted score** (defaults, admin-editable): `final = 40% resource + 25% specialty + 20% ETA + 10% freshness + 5% workload`. STALE data ×0.85, LIMITED capacity ×0.9.
3. **Labels** (never colour-only): BEST MATCH · ELIGIBLE ALTERNATIVE · LIMITED CAPACITY · NOT ELIGIBLE · STALE DATA — VERIFY BY PHONE.
4. Choosing a non-top hospital is a **manual override** and requires a reason; stale or previously-declined targets need an explicit confirmation.

### Freshness

Hospital data: **LIVE** ≤ 5 min · **RECENT** ≤ 15 min · **STALE** > 15 min · **UNAVAILABLE** never verified. Ambulance GPS: **LIVE** ≤ 30 s · **STALE** > 30 s · **LOST** > 2 min. Freshness is derived at read time, never stored as truth.

### Realtime architecture

Channels: `dispatcher:operations`, `hospital:{id}`, `ambulance:{id}`, `incident:{id}`. In the demo an in-process bus publishes **content-free** events and clients re-fetch their own scoped snapshot (so a subscription can never leak data); subscribing to a channel is itself authorised (a hospital user cannot subscribe to another hospital's channel). In production use Supabase Realtime `postgres_changes`; RLS filters rows per user. The schema adds the relevant tables to the `supabase_realtime` publication.

Timers: `simTick` (ambulance movement; 10 s ping, `simCompression` speeds up demo travel) and `housekeeping` (request timeouts, GPS loss, stale-capacity alerts, escalation, session expiry) run on browser timers in demo mode and should run as a worker / `pg_cron` in production.

## 5. Data model

`users` (`app_users`), `hospitals`, `hospital_capabilities`, `hospital_resource_status`, `ambulances`, `incidents`, `hospital_recommendations`, `hospital_requests`, `ambulance_location_history`, `notifications`, `audit_logs` — plus `incident_timeline`, `service_areas`, `emergency_categories`, `system_config`. See `supabase/schema.sql` for columns, constraints and RLS.

Privacy by design: incidents hold **no** patient name, DOB, ID number or phone number — only age group, emergency type, severity, required resources and a short pre-arrival note. Audit logs and timeline events are append-only (trigger-enforced in SQL, frozen objects in the demo).

## 6. Environment variables

See `.env.example`. Everything is optional in demo mode.

| Variable | Where | Purpose |
|---|---|---|
| `VITE_ROUTING_PROVIDER` | browser | `mock` (default) \| `ors` \| `mapbox` \| `google` |
| `VITE_MAP_TILE_URL` | browser | Tile URL (default OpenStreetMap — mind its usage policy) |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | browser | Production path; anon key is safe **only** with RLS enabled |
| `ROUTING_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Never prefix with `VITE_`, never ship to the browser |

No secret is read by frontend code.

## 7. Switching routing providers

Routing sits behind the `RoutingProvider` interface (`src/lib/routing.ts`). `MockRoutingProvider` (default) generates deterministic geometry plus a time-of-day traffic model, so the demo works with no paid API. To use a real provider:

1. Deploy a server-side endpoint at `/api/route` (edge function or Node) that accepts `{ provider, from, to, departAt }`, calls Google Routes / Mapbox Directions / OpenRouteService with `ROUTING_API_KEY`, and returns `{ points: [{lat,lng}…], distanceKm, durationSec, trafficLevel }`.
2. Set `VITE_ROUTING_PROVIDER=google` (or `mapbox` / `ors`).

`ProxyRoutingProvider` calls that endpoint and **falls back to the mock provider** if it fails; the UI labels such routes with "(fallback)". The API key never reaches the browser.

## 8. Accessibility & UX

Keyboard-navigable, focus-trapped modals, visible focus, ARIA live regions for alerts, status never conveyed by colour alone (icon + text labels), mobile-first crew view, responsive down to 360 px, print stylesheet for incident reports. Loading, empty, error and offline states are handled; offline shows last-known data with a banner and blocks actions.

## 9. Limitations & safety

- **Demo only.** Not clinically validated, not certified, not for real emergencies. Do not enter real patient data.
- The recommendation is decision support; a human must review it. There is no automatic dispatch.
- Capacity numbers are only as good as the last update — stale data is flagged and should be verified by phone.
- ETAs come from a mock traffic model unless a real routing provider is configured.
- The demo backend runs in the browser (see architecture note); production needs a real server + Postgres.
- Map tiles and Leaflet load from public CDNs; offline, a schematic SVG map is shown instead.
- Password reset is a placeholder; production should use Supabase Auth (email verification, MFA for staff).
- Run `supabase/schema.sql` once on a fresh database (policies are not re-runnable). Load seed data by mirroring `buildSeed()` in `src/server/seed.ts` and creating the matching Auth users.
