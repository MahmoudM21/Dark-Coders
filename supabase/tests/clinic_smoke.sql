-- Regression suite for the clinic_* functions (assertion style: a failed check raises and psql exits non-zero).
-- Run from the repo root on a SCRATCH database that already has the migration applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -P pager=off -f supabase/tests/clinic_smoke.sql
-- WARNING: it seeds demo data and mutates it (branch_hours, branch policies). Never run against production.
\set ON_ERROR_STOP on
\i supabase/seed_clinic_demo.sql
create or replace function pg_temp.assert(p_name text, p_ok boolean) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'ASSERTION FAILED: %', p_name; end if;
  raise notice 'PASS  %', p_name;
end $$;

select id as mok from branches where slug = 'mokattam' \gset
select id as mad from branches where slug = 'maadi' \gset
select id as vt  from visit_types where code = 'dental_visit' \gset
select (select (now() at time zone 'Africa/Cairo')::date + g from generate_series(2,9) g
         where extract(dow from (now() at time zone 'Africa/Cairo')::date + g) = 6 limit 1) as sat \gset
select (select (now() at time zone 'Africa/Cairo')::date + g from generate_series(2,9) g
         where extract(dow from (now() at time zone 'Africa/Cairo')::date + g) = 5 limit 1) as fri \gset
select ((:'sat'::date)::timestamp at time zone 'Africa/Cairo') as sat_from, ((:'sat'::date + 1)::timestamp at time zone 'Africa/Cairo') as sat_to \gset
select ((:'fri'::date)::timestamp at time zone 'Africa/Cairo') as fri_from, ((:'fri'::date + 1)::timestamp at time zone 'Africa/Cairo') as fri_to \gset

\echo '== A. Setup: 14 appointments/day per doctor, break 21-22, Friday off, one doctor per branch'
select pg_temp.assert('Mokattam has exactly 14 slots on a Saturday',
  (select count(*) from clinic_search_slots(:'mok', null, :'vt', :'sat_from', :'sat_to', null, 100)) = 14);
select pg_temp.assert('Maadi has exactly 14 slots on a Saturday',
  (select count(*) from clinic_search_slots(:'mad', null, :'vt', :'sat_from', :'sat_to', null, 100)) = 14);
select pg_temp.assert('first slot 16:00 and last 23:30 local',
  (select to_char(min(starts_at) at time zone 'Africa/Cairo','HH24:MI') = '16:00' and to_char(max(starts_at) at time zone 'Africa/Cairo','HH24:MI') = '23:30'
     from clinic_search_slots(:'mok', null, :'vt', :'sat_from', :'sat_to', null, 100)));
select pg_temp.assert('no slot starts at 21:00 or 21:30 (break)',
  (select count(*) from clinic_search_slots(:'mok', null, :'vt', :'sat_from', :'sat_to', null, 100)
    where to_char(starts_at at time zone 'Africa/Cairo','HH24:MI') in ('21:00','21:30')) = 0);
select pg_temp.assert('Friday has 0 slots at both branches',
  (select count(*) from clinic_search_slots(:'mok', null, :'vt', :'fri_from', :'fri_to', null, 100)) = 0
  and (select count(*) from clinic_search_slots(:'mad', null, :'vt', :'fri_from', :'fri_to', null, 100)) = 0);
select pg_temp.assert('Mokattam slots belong only to Dr. Mohamed Ali',
  (select bool_and(d.slug = 'dr-mohamed-ali') from clinic_search_slots(:'mok', null, :'vt', :'sat_from', :'sat_to', null, 100) x join doctors d on d.id = x.doctor_id));
select pg_temp.assert('Maadi slots belong only to Dr. Yousef El-Refaie',
  (select bool_and(d.slug = 'dr-yousef-el-refaie') from clinic_search_slots(:'mad', null, :'vt', :'sat_from', :'sat_to', null, 100) x join doctors d on d.id = x.doctor_id));
select pg_temp.assert('asking Mokattam for the Maadi doctor returns nothing',
  (select count(*) from clinic_search_slots(:'mok', (select id from doctors where slug='dr-yousef-el-refaie'), :'vt', :'sat_from', :'sat_to', null, 100)) = 0);

\echo '== B. Sessions start at clinic level; branch must be chosen'
select clinic_open_session('11111111-1111-4111-8111-111111111111', 'demo-dental') as o1 \gset
select clinic_open_session('22222222-2222-4222-8222-222222222222', 'demo-dental') as o2 \gset
select pg_temp.assert('open_session ok, branch_selected = false', (:'o1'::jsonb->>'ok')::boolean and (:'o1'::jsonb->'data'->>'branch_selected')::boolean = false);
select pg_temp.assert('unknown clinic slug -> NOT_FOUND', clinic_open_session('99999999-9999-4999-8999-999999999999','nope')->'error'->>'code' = 'NOT_FOUND');
select clinic_get_info('11111111-1111-4111-8111-111111111111') as info \gset
select pg_temp.assert('get_info lists the clinic, both branches and one doctor per branch',
  (:'info'::jsonb->'data'->>'clinic_name_ar') is not null
  and jsonb_array_length(:'info'::jsonb->'data'->'branches') = 2
  and (select bool_and(jsonb_array_length(b->'doctors') = 1) from jsonb_array_elements(:'info'::jsonb->'data'->'branches') b));
