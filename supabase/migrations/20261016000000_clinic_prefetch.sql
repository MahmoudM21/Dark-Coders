-- =====================================================================
-- Availability prefetch (voice latency)
-- =====================================================================
-- One read-only round trip that answers "what's available?" for every branch
-- before the agent has picked one, so the very first availability turn does not
-- cost a tool call.
--
-- Why it exists: on the voice path a tool call is two extra model round trips
-- (tool_use, tool_result). The bridge calls this next to clinic_open_session on
-- the first turn of a session and injects the result as data-only context, so
-- "إيه المواعيد المتاحة؟" can be answered without check_availability.
--
-- It is ADVISORY ONLY. Nothing here reserves anything: the caller still has to
-- select_branch and hold_slot, and hold_slot remains the authority on whether a
-- slot is free. A snapshot that is more than 60 seconds old must be ignored and
-- check_availability called instead (the bridge enforces that; the
-- valid_for_seconds field below is what it compares against).
--
-- This migration is idempotent (create or replace) and is applied after
-- 20261015120000_clinic_reception.sql. It writes nothing.
--
-- Security note: the grant/revoke loop at the end of the original migration only
-- covered the functions that existed when it ran, so every new clinic_* function
-- has to repeat the revoke/grant explicitly.

create or replace function clinic_prefetch_availability(
  p_session uuid,
  p_days int default 2,
  p_limit int default 5)
returns jsonb language plpgsql stable as $$
declare
  s call_sessions;
  v_vt visit_types;
  v_days int;
  v_limit int;
  v_tz text;
  v_branches jsonb;
begin
  select * into s from call_sessions where id = p_session;
  if not found then return clinic_err('NOT_FOUND', 'Unknown session'); end if;

  -- The clinic has exactly one visit type in this demo; a null code resolves to
  -- it. If a tenant ever has several, prefetch refuses instead of guessing which
  -- one the caller meant.
  v_vt := clinic__resolve_visit_type(s.tenant_id, null);
  if v_vt.id is null then
    return clinic_err('VALIDATION_ERROR', 'This clinic has more than one visit type; call check_availability with an explicit visit_type_code');
  end if;

  v_days  := least(greatest(coalesce(p_days, 2), 1), 31);
  v_limit := least(greatest(coalesce(p_limit, 5), 1), 5);

  -- Formatted in the timezone of the branch the caller will hear about: the
  -- selected one when there is one, otherwise the first branch (same rule
  -- clinic_get_info uses for `now_local`).
  select coalesce((select timezone from branches where id = s.branch_id),
                  (select timezone from branches where tenant_id = s.tenant_id order by slug limit 1))
    into v_tz;

  -- For each branch of this tenant: the next v_limit free slots, from now, on the
  -- per-doctor grid that clinic_search_slots already computes (schedule − time off
  -- − live appointments). No branch needs to be selected.
  select coalesce(jsonb_agg(jsonb_build_object(
      'branch_ref',     b.slug,
      'branch_name',    b.name,
      'branch_name_ar', b.name_ar,
      'timezone',       b.timezone,
      'slots',          coalesce(x.slots, '[]'::jsonb)
    ) order by b.slug), '[]'::jsonb)
    into v_branches
  from branches b
  left join lateral (
    select jsonb_agg(jsonb_build_object(
             'doctor_ref',     d.slug,
             'doctor_name_en', d.full_name_en,
             'doctor_name_ar', d.full_name_ar,
             'starts_at',      clinic_iso(sl.starts_at),
             'local',          clinic_fmt_local(sl.starts_at, b.timezone)
           ) order by sl.starts_at, d.slug) as slots
    from clinic_search_slots(b.id, null, v_vt.id, now(), now() + make_interval(days => v_days), null, v_limit) sl
    join doctors d on d.id = sl.doctor_id
  ) x on true
  where b.tenant_id = s.tenant_id;

  return jsonb_build_object('ok', true, 'data', jsonb_build_object(
    'selected_branch_ref', (select slug from branches where id = s.branch_id),
    'visit_type',          v_vt.code,
    'visit_minutes',       v_vt.duration_minutes,
    'window_days',         v_days,
    'limit',               v_limit,
    'branches',            v_branches,
    -- clinic_iso is always a UTC instant with a Z suffix, so the bridge can age
    -- the snapshot with a plain Date.parse.
    'generated_at',        clinic_iso(now()),
    'generated_local',     clinic_fmt_local(now(), v_tz),
    'valid_for_seconds',   60));
end $$;

-- Same security posture as every other clinic_* function: service role only.
do $$
begin
  revoke execute on function clinic_prefetch_availability(uuid, int, int) from public;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function clinic_prefetch_availability(uuid, int, int) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke execute on function clinic_prefetch_availability(uuid, int, int) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function clinic_prefetch_availability(uuid, int, int) to service_role';
  end if;
end $$;
