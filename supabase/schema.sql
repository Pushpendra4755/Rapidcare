-- RapidCare — PostgreSQL / Supabase schema with Row Level Security.
-- DEMO decision-support platform. Recommendations must be reviewed by authorized emergency and clinical personnel.
--
-- Mirrors src/lib/types.ts and the authorization rules implemented in src/server/*.
-- Apply with:  psql "$DATABASE_URL" -f supabase/schema.sql   (or paste into the Supabase SQL editor)
-- Contains NO real patient data. Seed rows at the bottom are fictional demo data.

create extension if not exists pgcrypto;

-- ───────────────────────── enums ─────────────────────────
do $$ begin
  create type user_role as enum ('ADMIN','DISPATCHER','HOSPITAL_STAFF','AMBULANCE_CREW');
  create type severity as enum ('LOW','MODERATE','HIGH','CRITICAL');
  create type emergency_type as enum ('TRAUMA','CARDIAC','STROKE','RESPIRATORY','BURN','PEDIATRIC','OBSTETRIC','POISONING','OTHER');
  create type age_group as enum ('ADULT','CHILD','NEONATAL','UNKNOWN');
  create type acceptance_status as enum ('ACCEPTING','LIMITED_CAPACITY','DIVERTING','UNAVAILABLE');
  create type ambulance_status as enum ('OFFLINE','AVAILABLE','ASSIGNED','EN_ROUTE_PICKUP','AT_PICKUP','PATIENT_ONBOARD','EN_ROUTE_HOSPITAL','AT_HOSPITAL');
  create type incident_status as enum ('NEW','AMBULANCE_ASSIGNED','EN_ROUTE_PICKUP','AT_PICKUP','PATIENT_ONBOARD','EN_ROUTE_HOSPITAL','ARRIVED','HANDED_OVER','CLOSED','CANCELLED');
  create type request_status as enum ('PENDING','INFO_REQUESTED','ACCEPTED','DECLINED','NO_RESPONSE','CANCELLED','ESCALATED');
  create type recommendation_label as enum ('BEST_MATCH','ELIGIBLE_ALTERNATIVE','LIMITED_CAPACITY','NOT_ELIGIBLE','STALE_VERIFY');
exception when duplicate_object then null; end $$;

-- ───────────────────────── reference tables ─────────────────────────
create table if not exists service_areas (
  id text primary key,
  name text not null,
  bounds double precision[4] not null,          -- south, west, north, east
  neighbors text[] not null default '{}'
);

create table if not exists emergency_categories (
  id emergency_type primary key,
  label text not null,
  default_capabilities text[] not null default '{}',
  default_resources text[] not null default '{}',
  active boolean not null default true
);

create table if not exists system_config (
  id int primary key default 1 check (id = 1),  -- single row
  config jsonb not null,
  updated_at timestamptz not null default now()
);

-- ───────────────────────── hospitals ─────────────────────────
create table if not exists hospitals (
  id text primary key,
  name text not null,
  address text not null,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  entrance_lat double precision not null,
  entrance_lng double precision not null,
  phone text not null,
  emergency_contact text not null,
  status text not null default 'ONLINE' check (status in ('ONLINE','OFFLINE')),
  region_id text references service_areas(id),
  total_er_beds int not null check (total_er_beds >= 0),
  total_icu_beds int not null check (total_icu_beds >= 0),
  total_ventilators int not null check (total_ventilators >= 0),
  total_trauma_bays int not null check (total_trauma_bays >= 0),
  total_isolation_beds int not null check (total_isolation_beds >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists hospital_capabilities (
  hospital_id text not null references hospitals(id) on delete cascade,
  capability text not null check (capability in ('TRAUMA','CARDIAC','STROKE','PEDIATRIC','BURN','OBSTETRIC','NEONATAL')),
  available boolean not null default false,
  primary key (hospital_id, capability)
);

create table if not exists hospital_resource_status (
  hospital_id text primary key references hospitals(id) on delete cascade,
  available_er_beds int not null check (available_er_beds >= 0),
  available_icu_beds int not null check (available_icu_beds >= 0),
  available_ventilators int not null check (available_ventilators >= 0),
  available_trauma_bays int not null check (available_trauma_bays >= 0),
  available_isolation_beds int not null check (available_isolation_beds >= 0),
  acceptance_status acceptance_status not null default 'ACCEPTING',
  operational_notes text not null default '' check (char_length(operational_notes) <= 500),
  last_verified_at timestamptz,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  data_source text not null default 'HOSPITAL_STAFF'
    check (data_source in ('HOSPITAL_STAFF','DEMO_SEED','DEMO_SIM','PHONE_CONFIRMED'))
);

-- Available can never exceed total (cross-table rule enforced by trigger).
create or replace function enforce_capacity_bounds() returns trigger language plpgsql as $$
declare h hospitals%rowtype;
begin
  select * into h from hospitals where id = new.hospital_id;
  if new.available_er_beds > h.total_er_beds
     or new.available_icu_beds > h.total_icu_beds
     or new.available_ventilators > h.total_ventilators
     or new.available_trauma_bays > h.total_trauma_bays
     or new.available_isolation_beds > h.total_isolation_beds then
    raise exception 'Available count cannot exceed total capacity' using errcode = '23514';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_capacity_bounds on hospital_resource_status;
create trigger trg_capacity_bounds before insert or update on hospital_resource_status
  for each row execute function enforce_capacity_bounds();

-- Freshness is derived, never stored as truth.
-- LIVE <= 5 min, RECENT <= 15 min, STALE > 15 min, UNAVAILABLE when never verified.
create or replace view hospital_freshness as
select hospital_id,
  case
    when last_verified_at is null then 'UNAVAILABLE'
    when now() - last_verified_at <= interval '5 minutes'  then 'LIVE'
    when now() - last_verified_at <= interval '15 minutes' then 'RECENT'
    else 'STALE'
  end as freshness,
  extract(epoch from (now() - last_verified_at)) / 60.0 as age_minutes
from hospital_resource_status;

-- ───────────────────────── users ─────────────────────────
-- id matches auth.users.id (Supabase Auth). Passwords live in Auth, never here.
create table if not exists app_users (
  id uuid primary key,
  full_name text not null,
  email text not null unique,
  role user_role not null,
  hospital_id text references hospitals(id),
  ambulance_id text,                              -- FK added after ambulances
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hospital_staff_needs_hospital check (role <> 'HOSPITAL_STAFF' or hospital_id is not null),
  constraint crew_needs_ambulance check (role <> 'AMBULANCE_CREW' or ambulance_id is not null)
);

create table if not exists ambulances (
  id text primary key,
  code text not null unique,
  vehicle_type text not null check (vehicle_type in ('ALS','BLS','NEONATAL_TRANSPORT')),
  status ambulance_status not null default 'OFFLINE',
  lat double precision not null,
  lng double precision not null,
  gps_accuracy_meters double precision,
  speed_kmph double precision not null default 0,
  heading_degrees double precision not null default 0,
  last_location_at timestamptz,
  operator_name text not null default '',
  location_sharing boolean not null default false,
  region_id text references service_areas(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table app_users drop constraint if exists app_users_ambulance_fk;
alter table app_users add constraint app_users_ambulance_fk foreign key (ambulance_id) references ambulances(id);

-- ───────────────────────── incidents (minimal patient data) ─────────────────────────
-- Deliberately NO name, DOB, ID number, phone or diagnosis columns.
create table if not exists incidents (
  id uuid primary key default gen_random_uuid(),
  incident_code text not null unique,
  emergency_type emergency_type not null,
  severity severity not null,
  patient_age_group age_group not null default 'UNKNOWN',
  pickup_lat double precision,
  pickup_lng double precision,
  pickup_address text,
  pickup_source text not null default 'ADDRESS' check (pickup_source in ('ADDRESS','MAP_PIN','CALLER_SHARED')),
  pickup_precision_reduced boolean not null default false,
  region_id text references service_areas(id),
  required_resources text[] not null default '{}',
  required_capabilities text[] not null default '{}',
  pre_arrival_notes text not null default '' check (char_length(pre_arrival_notes) <= 500),
  status incident_status not null default 'NEW',
  assigned_ambulance_id text references ambulances(id),
  selected_hospital_id text references hospitals(id),
  destination_confirmed boolean not null default false,
  declined_hospital_ids text[] not null default '{}',
  trip_started boolean not null default false,
  escalation_level int not null default 0,
  handover_confirmed boolean not null default false,
  created_by uuid references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists incidents_status_idx on incidents(status);
create index if not exists incidents_ambulance_idx on incidents(assigned_ambulance_id);
create index if not exists incidents_hospital_idx on incidents(selected_hospital_id);

create table if not exists hospital_recommendations (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  hospital_id text not null references hospitals(id),
  eligible boolean not null,
  label recommendation_label not null,
  ineligibility_reasons text[] not null default '{}',
  warnings text[] not null default '{}',
  reasons text[] not null default '{}',
  summary text not null default '',
  distance_km double precision,
  eta_minutes double precision,
  resource_match_score numeric(5,2) not null,
  specialty_match_score numeric(5,2) not null,
  eta_score numeric(5,2) not null,
  freshness_score numeric(5,2) not null,
  workload_score numeric(5,2) not null,
  final_score numeric(5,2) not null,
  rank int,
  freshness text not null,
  capacity_age_minutes double precision,
  generated_at timestamptz not null default now(),
  unique (incident_id, hospital_id, generated_at)
);
create index if not exists recs_incident_idx on hospital_recommendations(incident_id, generated_at desc);

create table if not exists hospital_requests (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  hospital_id text not null references hospitals(id),
  status request_status not null default 'PENDING',
  sent_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  responded_at timestamptz,
  decision text check (decision in ('ACCEPT','DECLINE','PHONE_ACCEPT','PHONE_DECLINE')),
  decline_reason text,
  estimated_arrival_minutes double precision,
  expires_at timestamptz not null,
  reserved_resources text[] not null default '{}',   -- populated ONLY on explicit acceptance
  info_request_message text,
  dispatcher_reply text,
  override_reason text,
  prep_checklist jsonb not null default '{}'::jsonb,
  phone_calls jsonb not null default '[]'::jsonb,
  constraint reserve_only_if_accepted check (status = 'ACCEPTED' or cardinality(reserved_resources) = 0),
  constraint override_reason_len check (override_reason is null or char_length(override_reason) >= 5)
);
create index if not exists requests_hospital_idx on hospital_requests(hospital_id, status);
create index if not exists requests_incident_idx on hospital_requests(incident_id);

create table if not exists ambulance_location_history (
  id bigint generated always as identity primary key,
  ambulance_id text not null references ambulances(id),
  incident_id uuid references incidents(id),
  lat double precision not null,
  lng double precision not null,
  accuracy_meters double precision,
  speed_kmph double precision not null default 0,
  heading_degrees double precision not null default 0,
  recorded_at timestamptz not null default now()
);
create index if not exists loc_amb_time_idx on ambulance_location_history(ambulance_id, recorded_at desc);
create index if not exists loc_incident_idx on ambulance_location_history(incident_id, recorded_at);

create table if not exists incident_timeline (
  id uuid primary key default gen_random_uuid(),
  incident_id uuid not null references incidents(id) on delete cascade,
  at timestamptz not null default now(),
  type text not null,
  actor text not null,
  message text not null,
  meta jsonb
);
create index if not exists timeline_incident_idx on incident_timeline(incident_id, at);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid references app_users(id),
  recipient_hospital_id text references hospitals(id),
  recipient_ambulance_id text references ambulances(id),
  recipient_role user_role,
  incident_id uuid references incidents(id) on delete cascade,
  type text not null,
  title text not null,
  message text not null,
  severity text not null default 'INFO' check (severity in ('INFO','WARNING','CRITICAL')),
  requires_ack boolean not null default false,
  status text not null default 'SENT' check (status in ('SENT','READ','ACKNOWLEDGED')),
  sent_at timestamptz not null default now(),
  read_at timestamptz,
  acknowledged_at timestamptz
);
create index if not exists notif_user_idx on notifications(recipient_user_id, sent_at desc);
create index if not exists notif_hospital_idx on notifications(recipient_hospital_id, sent_at desc);

create table if not exists audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid,
  actor_label text not null,
  action_type text not null,
  entity_type text not null,
  entity_id text not null,
  previous_value jsonb,
  new_value jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_created_idx on audit_logs(created_at desc);

-- ───────────────────────── immutability: audit log + timeline are append-only ─────────────────────────
create or replace function forbid_mutation() returns trigger language plpgsql as $$
begin raise exception '% is append-only', tg_table_name using errcode = '42501'; end $$;
drop trigger if exists trg_audit_immutable on audit_logs;
create trigger trg_audit_immutable before update or delete on audit_logs for each row execute function forbid_mutation();
drop trigger if exists trg_timeline_immutable on incident_timeline;
create trigger trg_timeline_immutable before update or delete on incident_timeline for each row execute function forbid_mutation();

-- Generic updated_at touch
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
do $$ declare t text; begin
  foreach t in array array['hospitals','ambulances','incidents','app_users'] loop
    execute format('drop trigger if exists trg_touch_%1$s on %1$s; create trigger trg_touch_%1$s before update on %1$s for each row execute function touch_updated_at();', t);
  end loop;
end $$;

-- ───────────────────────── RLS helpers ─────────────────────────
-- SECURITY DEFINER so policies can read app_users without recursion.
create or replace function auth_role() returns user_role language sql stable security definer set search_path = public as
$$ select role from app_users where id = auth.uid() and active $$;
create or replace function auth_hospital() returns text language sql stable security definer set search_path = public as
$$ select hospital_id from app_users where id = auth.uid() and active $$;
create or replace function auth_ambulance() returns text language sql stable security definer set search_path = public as
$$ select ambulance_id from app_users where id = auth.uid() and active $$;
create or replace function is_ops() returns boolean language sql stable as
$$ select auth_role() in ('ADMIN','DISPATCHER') $$;

alter table service_areas enable row level security;
alter table emergency_categories enable row level security;
alter table system_config enable row level security;
alter table hospitals enable row level security;
alter table hospital_capabilities enable row level security;
alter table hospital_resource_status enable row level security;
alter table app_users enable row level security;
alter table ambulances enable row level security;
alter table incidents enable row level security;
alter table hospital_recommendations enable row level security;
alter table hospital_requests enable row level security;
alter table ambulance_location_history enable row level security;
alter table incident_timeline enable row level security;
alter table notifications enable row level security;
alter table audit_logs enable row level security;

-- reference data: any signed-in active user may read; only ADMIN writes
create policy ref_read_areas on service_areas for select using (auth_role() is not null);
create policy ref_admin_areas on service_areas for all using (auth_role() = 'ADMIN') with check (auth_role() = 'ADMIN');
create policy ref_read_cats on emergency_categories for select using (auth_role() is not null);
create policy ref_admin_cats on emergency_categories for all using (auth_role() = 'ADMIN') with check (auth_role() = 'ADMIN');
create policy cfg_read on system_config for select using (is_ops());
create policy cfg_admin on system_config for all using (auth_role() = 'ADMIN') with check (auth_role() = 'ADMIN');

-- hospitals: ops read all; hospital staff read own; ADMIN writes master data
create policy hosp_read_ops on hospitals for select using (is_ops());
create policy hosp_read_own on hospitals for select using (auth_role() = 'HOSPITAL_STAFF' and id = auth_hospital());
create policy hosp_admin on hospitals for all using (auth_role() = 'ADMIN') with check (auth_role() = 'ADMIN');
create policy cap_read_ops on hospital_capabilities for select using (is_ops());
create policy cap_read_own on hospital_capabilities for select using (auth_role() = 'HOSPITAL_STAFF' and hospital_id = auth_hospital());
create policy cap_admin on hospital_capabilities for all using (auth_role() = 'ADMIN') with check (auth_role() = 'ADMIN');

-- live capacity: ops read all; staff read + update ONLY their own row
create policy res_read_ops on hospital_resource_status for select using (is_ops());
create policy res_read_own on hospital_resource_status for select using (auth_role() = 'HOSPITAL_STAFF' and hospital_id = auth_hospital());
create policy res_update_own on hospital_resource_status for update
  using (auth_role() = 'HOSPITAL_STAFF' and hospital_id = auth_hospital())
  with check (auth_role() = 'HOSPITAL_STAFF' and hospital_id = auth_hospital());
create policy res_admin on hospital_resource_status for all using (auth_role() = 'ADMIN') with check (auth_role() = 'ADMIN');

-- users: each user reads self; ADMIN manages all. Role/hospital columns are not user-editable.
create policy users_self on app_users for select using (id = auth.uid());
create policy users_admin on app_users for all using (auth_role() = 'ADMIN') with check (auth_role() = 'ADMIN');
create policy users_ops_read on app_users for select using (auth_role() = 'DISPATCHER');

-- ambulances: ops all; crew read + update own (location/status via RPC below)
create policy amb_ops on ambulances for select using (is_ops());
create policy amb_own on ambulances for select using (auth_role() = 'AMBULANCE_CREW' and id = auth_ambulance());
create policy amb_admin on ambulances for all using (auth_role() = 'ADMIN') with check (auth_role() = 'ADMIN');
create policy amb_ops_write on ambulances for update using (auth_role() = 'DISPATCHER') with check (auth_role() = 'DISPATCHER');

-- incidents: ops all; hospital staff ONLY incidents with a request sent to their hospital; crew ONLY their assigned incident
create policy inc_ops on incidents for all using (is_ops()) with check (is_ops());
create policy inc_hospital on incidents for select using (
  auth_role() = 'HOSPITAL_STAFF' and exists (
    select 1 from hospital_requests r where r.incident_id = incidents.id and r.hospital_id = auth_hospital()));
create policy inc_crew on incidents for select using (
  auth_role() = 'AMBULANCE_CREW' and assigned_ambulance_id = auth_ambulance());

-- Hospital staff must not see pickup location or creator. Expose a redacted view for them.
create or replace view incidents_for_hospital with (security_invoker = true) as
select id, incident_code, emergency_type, severity, patient_age_group, region_id,
       required_resources, required_capabilities, pre_arrival_notes, status,
       assigned_ambulance_id, selected_hospital_id, destination_confirmed, created_at, updated_at
from incidents;   -- no pickup_*, no created_by

-- recommendations: ops only (hospital staff never see competitor scoring)
create policy rec_ops on hospital_recommendations for select using (is_ops());
create policy rec_ops_write on hospital_recommendations for insert with check (is_ops());

-- requests: ops all; hospital staff read + respond to own hospital's; crew none
create policy req_ops on hospital_requests for all using (is_ops()) with check (is_ops());
create policy req_hospital_read on hospital_requests for select using (auth_role() = 'HOSPITAL_STAFF' and hospital_id = auth_hospital());
create policy req_hospital_respond on hospital_requests for update
  using (auth_role() = 'HOSPITAL_STAFF' and hospital_id = auth_hospital() and status in ('PENDING','INFO_REQUESTED'))
  with check (auth_role() = 'HOSPITAL_STAFF' and hospital_id = auth_hospital());

-- location history: ops read; crew insert for own ambulance only
create policy loc_ops on ambulance_location_history for select using (is_ops());
create policy loc_crew_insert on ambulance_location_history for insert
  with check (auth_role() = 'AMBULANCE_CREW' and ambulance_id = auth_ambulance());
create policy loc_crew_read on ambulance_location_history for select
  using (auth_role() = 'AMBULANCE_CREW' and ambulance_id = auth_ambulance());

-- timeline: visible wherever the incident is visible; insert by ops/system only (immutable)
create policy tl_read on incident_timeline for select using (
  exists (select 1 from incidents i where i.id = incident_timeline.incident_id));
create policy tl_insert on incident_timeline for insert with check (is_ops());

-- notifications: recipients only
create policy notif_read on notifications for select using (
  recipient_user_id = auth.uid()
  or (recipient_hospital_id is not null and recipient_hospital_id = auth_hospital())
  or (recipient_ambulance_id is not null and recipient_ambulance_id = auth_ambulance())
  or (recipient_role is not null and recipient_role = auth_role()));
create policy notif_ack on notifications for update using (
  recipient_user_id = auth.uid()
  or (recipient_hospital_id is not null and recipient_hospital_id = auth_hospital())
  or (recipient_ambulance_id is not null and recipient_ambulance_id = auth_ambulance()));
create policy notif_ops_insert on notifications for insert with check (is_ops());

-- audit: ADMIN reads; inserts via server/RPC only (service role bypasses RLS)
create policy audit_admin_read on audit_logs for select using (auth_role() = 'ADMIN');

-- ───────────────────────── RPCs for narrow, validated writes ─────────────────────────
-- Crew location ping: updates the ambulance row and appends history in one call, own ambulance only.
create or replace function crew_ping_location(p_lat double precision, p_lng double precision,
  p_accuracy double precision default null, p_speed double precision default 0, p_heading double precision default 0)
returns void language plpgsql security definer set search_path = public as $$
declare a text := auth_ambulance(); inc uuid;
begin
  if auth_role() <> 'AMBULANCE_CREW' or a is null then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_lat not between -90 and 90 or p_lng not between -180 and 180 then raise exception 'invalid coordinates'; end if;
  update ambulances set lat = p_lat, lng = p_lng, gps_accuracy_meters = p_accuracy, speed_kmph = p_speed,
         heading_degrees = p_heading, last_location_at = now(), location_sharing = true where id = a;
  select id into inc from incidents where assigned_ambulance_id = a and status not in ('CLOSED','CANCELLED') limit 1;
  insert into ambulance_location_history(ambulance_id, incident_id, lat, lng, accuracy_meters, speed_kmph, heading_degrees)
    values (a, inc, p_lat, p_lng, p_accuracy, p_speed, p_heading);
end $$;
revoke all on function crew_ping_location from public;
grant execute on function crew_ping_location to authenticated;

-- Hospital accept/decline. Resources are marked reserved ONLY here, on explicit acceptance.
create or replace function hospital_respond(p_request uuid, p_decision text, p_reason text default null, p_eta double precision default null)
returns void language plpgsql security definer set search_path = public as $$
declare r hospital_requests%rowtype; inc incidents%rowtype;
begin
  select * into r from hospital_requests where id = p_request;
  if not found or auth_role() <> 'HOSPITAL_STAFF' or r.hospital_id <> auth_hospital() then
    raise exception 'forbidden' using errcode = '42501'; end if;
  if r.status not in ('PENDING','INFO_REQUESTED') then raise exception 'request already closed'; end if;
  if p_decision = 'ACCEPT' then
    select * into inc from incidents where id = r.incident_id;
    update hospital_requests set status = 'ACCEPTED', decision = 'ACCEPT', responded_at = now(),
      estimated_arrival_minutes = p_eta, reserved_resources = inc.required_resources where id = r.id;
    update incidents set destination_confirmed = true, selected_hospital_id = r.hospital_id where id = r.incident_id;
  elsif p_decision = 'DECLINE' then
    if coalesce(btrim(p_reason), '') = '' then raise exception 'decline reason required'; end if;
    update hospital_requests set status = 'DECLINED', decision = 'DECLINE', responded_at = now(), decline_reason = p_reason where id = r.id;
    update incidents set declined_hospital_ids = array_append(declined_hospital_ids, r.hospital_id),
      destination_confirmed = false where id = r.incident_id;
  else raise exception 'invalid decision'; end if;
  insert into audit_logs(actor_user_id, actor_label, action_type, entity_type, entity_id, new_value)
    values (auth.uid(), 'hospital:' || r.hospital_id, 'REQUEST_' || p_decision, 'hospital_request', r.id::text,
            jsonb_build_object('reason', p_reason, 'eta', p_eta));
end $$;
revoke all on function hospital_respond from public;
grant execute on function hospital_respond to authenticated;

-- ───────────────────────── Realtime ─────────────────────────
-- Clients subscribe to postgres_changes on these tables; RLS filters rows per user.
-- Channel mapping used by the app:  dispatcher:operations, hospital:{id}, ambulance:{id}, incident:{id}
do $$ begin
  begin alter publication supabase_realtime add table incidents; exception when others then null; end;
  begin alter publication supabase_realtime add table hospital_requests; exception when others then null; end;
  begin alter publication supabase_realtime add table hospital_resource_status; exception when others then null; end;
  begin alter publication supabase_realtime add table ambulances; exception when others then null; end;
  begin alter publication supabase_realtime add table notifications; exception when others then null; end;
  begin alter publication supabase_realtime add table incident_timeline; exception when others then null; end;
end $$;

-- ───────────────────────── Seed notes ─────────────────────────
-- The full fictional seed (5 hospitals, 5 ambulances, scenario incidents, 10 historical incidents, demo users)
-- lives in src/server/seed.ts (buildSeed). To load it into Postgres, create demo users in Supabase Auth with
-- the @demo.rapidcare.test addresses, then insert rows mirroring buildSeed(). Minimal example:
insert into service_areas(id,name,bounds,neighbors) values
  ('z_central','Central','{12.94,77.57,13.00,77.64}','{z_north,z_south,z_east,z_west}')
on conflict do nothing;
-- Never load real patient data into this demo schema.