select pg_temp.assert('get_info has Arabic addresses and no price fields',
  (:'info'::jsonb->'data'->'branches'->0->>'address_ar') is not null and (:'info'::text not ilike '%price%'));
select clinic_identify_patient('11111111-1111-4111-8111-111111111111','Sara Ali','+201001112223') as i1 \gset
select clinic_identify_patient('22222222-2222-4222-8222-222222222222','Omar Nabil','+201004445556') as i2 \gset
select pg_temp.assert('bad phone -> VALIDATION_ERROR', clinic_identify_patient('22222222-2222-4222-8222-222222222222','Omar Nabil','0100')->'error'->>'code' = 'VALIDATION_ERROR');
select pg_temp.assert('availability without a branch -> BRANCH_REQUIRED',
  clinic_check_availability('11111111-1111-4111-8111-111111111111', null, null, :'sat_from', :'sat_to')->'error'->>'code' = 'BRANCH_REQUIRED');
select pg_temp.assert('select_branch with unknown ref -> NOT_FOUND', clinic_select_branch('11111111-1111-4111-8111-111111111111','giza')->'error'->>'code' = 'NOT_FOUND');
select clinic_select_branch('11111111-1111-4111-8111-111111111111','mokattam') as sb \gset
select pg_temp.assert('select_branch(mokattam) returns address + the doctor',
  (:'sb'::jsonb->'data'->>'address_ar') like '%المقطم%' and (:'sb'::jsonb->'data'->'doctors'->0->>'name_ar') = 'د. محمد علي');
select clinic_select_branch('22222222-2222-4222-8222-222222222222','mokattam') as sb2 \gset

\echo '== C. Availability (single visit type resolves automatically)'
select clinic_check_availability('11111111-1111-4111-8111-111111111111', null, null, :'sat_from', :'sat_to', 'evening', 3) as av \gset
select pg_temp.assert('availability returns 3 slots with spoken_ar', jsonb_array_length(:'av'::jsonb->'data'->'slots') = 3 and (:'av'::jsonb->'data'->'slots'->0->'local'->>'spoken_ar') like '%الساعة%');
select (:'av'::jsonb->'data'->'slots'->0->>'starts_at')::timestamptz as slot1, (:'av'::jsonb->'data'->'slots'->1->>'starts_at')::timestamptz as slot2,
       (:'av'::jsonb->'data'->'slots'->2->>'starts_at')::timestamptz as slot3 \gset
select clinic_check_availability('11111111-1111-4111-8111-111111111111', null, null, :'fri_from', :'fri_to') as avf \gset
select pg_temp.assert('Friday: no slots here, but later slots AND the other branch (not Friday-closed? both closed) are searched',
  jsonb_array_length(:'avf'::jsonb->'data'->'slots') = 0 and jsonb_array_length(:'avf'::jsonb->'data'->'alternatives'->'later_slots') > 0);
select pg_temp.assert('Friday: other branch is also closed so no same-window alternative there',
  jsonb_array_length(:'avf'::jsonb->'data'->'alternatives'->'other_branches_same_window') = 0);


-- Dr. Mohamed Ali on leave that Saturday -> Mokattam empty -> the agent should be able to offer Maadi for the same window
insert into doctor_time_off (doctor_id, during, reason) select id, tstzrange(:'sat_from', :'sat_to', '[)'), 'smoke-test' from doctors where slug = 'dr-mohamed-ali';
select clinic_check_availability('11111111-1111-4111-8111-111111111111', null, null, :'sat_from', :'sat_to', 'evening', 3) as avt \gset
select pg_temp.assert('Mokattam on leave: 0 slots here, Maadi offered for the same window',
  jsonb_array_length(:'avt'::jsonb->'data'->'slots') = 0
  and jsonb_array_length(:'avt'::jsonb->'data'->'alternatives'->'other_branches_same_window') = 3
  and (:'avt'::jsonb->'data'->'alternatives'->'other_branches_same_window'->0->>'branch_ref') = 'maadi');
delete from doctor_time_off where reason = 'smoke-test';

\echo '== D. Hold -> approval -> confirm'
select clinic_hold_slot('11111111-1111-4111-8111-111111111111','dr-mohamed-ali',null,:'slot1') as h1 \gset
select pg_temp.assert('Sara holds slot1', (:'h1'::jsonb->>'ok')::boolean);
select :'h1'::jsonb->'data'->>'hold_ref' as ref1 \gset
select pg_temp.assert('Omar cannot take the same slot (SLOT_UNAVAILABLE)',
  clinic_hold_slot('22222222-2222-4222-8222-222222222222','dr-mohamed-ali',null,:'slot1')->'error'->>'code' = 'SLOT_UNAVAILABLE');
