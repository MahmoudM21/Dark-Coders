-- =====================================================================
-- Clinic Reception Agent — schema + deterministic booking functions
-- Target: PostgreSQL 15+ (Supabase-compatible). Tested on PostgreSQL 16.
--
-- Design rules
--  1. The LLM never writes to these tables. It calls tools; tools call the
--     clinic_* functions below. Each function = ONE transaction.
--  2. Double-booking is prevented by EXCLUDE constraints, not app logic.
--  3. Every write that changes a booking requires a server-issued,
--     single-use, human-decided approval row (see `approvals`).
--  4. No medical data is stored (data minimisation). Name + phone only.
--  5. All tables: RLS on, no policies, no anon/authenticated grants.
--     Only the service role (server-side) can touch them.
--  Weekday convention: 0 = Sunday ... 6 = Saturday (Postgres extract(dow)).
-- =====================================================================

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------
-- Tenancy & clinic setup
-- ---------------------------------------------------------------------
create table if not exists tenants (
  id             uuid primary key default gen_random_uuid(),
  slug           text not null unique,
  name           text not null,
  name_ar        text,
  default_locale text not null default 'ar-EG',
  created_at     timestamptz not null default now()
);

create table if not exists branches (
  id                        uuid primary key default gen_random_uuid(),
  tenant_id                 uuid not null references tenants(id) on delete cascade,
  slug                      text not null,
  name                      text not null,
  name_ar                   text,
  address                   text,
  address_ar                text,
  phone                     text,
  timezone                  text not null default 'Africa/Cairo',   -- IANA name, never a fixed offset (DST)
  emergency_contact_name    text,
  emergency_phone           text,          -- on-call human (E.164)
  emergency_email           text,
  emergency_services_number text not null default '123',            -- spoken to callers; verify per country
  require_booking_approval  boolean not null default true,
  hold_ttl_seconds          int  not null default 180 check (hold_ttl_seconds between 30 and 900),
  min_notice_minutes        int  not null default 60  check (min_notice_minutes >= 0),
  max_advance_days          int  not null default 60  check (max_advance_days between 1 and 365),
  cancel_cutoff_hours       int  not null default 12  check (cancel_cutoff_hours >= 0),
  created_at                timestamptz not null default now(),
  unique (tenant_id, slug)
);

-- Staffed hours of the branch (used ONLY for escalation routing).
create table if not exists branch_hours (
  branch_id uuid not null references branches(id) on delete cascade,
  weekday   smallint not null check (weekday between 0 and 6),
  opens     time not null,
  closes    time not null,
  check (closes > opens),
  primary key (branch_id, weekday, opens)
);

create table if not exists specialties (
  id        uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name_en   text not null,
  name_ar   text,
  unique (tenant_id, name_en)
);

create table if not exists visit_types (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  code             text not null,                       -- e.g. 'consultation'
  name_en          text not null,
  name_ar          text,
  duration_minutes int  not null check (duration_minutes between 5 and 240),
  unique (tenant_id, code)
);

create table if not exists doctors (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  slug         text not null,                           -- model-facing reference, e.g. 'dr-ahmed-samir'
  full_name_en text not null,
  full_name_ar text,
  specialty_id uuid references specialties(id),
  slot_minutes int  not null default 15 check (slot_minutes between 5 and 120),  -- booking grid
  active       boolean not null default true,
  unique (tenant_id, slug)
);

create table if not exists doctor_visit_types (
  doctor_id     uuid not null references doctors(id) on delete cascade,
  visit_type_id uuid not null references visit_types(id) on delete cascade,
  primary key (doctor_id, visit_type_id)
);

-- Weekly recurring working hours of a doctor at a branch.
create table if not exists doctor_schedules (
  id         uuid primary key default gen_random_uuid(),
  doctor_id  uuid not null references doctors(id) on delete cascade,
  branch_id  uuid not null references branches(id) on delete cascade,
  weekday    smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time   time not null,
  check (end_time > start_time)
);
create index if not exists doctor_schedules_lookup on doctor_schedules (branch_id, weekday, doctor_id);

create table if not exists doctor_time_off (
  id        uuid primary key default gen_random_uuid(),
  doctor_id uuid not null references doctors(id) on delete cascade,
  during    tstzrange not null,
  reason    text
);
create index if not exists doctor_time_off_gist on doctor_time_off using gist (doctor_id, during);

-- ---------------------------------------------------------------------
-- People & conversations
-- ---------------------------------------------------------------------
create table if not exists patients (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  full_name          text not null check (length(trim(full_name)) between 2 and 120),
  phone_e164         text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  preferred_language text not null default 'ar',
  created_at         timestamptz not null default now()
);
create unique index if not exists patients_identity on patients (tenant_id, phone_e164, lower(full_name));

-- One row per conversation. id is supplied by the console (UUIDv4, treated as a bearer value).
create table if not exists call_sessions (
  id           uuid primary key,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  branch_id    uuid references branches(id) on delete cascade,   -- NULL until the caller chooses a branch (clinic_select_branch)
  channel      text not null default 'console_voice',
  locale       text not null default 'ar-EG',
  patient_id   uuid references patients(id),            -- bound SERVER-SIDE by clinic_identify_patient
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at     timestamptz,
  outcome      text,
  summary      text
);

-- ---------------------------------------------------------------------
-- Appointments (the source of truth for availability)
-- ---------------------------------------------------------------------
create table if not exists appointments (
  id                uuid primary key default gen_random_uuid(),
  confirmation_code text not null default upper(substr(replace(gen_random_uuid()::text,'-',''),1,6)),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  branch_id         uuid not null references branches(id),
  doctor_id         uuid not null references doctors(id),
  patient_id        uuid not null references patients(id),
  visit_type_id     uuid not null references visit_types(id),
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  status            text not null default 'held'
                    check (status in ('held','booked','cancelled','completed','no_show','expired')),
  hold_expires_at   timestamptz,
  source            text not null default 'console_voice',
  session_id        uuid references call_sessions(id),
  approval_id       text,                                -- FK added after approvals exists
  rescheduled_from  uuid references appointments(id),
  cancel_reason     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (ends_at > starts_at),
  check ((status = 'held') = (hold_expires_at is not null)),
  constraint appt_no_doctor_overlap  exclude using gist
    (doctor_id  with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status in ('held','booked')),
  constraint appt_no_patient_overlap exclude using gist
    (patient_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status in ('held','booked'))
);
create unique index if not exists appointments_code on appointments (confirmation_code);
create index if not exists appointments_patient on appointments (patient_id, starts_at);

