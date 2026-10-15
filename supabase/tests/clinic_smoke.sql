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

\echo '== J. Security'
select pg_temp.assert('PUBLIC cannot execute booking functions', not has_function_privilege('public','clinic_hold_slot(uuid,text,text,timestamptz)','execute'));
select pg_temp.assert('no double-booking exists anywhere', (select count(*) from appointments a join appointments b on a.id < b.id and a.doctor_id = b.doctor_id
  and a.status in ('held','booked') and b.status in ('held','booked') and tstzrange(a.starts_at,a.ends_at) && tstzrange(b.starts_at,b.ends_at)) = 0);
\echo '== ALL CHECKS PASSED'