select pg_temp.assert('off-grid time (+7 min) rejected', clinic_hold_slot('22222222-2222-4222-8222-222222222222','dr-mohamed-ali',null,:'slot1'::timestamptz + interval '7 minutes')->'error'->>'code' = 'SLOT_UNAVAILABLE');
select pg_temp.assert('unknown doctor -> NOT_FOUND', clinic_hold_slot('11111111-1111-4111-8111-111111111111','nobody',null,:'slot1')->'error'->>'code' = 'NOT_FOUND');
select clinic_open_session('33333333-3333-4333-8333-333333333333', 'demo-dental') as o3 \gset
select clinic_select_branch('33333333-3333-4333-8333-333333333333','mokattam') as sb3 \gset
select pg_temp.assert('hold before identify -> NOT_VERIFIED', clinic_hold_slot('33333333-3333-4333-8333-333333333333','dr-mohamed-ali',null,:'slot1')->'error'->>'code' = 'NOT_VERIFIED');
select pg_temp.assert('confirm with unknown approval -> APPROVAL_NOT_FOUND', clinic_confirm_booking('11111111-1111-4111-8111-111111111111','apr_doesnotexist')->'error'->>'code' = 'APPROVAL_NOT_FOUND');
select clinic_create_approval('11111111-1111-4111-8111-111111111111','confirm_booking', :'ref1') as ap1 \gset
select :'ap1'::jsonb->'data'->>'approval_id' as apr \gset
select pg_temp.assert('approval is pending with a server-made summary',
  (:'ap1'::jsonb->'data'->>'status') = 'pending' and (:'ap1'::jsonb->'data'->>'summary') like 'Book Sara Ali with Dr. Mohamed Ali%Mokattam Branch.' and (:'ap1'::jsonb->'data'->>'approval_id') ~ '^apr_[a-f0-9]{12}$');
select pg_temp.assert('execute before decision -> APPROVAL_PENDING', clinic_confirm_booking('11111111-1111-4111-8111-111111111111', :'apr')->'error'->>'code' = 'APPROVAL_PENDING');
select pg_temp.assert('another session cannot decide it', clinic_decide_approval(:'apr','22222222-2222-4222-8222-222222222222','approved','op')->'error'->>'code' = 'NOT_FOUND');
select pg_temp.assert('another session cannot use it', clinic_confirm_booking('22222222-2222-4222-8222-222222222222', :'apr')->'error'->>'code' = 'APPROVAL_NOT_FOUND');
select pg_temp.assert('deny works', clinic_decide_approval(:'apr','11111111-1111-4111-8111-111111111111','denied','operator:demo')->'data'->>'status' = 'denied');
select pg_temp.assert('execute after deny -> APPROVAL_DENIED', clinic_confirm_booking('11111111-1111-4111-8111-111111111111', :'apr')->'error'->>'code' = 'APPROVAL_DENIED');
select clinic_create_approval('11111111-1111-4111-8111-111111111111','confirm_booking', :'ref1')->'data'->>'approval_id' as apr2 \gset
select pg_temp.assert('a fresh approval is issued after a denial (new id)', :'apr2' <> :'apr');
select pg_temp.assert('approve', clinic_decide_approval(:'apr2','11111111-1111-4111-8111-111111111111','approved','operator:demo')->'data'->>'status' = 'approved');
select clinic_confirm_booking('11111111-1111-4111-8111-111111111111', :'apr2') as cf \gset
select pg_temp.assert('confirm -> booked with branch address', (:'cf'::jsonb->'data'->>'status') = 'booked' and (:'cf'::jsonb->'data'->>'branch_address') like 'Street 9, Building 7511%');
select pg_temp.assert('replay -> APPROVAL_ALREADY_USED', clinic_confirm_booking('11111111-1111-4111-8111-111111111111', :'apr2')->'error'->>'code' = 'APPROVAL_ALREADY_USED');

\echo '== E. One patient cannot be in two branches at once'
select clinic_select_branch('11111111-1111-4111-8111-111111111111','maadi') as sb4 \gset
select pg_temp.assert('Maadi slot at the same time as her Mokattam booking -> PATIENT_CONFLICT',
  clinic_hold_slot('11111111-1111-4111-8111-111111111111','dr-yousef-el-refaie',null,:'slot1')->'error'->>'code' = 'PATIENT_CONFLICT');
select pg_temp.assert('availability reports the patient conflict',
  jsonb_array_length(clinic_check_availability('11111111-1111-4111-8111-111111111111', null, null, :'slot1'::timestamptz - interval '1 hour', :'slot1'::timestamptz + interval '1 hour')->'data'->'patient_conflicts') = 1);