-- ---------------------------------------------------------------------
-- Human approval (server-side; the model can never mint or flip one)
-- ---------------------------------------------------------------------
create table if not exists approvals (
  id           text primary key default ('apr_' || substr(replace(gen_random_uuid()::text,'-',''),1,12)),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  session_id   uuid not null references call_sessions(id) on delete cascade,
  action       text not null check (action in ('confirm_booking','reschedule_appointment','cancel_appointment')),
  params       jsonb not null,                           -- exact bound parameters (appointment_id, new_starts_at, reason)
  title        text not null,
  summary      text not null,                            -- server-generated truth shown in the Approval panel
  risk         text not null check (risk in ('low','medium','high')),
  status       text not null default 'pending'
               check (status in ('pending','approved','denied','consumed')),
  requested_at timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '10 minutes',
  decided_at   timestamptz,
  decided_by   text,                                     -- 'operator:<id>' | 'policy:auto'
  consumed_at  timestamptz
);
alter table appointments
  add constraint appointments_approval_fk foreign key (approval_id) references approvals(id);

-- ---------------------------------------------------------------------
-- Notes, escalations, audit
-- ---------------------------------------------------------------------
create table if not exists call_notes (
  id             uuid primary key default gen_random_uuid(),
  session_id     uuid not null references call_sessions(id) on delete cascade,
  appointment_id uuid references appointments(id),
  kind           text not null check (kind in ('note','summary')),
  body           text not null check (length(body) between 1 and 2000),
  created_at     timestamptz not null default now()
);

create table if not exists escalations (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  branch_id        uuid not null references branches(id),
  session_id       uuid not null references call_sessions(id),
  severity         text not null check (severity in ('emergency','urgent','handoff')),
  reason           text not null,
  summary          text not null,
  within_hours     boolean not null,
  route            text not null check (route in ('live_transfer','notify_contact')),
  status           text not null default 'recorded'
                   check (status in ('recorded','connected','notified','delivery_failed')),
  channel          text,                                  -- 'sip' | 'email' | 'sms' | 'none'
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      text
);

create table if not exists audit_events (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  tenant_id   uuid,
  session_id  uuid,
  actor       text not null check (actor in ('agent','bridge','operator','system')),
  event       text not null,                              -- 'tool_call' | 'approval_decided' | 'escalation' ...
  tool        text,
  input       jsonb,                                      -- redacted by the service before insert
  outcome     text not null check (outcome in ('ok','error','denied')),
  error_code  text,
  latency_ms  int
);
create index if not exists audit_session on audit_events (session_id, at);

-- =====================================================================
-- Helpers
-- =====================================================================
create or replace function clinic_err(p_code text, p_message text, p_details jsonb default '{}'::jsonb, p_retryable boolean default false)
returns jsonb language sql immutable as $$
  select jsonb_build_object('ok', false, 'error',
    jsonb_build_object('code', p_code, 'message', p_message, 'retryable', p_retryable, 'details', p_details));
$$;

create or replace function clinic_iso(p_ts timestamptz)
returns text language sql immutable as $$
  select to_char(p_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');   -- always UTC instant, parseable everywhere
$$;

create or replace function clinic_fmt_local(p_ts timestamptz, p_tz text)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'iso',        clinic_iso(p_ts),
    'iso_date',   to_char(l, 'YYYY-MM-DD'),
    'time_24',    to_char(l, 'HH24:MI'),
    'weekday_en', (array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])[extract(dow from l)::int + 1],
    'weekday_ar', (array['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'])[extract(dow from l)::int + 1],
    'spoken_en',  (array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])[extract(dow from l)::int + 1]
                  || ' ' || (array['January','February','March','April','May','June','July','August','September','October','November','December'])[extract(month from l)::int]
                  || ' ' || extract(day from l)::int || ' at ' || to_char(l, 'FMHH12:MI AM'),
    'spoken_ar',  (array['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'])[extract(dow from l)::int + 1]
                  || ' ' || extract(day from l)::int
                  || ' ' || (array['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'])[extract(month from l)::int]
                  || ' الساعة ' || (((extract(hour from l)::int + 11) % 12) + 1)
                  || case when extract(minute from l)::int = 0 then '' else ':' || lpad(extract(minute from l)::int::text, 2, '0') end
                  || case when extract(hour from l)::int < 12 then ' صباحًا' else ' مساءً' end
  ) from (select p_ts at time zone p_tz as l) x;
$$;

-- =====================================================================
-- Slot search (pure read). Availability = schedule − time off − active appointments.
-- =====================================================================
create or replace function clinic_search_slots(
  p_branch uuid, p_doctor uuid, p_visit_type uuid,
  p_from timestamptz, p_to timestamptz,
  p_part_of_day text default null, p_limit int default 6, p_exclude_appt uuid default null)
returns table (doctor_id uuid, starts_at timestamptz, ends_at timestamptz)
language sql stable as $$
  with b as (
    select timezone as tz, min_notice_minutes as mn, max_advance_days as ma from branches where id = p_branch
  ), vt as (
    select duration_minutes as dur from visit_types where id = p_visit_type
  ), days as (
    select d::date as day, b.tz, b.mn, b.ma
    from b, generate_series((p_from at time zone b.tz)::date, (p_to at time zone b.tz)::date, interval '1 day') d
  ), cand as (
    select d.id as doc, days.tz, days.mn, days.ma, vt.dur,
           (g.t at time zone days.tz) as s
    from days
    join doctor_schedules ds on ds.branch_id = p_branch and ds.weekday = extract(dow from days.day)::int
    join doctors d on d.id = ds.doctor_id and d.active and (p_doctor is null or d.id = p_doctor)
    join doctor_visit_types dvt on dvt.doctor_id = d.id and dvt.visit_type_id = p_visit_type
    cross join vt
    cross join lateral generate_series(days.day + ds.start_time,
                                       days.day + ds.end_time - make_interval(mins => vt.dur),
                                       make_interval(mins => d.slot_minutes)) as g(t)
  )
  select c.doc, c.s, c.s + make_interval(mins => c.dur)
  from cand c
  where c.s >= greatest(p_from, now() + make_interval(mins => c.mn))
    and c.s <  p_to
    and c.s <= now() + make_interval(days => c.ma)
    and (p_part_of_day is null
         or (p_part_of_day = 'morning'   and extract(hour from c.s at time zone c.tz) <  12)
         or (p_part_of_day = 'afternoon' and extract(hour from c.s at time zone c.tz) between 12 and 16)
         or (p_part_of_day = 'evening'   and extract(hour from c.s at time zone c.tz) >= 17))
    and not exists (select 1 from doctor_time_off t
                    where t.doctor_id = c.doc and t.during && tstzrange(c.s, c.s + make_interval(mins => c.dur), '[)'))
    and not exists (select 1 from appointments a
                    where a.doctor_id = c.doc
                      and a.id is distinct from p_exclude_appt
                      and (a.status = 'booked' or (a.status = 'held' and a.hold_expires_at > now()))
                      and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(c.s, c.s + make_interval(mins => c.dur), '[)'))
  order by c.s, c.doc
  limit greatest(p_limit, 1);
$$;

-- =====================================================================
-- Session + identity
-- =====================================================================

create or replace function clinic_open_session(p_session uuid, p_tenant_slug text, p_channel text default 'console_voice',
                                               p_locale text default 'ar-EG', p_branch_slug text default null)
returns jsonb language plpgsql as $$
declare v_tenant uuid; v_branch uuid; s call_sessions;
begin
  select id into v_tenant from tenants where slug = p_tenant_slug;
  if v_tenant is null then return clinic_err('NOT_FOUND', 'Unknown clinic'); end if;
  if p_branch_slug is not null then   -- optional: pin the session to one branch (single-branch deployments)
    select id into v_branch from branches where tenant_id = v_tenant and slug = p_branch_slug;
    if v_branch is null then return clinic_err('NOT_FOUND', 'Unknown branch'); end if;
  end if;
  insert into call_sessions (id, tenant_id, branch_id, channel, locale)
  values (p_session, v_tenant, v_branch, p_channel, p_locale)
  on conflict (id) do update set last_seen_at = now()
  returning * into s;
  if s.tenant_id <> v_tenant then return clinic_err('FORBIDDEN', 'Session belongs to a different clinic'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'session_id', s.id, 'identified', s.patient_id is not null, 'branch_selected', s.branch_id is not null));
end $$;

-- The caller chooses a branch. Switching branch releases this session's holds and denies its pending approvals.
create or replace function clinic_select_branch(p_session uuid, p_branch_slug text)
returns jsonb language plpgsql as $$
declare s call_sessions; br branches;
begin
  select * into s from call_sessions where id = p_session;
  if not found then return clinic_err('NOT_FOUND', 'Unknown session'); end if;
  select * into br from branches where tenant_id = s.tenant_id and slug = p_branch_slug;
  if not found then return clinic_err('NOT_FOUND', 'Unknown branch', '{"field":"branch_ref"}'); end if;
  if s.branch_id is distinct from br.id then
    update appointments set status = 'expired', hold_expires_at = null, updated_at = now() where status = 'held' and session_id = p_session;
    update approvals set status = 'denied', decided_at = now(), decided_by = 'system:branch_switch' where session_id = p_session and status in ('pending','approved') ;
    update call_sessions set branch_id = br.id, last_seen_at = now() where id = p_session;
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'branch_ref', br.slug, 'name', br.name, 'name_ar', br.name_ar, 'address', br.address, 'address_ar', br.address_ar, 'phone', br.phone,
    'doctors', (select coalesce(jsonb_agg(jsonb_build_object('doctor_ref', d.slug, 'name_en', d.full_name_en, 'name_ar', d.full_name_ar,
                'specialty_en', sp.name_en, 'specialty_ar', sp.name_ar) order by d.full_name_en), '[]')
                from doctors d left join specialties sp on sp.id = d.specialty_id
                where d.tenant_id = s.tenant_id and d.active
                  and exists (select 1 from doctor_schedules ds where ds.doctor_id = d.id and ds.branch_id = br.id))));
end $$;

-- Internal: a null code resolves to the clinic's only visit type (if there is exactly one).
create or replace function clinic__resolve_visit_type(p_tenant uuid, p_code text)
returns visit_types language plpgsql stable as $$
declare v visit_types;
begin
  if p_code is null then
    if (select count(*) from visit_types where tenant_id = p_tenant) = 1 then
      select * into v from visit_types where tenant_id = p_tenant;
    end if;
  else
    select * into v from visit_types where tenant_id = p_tenant and code = p_code;
  end if;
  return v;
end $$;