select pg_temp.assert('list_my_appointments shows the branch', (clinic_list_my_appointments('11111111-1111-4111-8111-111111111111')->'data'->'appointments'->0->>'branch_ref') = 'mokattam');
select clinic_hold_slot('11111111-1111-4111-8111-111111111111','dr-yousef-el-refaie',null,:'slot2') as hm \gset
select pg_temp.assert('a different time at Maadi is fine', (:'hm'::jsonb->>'ok')::boolean);

\echo '== F. Switching branch releases holds and denies pending approvals'
select :'hm'::jsonb->'data'->>'hold_ref' as refm \gset
select clinic_create_approval('11111111-1111-4111-8111-111111111111','confirm_booking', :'refm')->'data'->>'approval_id' as aprm \gset
select clinic_select_branch('11111111-1111-4111-8111-111111111111','mokattam') as sb5 \gset
select pg_temp.assert('hold released on switch', (select status from appointments where confirmation_code = :'refm') = 'expired');
select pg_temp.assert('pending approval denied on switch', (select status from approvals where id = :'aprm') = 'denied');

\echo '== G. Reschedule (atomic) and cancel policy'
select clinic_create_approval('11111111-1111-4111-8111-111111111111','reschedule_appointment', :'ref1', :'slot3') as rs \gset
select :'rs'::jsonb->'data'->>'approval_id' as aprr \gset
select clinic_decide_approval(:'aprr','11111111-1111-4111-8111-111111111111','approved','operator:demo') as d1 \gset
-- someone else grabs slot3 first: the reschedule must fail and leave the original booking untouched
select clinic_hold_slot('22222222-2222-4222-8222-222222222222','dr-mohamed-ali',null,:'slot3') as hz \gset
select clinic_reschedule_appointment('11111111-1111-4111-8111-111111111111', :'aprr') as rf \gset
select pg_temp.assert('reschedule to a taken slot -> SLOT_UNAVAILABLE', (:'rf'::jsonb->'error'->>'code') = 'SLOT_UNAVAILABLE');
select pg_temp.assert('original booking untouched (all-or-nothing)', (select status from appointments where confirmation_code = :'ref1') = 'booked');
select pg_temp.assert('approval NOT consumed by the failed attempt', (select status from approvals where id = :'aprr') = 'approved');
update appointments set status = 'expired', hold_expires_at = null where confirmation_code = (:'hz'::jsonb->'data'->>'hold_ref');
select clinic_reschedule_appointment('11111111-1111-4111-8111-111111111111', :'aprr') as rok \gset
select pg_temp.assert('reschedule succeeds once slot3 is free', (:'rok'::jsonb->>'ok')::boolean and (:'rok'::jsonb->'data'->>'appointment_ref') <> :'ref1');
select pg_temp.assert('old slot released + new booked', (select status from appointments where confirmation_code = :'ref1') = 'cancelled');
select :'rok'::jsonb->'data'->>'appointment_ref' as refn \gset
update branches set cancel_cutoff_hours = 24*30 where id = :'mok';
select pg_temp.assert('cancel inside cutoff -> OUTSIDE_POLICY (with next step)', clinic_create_approval('11111111-1111-4111-8111-111111111111','cancel_appointment', :'refn')->'error'->>'code' = 'OUTSIDE_POLICY');
update branches set cancel_cutoff_hours = 12 where id = :'mok';
select clinic_create_approval('11111111-1111-4111-8111-111111111111','cancel_appointment', :'refn', null, 'patient_request')->'data'->>'approval_id' as aprc \gset
select clinic_decide_approval(:'aprc','11111111-1111-4111-8111-111111111111','approved','operator:demo') as d2 \gset
select pg_temp.assert('cancel executes', clinic_cancel_appointment('11111111-1111-4111-8111-111111111111', :'aprc')->'data'->>'status' = 'cancelled');

\echo '== H. Expiry'
update appointments set hold_expires_at = now() - interval '1 second' where status = 'held';
select pg_temp.assert('expired hold frees the slot for someone else', (clinic_hold_slot('22222222-2222-4222-8222-222222222222','dr-mohamed-ali',null,:'slot3')->>'ok')::boolean);
select :'slot3'::timestamptz as s3 \gset
select clinic_create_approval('22222222-2222-4222-8222-222222222222','confirm_booking', (select confirmation_code from appointments where status='held' and session_id='22222222-2222-4222-8222-222222222222')) ->'data'->>'approval_id' as apre \gset
select clinic_decide_approval(:'apre','22222222-2222-4222-8222-222222222222','approved','op') as d3 \gset
update approvals set expires_at = now() - interval '1 minute' where id = :'apre';
select pg_temp.assert('expired approval -> APPROVAL_EXPIRED', clinic_confirm_booking('22222222-2222-4222-8222-222222222222', :'apre')->'error'->>'code' = 'APPROVAL_EXPIRED');