create or replace function clinic_identify_patient(p_session uuid, p_full_name text, p_phone_e164 text)
returns jsonb language plpgsql as $$
declare s call_sessions; pt patients; v_new boolean := false; v_name text := regexp_replace(trim(p_full_name), '\s+', ' ', 'g');
begin
  select * into s from call_sessions where id = p_session;
  if not found then return clinic_err('NOT_FOUND', 'Unknown session'); end if;
  if v_name is null or length(v_name) < 2 then return clinic_err('VALIDATION_ERROR', 'Full name is required', '{"field":"full_name"}'); end if;
  if p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then
    return clinic_err('VALIDATION_ERROR', 'Phone must be E.164, e.g. +201001234567', '{"field":"phone"}');
  end if;
  select * into pt from patients where tenant_id = s.tenant_id and phone_e164 = p_phone_e164 and lower(full_name) = lower(v_name);
  if not found then
    insert into patients (tenant_id, full_name, phone_e164, preferred_language)
    values (s.tenant_id, v_name, p_phone_e164, case when s.locale like 'ar%' then 'ar' else 'en' end)
    returning * into pt;
    v_new := true;
  end if;
  update call_sessions set patient_id = pt.id, last_seen_at = now() where id = p_session;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'display_name', pt.full_name, 'is_new_patient', v_new,
    'upcoming_count', (select count(*) from appointments a where a.patient_id = pt.id and a.status = 'booked' and a.starts_at > now())));
end $$;

-- =====================================================================
-- Availability (read) — returns slots, patient conflicts, and alternatives
-- =====================================================================
create or replace function clinic_check_availability(
  p_session uuid, p_doctor_slug text, p_visit_type_code text,
  p_from timestamptz, p_to timestamptz, p_part_of_day text default null, p_limit int default 5)
returns jsonb language plpgsql stable as $$
declare s call_sessions; br branches; v_doc uuid; v_vt visit_types; v_slots jsonb; v_conf jsonb; v_same_later jsonb := '[]'; v_other jsonb := '[]';
begin
  select * into s from call_sessions where id = p_session;
  if not found then return clinic_err('NOT_FOUND', 'Unknown session'); end if;
  if s.branch_id is null then return clinic_err('BRANCH_REQUIRED', 'Ask the caller which branch, then call select_branch'); end if;
  select * into br from branches where id = s.branch_id;
  v_vt := clinic__resolve_visit_type(s.tenant_id, p_visit_type_code);
  if v_vt.id is null then return clinic_err('VALIDATION_ERROR', 'Unknown visit type', jsonb_build_object('field','visit_type_code')); end if;
  if p_doctor_slug is not null then
    select id into v_doc from doctors where tenant_id = s.tenant_id and slug = p_doctor_slug and active;
    if v_doc is null then return clinic_err('NOT_FOUND', 'Unknown doctor', jsonb_build_object('field','doctor_ref')); end if;
  end if;
  if p_to <= p_from or p_to > p_from + interval '31 days' then
    return clinic_err('VALIDATION_ERROR', 'Window must be positive and at most 31 days', '{"field":"window"}');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'doctor_ref', d.slug, 'doctor_name_en', d.full_name_en, 'doctor_name_ar', d.full_name_ar,
      'starts_at', clinic_iso(x.starts_at),
      'local', clinic_fmt_local(x.starts_at, br.timezone)) order by x.starts_at), '[]')
    into v_slots
  from clinic_search_slots(s.branch_id, v_doc, v_vt.id, p_from, p_to, p_part_of_day, p_limit) x
  join doctors d on d.id = x.doctor_id;

  if s.patient_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('appointment_ref', a.confirmation_code, 'status', a.status,
             'doctor_name_en', d.full_name_en, 'local', clinic_fmt_local(a.starts_at, br.timezone))), '[]')
      into v_conf
    from appointments a join doctors d on d.id = a.doctor_id
    where a.patient_id = s.patient_id and (a.status = 'booked' or (a.status = 'held' and a.hold_expires_at > now()))
      and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_from, p_to, '[)');
  else v_conf := '[]'; end if;

  if jsonb_array_length(v_slots) = 0 then
    -- nothing in the window: next available slots after it (same branch), and the same window at the OTHER branch(es)
    select coalesce(jsonb_agg(jsonb_build_object('doctor_ref', d.slug, 'doctor_name_en', d.full_name_en, 'doctor_name_ar', d.full_name_ar,
             'starts_at', clinic_iso(x.starts_at), 'local', clinic_fmt_local(x.starts_at, br.timezone)) order by x.starts_at), '[]')
      into v_same_later
    from clinic_search_slots(s.branch_id, v_doc, v_vt.id, p_to, now() + make_interval(days => br.max_advance_days), null, 3) x
    join doctors d on d.id = x.doctor_id;

    select coalesce(jsonb_agg(jsonb_build_object('branch_ref', b.slug, 'branch_name', b.name, 'branch_name_ar', b.name_ar,
             'doctor_ref', d.slug, 'doctor_name_en', d.full_name_en, 'doctor_name_ar', d.full_name_ar,
             'starts_at', clinic_iso(x.starts_at), 'local', clinic_fmt_local(x.starts_at, b.timezone)) order by x.starts_at), '[]')
      into v_other
    from branches b
    cross join lateral clinic_search_slots(b.id, null, v_vt.id, p_from, p_to, p_part_of_day, 3) x
    join doctors d on d.id = x.doctor_id
    where b.tenant_id = s.tenant_id and b.id <> s.branch_id;
  end if;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'slots', v_slots, 'patient_conflicts', v_conf,
    'alternatives', jsonb_build_object('later_slots', v_same_later, 'other_branches_same_window', v_other),
    'visit_minutes', v_vt.duration_minutes, 'timezone', br.timezone));
end $$;

-- =====================================================================
-- Hold (auto, reversible, short TTL) — blocks the slot while the caller decides
-- =====================================================================
create or replace function clinic_hold_slot(p_session uuid, p_doctor_slug text, p_visit_type_code text, p_starts_at timestamptz)
returns jsonb language plpgsql as $$
declare s call_sessions; br branches; v_doc doctors; v_vt visit_types; v_id uuid; v_code text; v_exp timestamptz; v_con text; v_conf jsonb;
begin
  select * into s from call_sessions where id = p_session;
  if not found then return clinic_err('NOT_FOUND', 'Unknown session'); end if;
  if s.patient_id is null then return clinic_err('NOT_VERIFIED', 'Identify the patient (name + phone) before holding a slot'); end if;
  if s.branch_id is null then return clinic_err('BRANCH_REQUIRED', 'Ask the caller which branch, then call select_branch'); end if;
  select * into br from branches where id = s.branch_id;
  v_vt := clinic__resolve_visit_type(s.tenant_id, p_visit_type_code);
  if v_vt.id is null then return clinic_err('VALIDATION_ERROR', 'Unknown visit type', '{"field":"visit_type_code"}'); end if;
  select * into v_doc from doctors where tenant_id = s.tenant_id and slug = p_doctor_slug and active;
  if not found then return clinic_err('NOT_FOUND', 'Unknown doctor', '{"field":"doctor_ref"}'); end if;
  begin
    -- release expired holds that could block, and this session's previous hold (one active hold per session)
    update appointments set status = 'expired', hold_expires_at = null, updated_at = now()
     where status = 'held' and (hold_expires_at <= now() or session_id = p_session);
    if not exists (select 1 from clinic_search_slots(s.branch_id, v_doc.id, v_vt.id, p_starts_at, p_starts_at + interval '1 minute', null, 1) x
                   where x.starts_at = p_starts_at) then
      raise exception 'SLOT_UNAVAILABLE';
    end if;
    v_exp := now() + make_interval(secs => br.hold_ttl_seconds);
    insert into appointments (tenant_id, branch_id, doctor_id, patient_id, visit_type_id, starts_at, ends_at, status, hold_expires_at, session_id, source)
    values (s.tenant_id, s.branch_id, v_doc.id, s.patient_id, v_vt.id, p_starts_at, p_starts_at + make_interval(mins => v_vt.duration_minutes), 'held', v_exp, p_session, s.channel)
    returning id, confirmation_code into v_id, v_code;
  exception
    when exclusion_violation then
      get stacked diagnostics v_con = constraint_name;
      if v_con = 'appt_no_patient_overlap' then
        select coalesce(jsonb_agg(jsonb_build_object('appointment_ref', a.confirmation_code, 'local', clinic_fmt_local(a.starts_at, br.timezone))), '[]') into v_conf
          from appointments a where a.patient_id = s.patient_id and a.status in ('held','booked')
           and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(p_starts_at, p_starts_at + make_interval(mins => v_vt.duration_minutes), '[)');
        return clinic_err('PATIENT_CONFLICT', 'The patient already has an appointment at that time', jsonb_build_object('conflicts', v_conf));
      end if;
      return clinic_err('SLOT_UNAVAILABLE', 'That slot was just taken', '{}', true);
    when raise_exception then
      return clinic_err(sqlerrm, 'That slot is not available', '{}', true);
  end;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'hold_ref', v_code, 'hold_expires_at', clinic_iso(v_exp), 'hold_seconds', br.hold_ttl_seconds,
    'doctor_name_en', v_doc.full_name_en, 'doctor_name_ar', v_doc.full_name_ar, 'local', clinic_fmt_local(p_starts_at, br.timezone)));
end $$;

-- =====================================================================
-- Approvals
-- =====================================================================
-- Creates (or returns the existing) pending approval for a booking-changing action.
create or replace function clinic_create_approval(p_session uuid, p_action text, p_appointment_ref text, p_new_starts_at timestamptz default null, p_reason text default null)
returns jsonb language plpgsql as $$
declare s call_sessions; br branches; ap appointments; pt patients; d doctors; vt visit_types; ex approvals; a approvals;
        v_params jsonb; v_title text; v_summary text; v_risk text; v_status text := 'pending'; v_by text;
begin
  select * into s from call_sessions where id = p_session;
  if not found then return clinic_err('NOT_FOUND', 'Unknown session'); end if;
  if s.patient_id is null then return clinic_err('NOT_VERIFIED', 'Identify the patient first'); end if;
  if p_action not in ('confirm_booking','reschedule_appointment','cancel_appointment') then
    return clinic_err('VALIDATION_ERROR', 'Unsupported action', '{"field":"action"}');
  end if;
  select * into ap from appointments where confirmation_code = upper(trim(p_appointment_ref)) and patient_id = s.patient_id and tenant_id = s.tenant_id;
  if not found then return clinic_err('NOT_FOUND', 'No such appointment for this patient', '{"field":"appointment_ref"}'); end if;
  select * into br from branches where id = ap.branch_id;
  select * into pt from patients where id = ap.patient_id;
  select * into d  from doctors  where id = ap.doctor_id;
  select * into vt from visit_types where id = ap.visit_type_id;

  if p_action = 'confirm_booking' then
    if ap.status <> 'held' then return clinic_err('INVALID_STATE', 'Only a held slot can be confirmed', jsonb_build_object('status', ap.status)); end if;
    if ap.hold_expires_at <= now() then return clinic_err('HOLD_EXPIRED', 'The hold expired; search again', '{}', true); end if;
    v_title := 'Confirm appointment'; v_risk := 'low';
    v_summary := format('Book %s with %s (%s) on %s at %s.', pt.full_name, d.full_name_en, vt.name_en, clinic_fmt_local(ap.starts_at, br.timezone)->>'spoken_en', br.name);
    v_params := jsonb_build_object('appointment_id', ap.id, 'appointment_ref', ap.confirmation_code);
  else
    if ap.status <> 'booked' then return clinic_err('INVALID_STATE', 'Only a booked appointment can be changed', jsonb_build_object('status', ap.status)); end if;
    if ap.starts_at - now() < make_interval(hours => br.cancel_cutoff_hours) then
      return clinic_err('OUTSIDE_POLICY', 'Too close to the appointment time to change it automatically',
        jsonb_build_object('cutoff_hours', br.cancel_cutoff_hours, 'next_step', 'escalate_handoff'));
    end if;
    if p_action = 'cancel_appointment' then
      v_title := 'Cancel appointment'; v_risk := 'medium';
      v_summary := format('Cancel %s''s appointment with %s on %s at %s.', pt.full_name, d.full_name_en, clinic_fmt_local(ap.starts_at, br.timezone)->>'spoken_en', br.name);
      v_params := jsonb_build_object('appointment_id', ap.id, 'appointment_ref', ap.confirmation_code, 'reason', left(coalesce(p_reason,'patient_request'), 200));
    else
      if p_new_starts_at is null then return clinic_err('VALIDATION_ERROR', 'new_starts_at is required', '{"field":"new_starts_at"}'); end if;
      if not exists (select 1 from clinic_search_slots(ap.branch_id, ap.doctor_id, ap.visit_type_id, p_new_starts_at, p_new_starts_at + interval '1 minute', null, 1, ap.id) x
                     where x.starts_at = p_new_starts_at) then
        return clinic_err('SLOT_UNAVAILABLE', 'The new slot is not available', '{}', true);
      end if;
      v_title := 'Reschedule appointment'; v_risk := 'medium';
      v_summary := format('Move %s''s appointment with %s from %s to %s at %s.', pt.full_name, d.full_name_en,
                          clinic_fmt_local(ap.starts_at, br.timezone)->>'spoken_en', clinic_fmt_local(p_new_starts_at, br.timezone)->>'spoken_en', br.name);
      v_params := jsonb_build_object('appointment_id', ap.id, 'appointment_ref', ap.confirmation_code, 'new_starts_at', clinic_iso(p_new_starts_at));
    end if;
  end if;

  -- idempotent: reuse a live approval for the same exact params
  select * into ex from approvals where session_id = p_session and action = p_action and params = v_params
     and status in ('pending','approved') and expires_at > now() order by requested_at desc limit 1;
  if found then a := ex;
  else
    if p_action = 'confirm_booking' and not br.require_booking_approval then v_status := 'approved'; v_by := 'policy:auto'; end if;
    insert into approvals (tenant_id, session_id, action, params, title, summary, risk, status, decided_at, decided_by)
    values (s.tenant_id, p_session, p_action, v_params, v_title, v_summary, v_risk, v_status,
            case when v_status = 'approved' then now() end, v_by)
    returning * into a;
  end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'approval_id', a.id, 'status', a.status, 'tool', 'clinic.' || a.action, 'title', a.title, 'summary', a.summary, 'risk', a.risk,
    'requires_human_approval', a.status = 'pending', 'expires_at', clinic_iso(a.expires_at)));