\echo '== I. Escalation routing (works before a branch is chosen)'
select clinic_open_session('44444444-4444-4444-8444-444444444444', 'demo-dental') as o4 \gset
select clinic_escalate('44444444-4444-4444-8444-444444444444','emergency','chest pain','Caller reports chest pain') as e1 \gset
select pg_temp.assert('emergency escalation recorded with no branch selected', (:'e1'::jsonb->>'ok')::boolean and (select reason like '%[caller had not chosen a branch]' from escalations where id = (:'e1'::jsonb->'data'->>'escalation_id')::uuid));
select pg_temp.assert('contact details are returned to the SERVICE only inside data.contact; public numbers separate', (:'e1'::jsonb->'data'->'contact'->>'phone') is not null and (:'e1'::jsonb->'data'->'public'->>'emergency_services_number') = '123');
delete from branch_hours;
select pg_temp.assert('outside staffed hours -> notify_contact', clinic_escalate('11111111-1111-4111-8111-111111111111','urgent','needs doctor','x')->'data'->>'route' = 'notify_contact');
insert into branch_hours (branch_id, weekday, opens, closes) select b.id, w, '00:00', '24:00' from branches b, generate_series(0,6) w;
select pg_temp.assert('inside staffed hours -> live_transfer', clinic_escalate('11111111-1111-4111-8111-111111111111','urgent','needs doctor','x')->'data'->>'route' = 'live_transfer');
select pg_temp.assert('delivery status can be recorded truthfully', clinic_escalation_update((select id from escalations order by created_at limit 1),'delivery_failed','webhook','not configured')->>'ok' = 'true');

\echo '== K. Duplicate approvals are idempotent; a live hold blocks the other session'
-- Self-contained: fresh sessions and a fresh hold, so this section does not depend on earlier state.
select clinic_open_session('55555555-5555-4555-8555-555555555555','demo-dental') as o5 \gset
select clinic_select_branch('55555555-5555-4555-8555-555555555555','mokattam') as sb6 \gset
select clinic_identify_patient('55555555-5555-4555-8555-555555555555','Nour Hassan','+201009998887') as i5 \gset
select clinic_check_availability('55555555-5555-4555-8555-555555555555', null, null, :'sat_from', :'sat_to', 'evening', 3) as avk \gset
select (:'avk'::jsonb->'data'->'slots'->0->>'starts_at')::timestamptz as kslot \gset
select clinic_hold_slot('55555555-5555-4555-8555-555555555555','dr-mohamed-ali',null,:'kslot') as kh \gset
select pg_temp.assert('Nour holds a fresh slot', (:'kh'::jsonb->>'ok')::boolean);
select :'kh'::jsonb->'data'->>'hold_ref' as kref \gset
select clinic_create_approval('55555555-5555-4555-8555-555555555555','confirm_booking', :'kref')->'data'->>'approval_id' as kap1 \gset
select clinic_create_approval('55555555-5555-4555-8555-555555555555','confirm_booking', :'kref')->'data'->>'approval_id' as kap2 \gset
select pg_temp.assert('requesting approval twice for the same hold returns the SAME live approval', :'kap1' = :'kap2');
select pg_temp.assert('...and does not insert a second row for that appointment',
  (select count(*) from approvals a join appointments ap on ap.id = (a.params->>'appointment_id')::uuid
     where ap.confirmation_code = :'kref') = 1);

-- Session B wants the slot session A is holding.
select clinic_open_session('66666666-6666-4666-8666-666666666666','demo-dental') as o6 \gset
select clinic_select_branch('66666666-6666-4666-8666-666666666666','mokattam') as sb7 \gset
select clinic_identify_patient('66666666-6666-4666-8666-666666666666','Hassan Adel','+201002223334') as i6 \gset
select pg_temp.assert('another session cannot hold a slot that is currently held',
  clinic_hold_slot('66666666-6666-4666-8666-666666666666','dr-mohamed-ali',null,:'kslot')->'error'->>'code' = 'SLOT_UNAVAILABLE');
update appointments set hold_expires_at = now() - interval '1 second' where confirmation_code = :'kref';
select pg_temp.assert('once the first hold expires the second session can take the same slot',
  (clinic_hold_slot('66666666-6666-4666-8666-666666666666','dr-mohamed-ali',null,:'kslot')->>'ok')::boolean);

\echo '== L. DST: slots across the Africa/Cairo transition stay on the local grid'
-- Egypt observes DST. The autumn change lands at midnight at the end of a Thursday,
-- which can repeat the local 23:00-24:00 hour, and that Thursday is a working day.
-- Instead of asserting an exact slot count (which depends on how the repeated hour is
-- represented), assert the invariants a timezone bug would break: local times stay on
-- the 16:00-23:30 half-hour grid, and no two slots collapse onto the same local time.
-- The spring change lands at midnight on a Friday, which is closed, so there is nothing
-- to search there.
select case when (now() at time zone 'Africa/Cairo')::date >= make_date(extract(year from (now() at time zone 'Africa/Cairo'))::int, 10, 26)
            then extract(year from (now() at time zone 'Africa/Cairo'))::int + 1
            else extract(year from (now() at time zone 'Africa/Cairo'))::int end as dst_year \gset