end $$;

-- Called ONLY by the trusted bridge when the operator presses Approve/Deny in the console.
create or replace function clinic_decide_approval(p_approval_id text, p_session uuid, p_decision text, p_operator text)
returns jsonb language plpgsql as $$
declare a approvals;
begin
  if p_decision not in ('approved','denied') then return clinic_err('VALIDATION_ERROR', 'decision must be approved|denied'); end if;
  select * into a from approvals where id = p_approval_id and session_id = p_session for update;
  if not found then return clinic_err('NOT_FOUND', 'No such approval in this session'); end if;
  if a.status = p_decision then return jsonb_build_object('ok', true, 'data', jsonb_build_object('approval_id', a.id, 'status', a.status, 'already_decided', true)); end if;
  if a.status <> 'pending' then return clinic_err('INVALID_STATE', 'Approval already ' || a.status, jsonb_build_object('status', a.status)); end if;
  if a.expires_at <= now() then return clinic_err('APPROVAL_EXPIRED', 'Approval expired; ask again'); end if;
  update approvals set status = p_decision, decided_at = now(), decided_by = left(p_operator, 120) where id = a.id;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('approval_id', a.id, 'status', p_decision, 'already_decided', false));
end $$;

-- Internal: lock + validate an approval for execution; raises a coded exception.
create or replace function clinic__take_approval(p_session uuid, p_id text, p_action text)
returns approvals language plpgsql as $$
declare a approvals;
begin
  select * into a from approvals where id = p_id and session_id = p_session for update;
  if not found then raise exception 'APPROVAL_NOT_FOUND'; end if;
  if a.action <> p_action then raise exception 'APPROVAL_MISMATCH'; end if;
  if a.status = 'consumed' then raise exception 'APPROVAL_ALREADY_USED'; end if;
  if a.status = 'denied'   then raise exception 'APPROVAL_DENIED'; end if;
  if a.status = 'pending'  then raise exception 'APPROVAL_PENDING'; end if;
  if a.expires_at <= now() then raise exception 'APPROVAL_EXPIRED'; end if;
  return a;
end $$;

-- =====================================================================
-- Execute (approval-gated, atomic)
-- =====================================================================
create or replace function clinic_confirm_booking(p_session uuid, p_approval_id text)
returns jsonb language plpgsql as $$
declare a approvals; ap appointments; br branches; d doctors;
begin
  begin
    a := clinic__take_approval(p_session, p_approval_id, 'confirm_booking');
    select * into ap from appointments where id = (a.params->>'appointment_id')::uuid for update;
    if ap.status <> 'held' then raise exception 'INVALID_STATE'; end if;
    if ap.hold_expires_at <= now() then raise exception 'HOLD_EXPIRED'; end if;
    update appointments set status = 'booked', hold_expires_at = null, approval_id = a.id, updated_at = now() where id = ap.id;
    update approvals set status = 'consumed', consumed_at = now() where id = a.id;
  exception when raise_exception then
    return clinic_err(sqlerrm, 'Booking could not be confirmed', '{}', sqlerrm in ('HOLD_EXPIRED'));
  end;
  select * into br from branches where id = ap.branch_id; select * into d from doctors where id = ap.doctor_id;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'appointment_ref', ap.confirmation_code, 'status', 'booked', 'doctor_name_en', d.full_name_en, 'doctor_name_ar', d.full_name_ar,
    'local', clinic_fmt_local(ap.starts_at, br.timezone), 'branch_name', br.name, 'branch_address', br.address, 'branch_phone', br.phone));
end $$;

create or replace function clinic_cancel_appointment(p_session uuid, p_approval_id text)
returns jsonb language plpgsql as $$
declare a approvals; ap appointments; br branches;
begin
  begin
    a := clinic__take_approval(p_session, p_approval_id, 'cancel_appointment');
    select * into ap from appointments where id = (a.params->>'appointment_id')::uuid for update;
    if ap.status <> 'booked' then raise exception 'INVALID_STATE'; end if;
    update appointments set status = 'cancelled', cancel_reason = a.params->>'reason', approval_id = a.id, updated_at = now() where id = ap.id;
    update approvals set status = 'consumed', consumed_at = now() where id = a.id;
  exception when raise_exception then
    return clinic_err(sqlerrm, 'Cancellation could not be completed');
  end;
  select * into br from branches where id = ap.branch_id;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('appointment_ref', ap.confirmation_code, 'status', 'cancelled', 'local', clinic_fmt_local(ap.starts_at, br.timezone)));
end $$;

-- Atomic: release old slot + book new slot, or neither.
create or replace function clinic_reschedule_appointment(p_session uuid, p_approval_id text)
returns jsonb language plpgsql as $$
declare a approvals; old_ap appointments; new_ap appointments; br branches; d doctors; v_new timestamptz; v_dur int;
begin
  begin
    a := clinic__take_approval(p_session, p_approval_id, 'reschedule_appointment');
    v_new := (a.params->>'new_starts_at')::timestamptz;
    select * into old_ap from appointments where id = (a.params->>'appointment_id')::uuid for update;
    if old_ap.status <> 'booked' then raise exception 'INVALID_STATE'; end if;
    select duration_minutes into v_dur from visit_types where id = old_ap.visit_type_id;
    update appointments set status = 'cancelled', cancel_reason = 'rescheduled', updated_at = now() where id = old_ap.id;
    if not exists (select 1 from clinic_search_slots(old_ap.branch_id, old_ap.doctor_id, old_ap.visit_type_id, v_new, v_new + interval '1 minute', null, 1) x
                   where x.starts_at = v_new) then
      raise exception 'SLOT_UNAVAILABLE';
    end if;
    insert into appointments (tenant_id, branch_id, doctor_id, patient_id, visit_type_id, starts_at, ends_at, status, source, session_id, approval_id, rescheduled_from)
    values (old_ap.tenant_id, old_ap.branch_id, old_ap.doctor_id, old_ap.patient_id, old_ap.visit_type_id, v_new, v_new + make_interval(mins => v_dur), 'booked', old_ap.source, p_session, a.id, old_ap.id)
    returning * into new_ap;
    update approvals set status = 'consumed', consumed_at = now() where id = a.id;
  exception
    when exclusion_violation then return clinic_err('SLOT_UNAVAILABLE', 'The new slot was just taken; nothing was changed', '{}', true);
    when raise_exception then return clinic_err(sqlerrm, 'Reschedule could not be completed; nothing was changed', '{}', sqlerrm = 'SLOT_UNAVAILABLE');
  end;
  select * into br from branches where id = new_ap.branch_id; select * into d from doctors where id = new_ap.doctor_id;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'old_appointment_ref', old_ap.confirmation_code, 'appointment_ref', new_ap.confirmation_code, 'status', 'booked',
    'doctor_name_en', d.full_name_en, 'doctor_name_ar', d.full_name_ar, 'local', clinic_fmt_local(new_ap.starts_at, br.timezone)));
end $$;

-- =====================================================================
-- Reads, notes, escalation
-- =====================================================================
create or replace function clinic_list_my_appointments(p_session uuid)
returns jsonb language plpgsql stable as $$
declare s call_sessions; br branches;
begin
  select * into s from call_sessions where id = p_session;
  if not found then return clinic_err('NOT_FOUND', 'Unknown session'); end if;
  if s.patient_id is null then return clinic_err('NOT_VERIFIED', 'Identify the patient first'); end if;
  select * into br from branches where id = s.branch_id;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('appointments', coalesce((
    select jsonb_agg(jsonb_build_object('appointment_ref', a.confirmation_code, 'status', a.status, 'doctor_name_en', d.full_name_en,
             'doctor_name_ar', d.full_name_ar, 'visit_type', v.name_en, 'branch_ref', b.slug, 'branch_name', b.name, 'branch_name_ar', b.name_ar, 'local', clinic_fmt_local(a.starts_at, b.timezone)) order by a.starts_at)
    from appointments a join doctors d on d.id = a.doctor_id join visit_types v on v.id = a.visit_type_id join branches b on b.id = a.branch_id
    where a.patient_id = s.patient_id and a.starts_at > now() and (a.status = 'booked' or (a.status = 'held' and a.hold_expires_at > now()))), '[]')));
end $$;

create or replace function clinic_add_note(p_session uuid, p_kind text, p_body text, p_appointment_ref text default null)
returns jsonb language plpgsql as $$
declare s call_sessions; v_appt uuid;
begin
  select * into s from call_sessions where id = p_session;
  if not found then return clinic_err('NOT_FOUND', 'Unknown session'); end if;
  if p_kind not in ('note','summary') or length(coalesce(p_body,'')) not between 1 and 2000 then
    return clinic_err('VALIDATION_ERROR', 'kind must be note|summary and body 1..2000 chars');
  end if;
  if p_appointment_ref is not null then
    select id into v_appt from appointments where confirmation_code = upper(trim(p_appointment_ref)) and patient_id = s.patient_id;
  end if;
  insert into call_notes (session_id, appointment_id, kind, body) values (p_session, v_appt, p_kind, p_body);
  if p_kind = 'summary' then update call_sessions set summary = p_body where id = p_session; end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('stored', true));
end $$;