select (select d::date from generate_series(make_date(:'dst_year'::int, 10, 25), make_date(:'dst_year'::int, 10, 31), interval '1 day') d
         where extract(dow from d) = 4 order by d desc limit 1) as dst_thu \gset
select (:'dst_thu'::date)::timestamp at time zone 'Africa/Cairo' as dst_from,
       ((:'dst_thu'::date) + 1)::timestamp at time zone 'Africa/Cairo' as dst_to \gset
select count(*) as dst_slots from clinic_search_slots(:'mok', null, :'vt', :'dst_from', :'dst_to', null, 100) \gset
select pg_temp.assert('the last Thursday of October is a working day with slots', :'dst_slots'::int > 0);
select pg_temp.assert('every slot across the transition is on the 16:00-23:30 local half-hour grid',
  (select bool_and((starts_at at time zone 'Africa/Cairo')::time >= time '16:00'
                   and (starts_at at time zone 'Africa/Cairo')::time <= time '23:30'
                   and extract(minute from (starts_at at time zone 'Africa/Cairo'))::int % 30 = 0)
     from clinic_search_slots(:'mok', null, :'vt', :'dst_from', :'dst_to', null, 100)));
select pg_temp.assert('no two slots collapse onto the same local time across the transition',
  (select count(*) = count(distinct date_trunc('minute', starts_at at time zone 'Africa/Cairo'))
     from clinic_search_slots(:'mok', null, :'vt', :'dst_from', :'dst_to', null, 100)));

\echo '== J. Security'
select pg_temp.assert('PUBLIC cannot execute booking functions', not has_function_privilege('public','clinic_hold_slot(uuid,text,text,timestamptz)','execute'));
select pg_temp.assert('no double-booking exists anywhere', (select count(*) from appointments a join appointments b on a.id < b.id and a.doctor_id = b.doctor_id
  and a.status in ('held','booked') and b.status in ('held','booked') and tstzrange(a.starts_at,a.ends_at) && tstzrange(b.starts_at,b.ends_at)) = 0);
\echo '== M. reset_demo.sql clears real call data and keeps the clinic setup'

-- A rehearsal leaves a confirmed booking behind (appointments.approval_id set — the foreign
-- key that used to make reset_demo.sql fail), plus a live hold, a note and an escalation.
select clinic_open_session('77777777-7777-4777-8777-777777777777','demo-dental') as m_open \gset
select clinic_select_branch('77777777-7777-4777-8777-777777777777','mokattam') as m_branch \gset
select clinic_identify_patient('77777777-7777-4777-8777-777777777777','Mariam Fouad','+201005556667') as m_id \gset
select clinic_check_availability('77777777-7777-4777-8777-777777777777', null, null, :'sat_from', :'sat_to', null, 2) as m_av \gset
select (:'m_av'::jsonb->'data'->'slots'->0->>'starts_at')::timestamptz as m_book_at \gset
select clinic_hold_slot('77777777-7777-4777-8777-777777777777','dr-mohamed-ali',null,:'m_book_at') as m_hold \gset
select :'m_hold'::jsonb->'data'->>'hold_ref' as m_ref \gset
select clinic_create_approval('77777777-7777-4777-8777-777777777777','confirm_booking', :'m_ref')->'data'->>'approval_id' as m_apr \gset
select clinic_decide_approval(:'m_apr','77777777-7777-4777-8777-777777777777','approved','operator:demo') as m_dec \gset
select clinic_confirm_booking('77777777-7777-4777-8777-777777777777', :'m_apr') as m_confirm \gset
select pg_temp.assert('rehearsal: the booking was confirmed', (:'m_confirm'::jsonb->>'ok')::boolean);
select pg_temp.assert('rehearsal: that appointment carries the approval it used (the FK reset_demo.sql must respect)',
  (select approval_id is not null from appointments
    where session_id = '77777777-7777-4777-8777-777777777777' and status = 'booked'));
select clinic_add_note('77777777-7777-4777-8777-777777777777','note','rehearsal note', :'m_ref') as m_note \gset