-- Records the escalation and decides the route. DELIVERY (SIP/email/SMS) is done by the
-- service afterwards and reported via clinic_escalation_update — never assumed.
create or replace function clinic_escalate(p_session uuid, p_severity text, p_reason text, p_summary text)
returns jsonb language plpgsql as $$
declare s call_sessions; br branches; v_in boolean; v_route text; v_id uuid; v_local timestamp;
begin
  select * into s from call_sessions where id = p_session;
  if not found then return clinic_err('NOT_FOUND', 'Unknown session'); end if;
  if p_severity not in ('emergency','urgent','handoff') then return clinic_err('VALIDATION_ERROR', 'severity must be emergency|urgent|handoff'); end if;
  select * into br from branches where id = coalesce(s.branch_id, (select b.id from branches b where b.tenant_id = s.tenant_id order by b.slug limit 1));
  if not found then return clinic_err('NOT_FOUND', 'No branch configured'); end if;
  if s.branch_id is null then p_reason := p_reason || ' [caller had not chosen a branch]'; end if;
  v_local := now() at time zone br.timezone;
  v_in := exists (select 1 from branch_hours h where h.branch_id = br.id and h.weekday = extract(dow from v_local)::int
                  and v_local::time >= h.opens and v_local::time < h.closes);
  v_route := case when v_in then 'live_transfer' else 'notify_contact' end;
  insert into escalations (tenant_id, branch_id, session_id, severity, reason, summary, within_hours, route)
  values (s.tenant_id, br.id, p_session, p_severity, left(p_reason, 500), left(p_summary, 2000), v_in, v_route) returning id into v_id;
  update call_sessions set outcome = 'escalated' where id = p_session;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'escalation_id', v_id, 'route', v_route, 'within_hours', v_in,
    -- the service uses `contact` to deliver and MUST strip it before returning anything to the model
    'contact', jsonb_build_object('name', br.emergency_contact_name, 'phone', br.emergency_phone, 'email', br.emergency_email),
    'public', jsonb_build_object('emergency_services_number', br.emergency_services_number, 'clinic_phone', br.phone)));
end $$;

create or replace function clinic_escalation_update(p_id uuid, p_status text, p_channel text, p_error text default null)
returns jsonb language plpgsql as $$
begin
  if p_status not in ('connected','notified','delivery_failed') then return clinic_err('VALIDATION_ERROR', 'bad status'); end if;
  update escalations set status = p_status, channel = p_channel, error = left(p_error, 500), updated_at = now() where id = p_id;
  if not found then return clinic_err('NOT_FOUND', 'Unknown escalation'); end if;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object('status', p_status));
end $$;


create or replace function clinic_get_info(p_session uuid)
returns jsonb language plpgsql stable as $$
declare s call_sessions; t tenants; sel branches; first_br branches;
begin
  select * into s from call_sessions where id = p_session;
  if not found then return clinic_err('NOT_FOUND', 'Unknown session'); end if;
  select * into t from tenants where id = s.tenant_id;
  select * into sel from branches where id = s.branch_id;
  select * into first_br from branches where tenant_id = s.tenant_id order by slug limit 1;
  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'clinic_name', t.name, 'clinic_name_ar', t.name_ar,
    'selected_branch_ref', sel.slug,
    'branches', (select coalesce(jsonb_agg(jsonb_build_object(
        'branch_ref', b.slug, 'name', b.name, 'name_ar', b.name_ar, 'address', b.address, 'address_ar', b.address_ar,
        'phone', b.phone, 'timezone', b.timezone,
        'hours', (select coalesce(jsonb_agg(jsonb_build_object(
                    'weekday_en', (array['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'])[h.weekday + 1],
                    'weekday_ar', (array['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'])[h.weekday + 1],
                    'opens', to_char(h.opens, 'HH24:MI'), 'closes', to_char(h.closes, 'HH24:MI')) order by h.weekday, h.opens), '[]')
                  from branch_hours h where h.branch_id = b.id),
        'doctors', (select coalesce(jsonb_agg(jsonb_build_object(
                      'doctor_ref', d.slug, 'name_en', d.full_name_en, 'name_ar', d.full_name_ar,
                      'specialty_en', sp.name_en, 'specialty_ar', sp.name_ar) order by d.full_name_en), '[]')
                    from doctors d left join specialties sp on sp.id = d.specialty_id
                    where d.tenant_id = s.tenant_id and d.active
                      and exists (select 1 from doctor_schedules ds where ds.doctor_id = d.id and ds.branch_id = b.id))
      ) order by b.slug), '[]') from branches b where b.tenant_id = s.tenant_id),
    'visit_types', (select coalesce(jsonb_agg(jsonb_build_object('code', v.code, 'name_en', v.name_en, 'name_ar', v.name_ar, 'minutes', v.duration_minutes)), '[]')
                    from visit_types v where v.tenant_id = s.tenant_id),
    'policies', jsonb_build_object(
        'cancel_cutoff_hours', coalesce(sel.cancel_cutoff_hours, first_br.cancel_cutoff_hours),
        'min_notice_minutes',  coalesce(sel.min_notice_minutes,  first_br.min_notice_minutes),
        'max_advance_days',    coalesce(sel.max_advance_days,    first_br.max_advance_days)),
    'emergency_services_number', coalesce(sel.emergency_services_number, first_br.emergency_services_number),
    'now_local', clinic_fmt_local(now(), coalesce(sel.timezone, first_br.timezone))));
    -- NOTE: no prices here on purpose. If a price is not in this payload the agent must say it does not know.
end $$;

-- =====================================================================
-- Security: deny-by-default, service role only
-- =====================================================================
do $$
declare t text; f record;
begin
  foreach t in array array['tenants','branches','branch_hours','specialties','visit_types','doctors','doctor_visit_types','doctor_schedules',
                           'doctor_time_off','patients','call_sessions','appointments','approvals','call_notes','escalations','audit_events'] loop
    execute format('alter table %I enable row level security', t);
    if exists (select 1 from pg_roles where rolname = 'anon')          then execute format('revoke all on %I from anon', t); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke all on %I from authenticated', t); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role')  then execute format('grant all on %I to service_role', t); end if;
  end loop;
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'clinic\_%' loop
    execute format('revoke execute on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'anon')          then execute format('revoke execute on function %s from anon', f.sig); end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then execute format('revoke execute on function %s from authenticated', f.sig); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role')  then execute format('grant execute on function %s to service_role', f.sig); end if;
  end loop;
  -- audit is append-only
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'revoke update, delete on audit_events from service_role'; end if;
end $$;