-- A second session, still mid-call: identified with a live hold at the other branch.
select clinic_open_session('88888888-8888-4888-8888-888888888888','demo-dental') as m2_open \gset
select clinic_select_branch('88888888-8888-4888-8888-888888888888','maadi') as m2_branch \gset
select clinic_identify_patient('88888888-8888-4888-8888-888888888888','Tarek Sami','+201007778889') as m2_id \gset
select clinic_check_availability('88888888-8888-4888-8888-888888888888', null, null, :'sat_from', :'sat_to', null, 1) as m2_av \gset
select (:'m2_av'::jsonb->'data'->'slots'->0->>'starts_at')::timestamptz as m2_at \gset
select clinic_hold_slot('88888888-8888-4888-8888-888888888888','dr-yousef-el-refaie',null,:'m2_at') as m2_hold \gset
select pg_temp.assert('rehearsal: a second session holds a slot at the other branch', (:'m2_hold'::jsonb->>'ok')::boolean);
select clinic_escalate('88888888-8888-4888-8888-888888888888','urgent','rehearsal','reset rehearsal') as m2_esc \gset
select pg_temp.assert('rehearsal: an escalation exists to be cleared', (:'m2_esc'::jsonb->>'ok')::boolean);
select pg_temp.assert('rehearsal: every table the reset clears actually holds rows (so the checks below cannot pass vacuously)',
  (select count(*) from patients) >= 1 and (select count(*) from call_sessions) >= 1
  and (select count(*) from appointments) >= 1 and (select count(*) from approvals) >= 1
  and (select count(*) from escalations) >= 1 and (select count(*) from call_notes) >= 1);

-- Snapshot the clinic setup, then run the REAL reset file (not a copy of its deletes).
select (select count(*) from tenants) as c_tenants,
       (select count(*) from branches) as c_branches,
       (select count(*) from branch_hours) as c_hours,
       (select count(*) from specialties) as c_specialties,
       (select count(*) from visit_types) as c_visit_types,
       (select count(*) from doctors) as c_doctors,
       (select count(*) from doctor_visit_types) as c_doctor_visit_types,
       (select count(*) from doctor_schedules) as c_schedules \gset

\i supabase/reset_demo.sql

select pg_temp.assert('reset_demo.sql: patients, call_sessions, appointments and approvals are all empty',
  (select count(*) from patients) = 0 and (select count(*) from call_sessions) = 0
  and (select count(*) from appointments) = 0 and (select count(*) from approvals) = 0);
select pg_temp.assert('reset_demo.sql: escalations, call_notes and audit_events are empty',
  (select count(*) from escalations) = 0 and (select count(*) from call_notes) = 0 and (select count(*) from audit_events) = 0);
select pg_temp.assert('reset_demo.sql: the clinic setup is untouched',
  (select count(*) from tenants) = :'c_tenants'::int
  and (select count(*) from branches) = :'c_branches'::int
  and (select count(*) from branch_hours) = :'c_hours'::int
  and (select count(*) from specialties) = :'c_specialties'::int
  and (select count(*) from visit_types) = :'c_visit_types'::int
  and (select count(*) from doctors) = :'c_doctors'::int
  and (select count(*) from doctor_visit_types) = :'c_doctor_visit_types'::int
  and (select count(*) from doctor_schedules) = :'c_schedules'::int);

-- Put the clinic setup back the way a rehearsal expects it: 16:00-24:00, Friday closed.
\i supabase/seed_clinic_demo.sql
select pg_temp.assert('re-seed: branch hours are Sat-Thu 16:00-24:00 with Friday closed',
  (select count(*) from branch_hours) = 12 and (select count(*) from branch_hours where weekday = 5) = 0
  and (select bool_and(opens = time '16:00' and closes = time '24:00') from branch_hours));
select pg_temp.assert('re-seed: a whole Saturday is bookable again (14 slots per branch)',
  (select count(*) from clinic_search_slots(:'mok', null, :'vt', :'sat_from', :'sat_to', null, 100)) = 14
  and (select count(*) from clinic_search_slots(:'mad', null, :'vt', :'sat_from', :'sat_to', null, 100)) = 14);

\echo '== N. Availability prefetch: one read-only call, both branches, nothing reserved'
-- The bridge calls this next to clinic_open_session on the first turn of a session so
-- "what''s available?" does not need a check_availability round trip. It must be
-- advisory: no branch selected, no writes, and a snapshot the bridge can age out.

select (select count(*) from patients) as n_pat, (select count(*) from call_sessions) as n_sess,
       (select count(*) from appointments) as n_appt, (select count(*) from approvals) as n_appr,
       (select count(*) from escalations) as n_esc, (select count(*) from call_notes) as n_note,
       (select count(*) from audit_events) as n_audit \gset

select clinic_open_session('99999999-9999-4999-8999-999999999901','demo-dental') as n_open \gset
select pg_temp.assert('prefetch: the session still has no branch selected', (:'n_open'::jsonb->>'ok')::boolean);
select clinic_prefetch_availability('99999999-9999-4999-8999-999999999901') as n_pf \gset
select pg_temp.assert('prefetch: ok, both branches returned, and no branch has to be chosen first',
  (:'n_pf'::jsonb->>'ok')::boolean
  and jsonb_array_length(:'n_pf'::jsonb->'data'->'branches') = 2
  and (:'n_pf'::jsonb->'data'->>'selected_branch_ref') is null
  and (select bool_and(b->>'branch_ref' in ('mokattam','maadi'))
         from jsonb_array_elements(:'n_pf'::jsonb->'data'->'branches') b));
select pg_temp.assert('prefetch: every branch names its dentist and carries exactly `limit` slots although more are free',
  (select bool_and(jsonb_array_length(b->'slots') = 5 and (b->'slots'->0->>'doctor_ref') is not null)
     from jsonb_array_elements(:'n_pf'::jsonb->'data'->'branches') b)
  and (select bool_and((select count(*) from clinic_search_slots(br.id, null, :'vt', now(), now() + interval '2 days', null, 100)) > 5)
         from branches br where br.slug in ('mokattam','maadi'))
  and (select sum(jsonb_array_length(b->'slots')) from jsonb_array_elements(:'n_pf'::jsonb->'data'->'branches') b) = 10);
with s as (
  select b->>'branch_ref' as br, (x->>'starts_at')::timestamptz as at, o as pos
  from jsonb_array_elements(:'n_pf'::jsonb->'data'->'branches') b,
       jsonb_array_elements(b->'slots') with ordinality as t(x, o)
), d as (select br, at, lag(at) over (partition by br order by pos) as prev from s)
select pg_temp.assert('prefetch: slots are ordered oldest first inside each branch',
  (select bool_and(prev is null or at > prev) from d));
select pg_temp.assert('prefetch: no slot lands in the 21:00-22:00 break',
  not exists (select 1 from jsonb_array_elements(:'n_pf'::jsonb->'data'->'branches') b,
                       jsonb_array_elements(b->'slots') x
              where x->'local'->>'time_24' in ('21:00','21:30')));
select clinic_prefetch_availability('99999999-9999-4999-8999-999999999901', 7, 5) as n_pf7 \gset
select pg_temp.assert('prefetch: a 7-day window always contains a Friday, and no slot lands on one',
  (select count(*) from generate_series(0, 7) g
    where extract(dow from (now() at time zone 'Africa/Cairo')::date + g) = 5) > 0
  and not exists (select 1 from jsonb_array_elements(:'n_pf7'::jsonb->'data'->'branches') b,
                           jsonb_array_elements(b->'slots') x
                  where extract(dow from (x->'local'->>'iso_date')::date) = 5));
select pg_temp.assert('prefetch: every slot carries spoken_ar and spoken_en for the voice layer',
  (select bool_and(coalesce(x->'local'->>'spoken_ar','') like '%الساعة%'
                   and coalesce(x->'local'->>'spoken_en','') <> ''
                   and coalesce(x->'local'->>'time_24','') ~ '^[0-2][0-9]:[0-5][0-9]$')
     from jsonb_array_elements(:'n_pf'::jsonb->'data'->'branches') b,
          jsonb_array_elements(b->'slots') x));
select pg_temp.assert('prefetch: generated_at is a Z-suffixed UTC instant inside the 60-second validity window',
  (:'n_pf'::jsonb->'data'->>'generated_at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$'
  and (:'n_pf'::jsonb->'data'->>'valid_for_seconds')::int = 60
  and (:'n_pf'::jsonb->'data'->>'generated_at')::timestamptz
        between now() - interval '60 seconds' and now() + interval '5 seconds');
select pg_temp.assert('prefetch: unknown session -> NOT_FOUND',
  clinic_prefetch_availability('99999999-9999-4999-8999-999999999999')->'error'->>'code' = 'NOT_FOUND');
select pg_temp.assert('prefetch: nothing was written (only the session this section opened)',
  (select count(*) from patients) = :'n_pat'::int
  and (select count(*) from call_sessions) = :'n_sess'::int + 1
  and (select count(*) from appointments) = :'n_appt'::int
  and (select count(*) from approvals) = :'n_appr'::int
  and (select count(*) from escalations) = :'n_esc'::int
  and (select count(*) from call_notes) = :'n_note'::int
  and (select count(*) from audit_events) = :'n_audit'::int);
select pg_temp.assert('prefetch: PUBLIC and anon/authenticated cannot execute it, service_role can',
  not has_function_privilege('public','clinic_prefetch_availability(uuid,int,int)','execute')
  and (not exists (select 1 from pg_roles where rolname = 'anon')
       or not has_function_privilege('anon','clinic_prefetch_availability(uuid,int,int)','execute'))
  and (not exists (select 1 from pg_roles where rolname = 'authenticated')
       or not has_function_privilege('authenticated','clinic_prefetch_availability(uuid,int,int)','execute'))
  and (not exists (select 1 from pg_roles where rolname = 'service_role')
       or has_function_privilege('service_role','clinic_prefetch_availability(uuid,int,int)','execute')));
-- Leave no call data behind: this section is the last one in the file.
delete from call_sessions where id = '99999999-9999-4999-8999-999999999901';
select pg_temp.assert('prefetch: the suite still leaves no call data behind',
  (select count(*) from call_sessions) = 0 and (select count(*) from patients) = 0
  and (select count(*) from appointments) = 0 and (select count(*) from audit_events) = 0);
\echo '== ALL CHECKS PASSED'
