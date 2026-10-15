-- Demo data. Idempotent. Run AFTER the migration.
-- ONE clinic (tenant) with TWO branches, ONE dentist per branch.
--   Mokattam : Dr. Mohamed Ali       Maadi : Dr. Yousef El-Refaie
--   Hours    : Sat–Thu, appointment every 30 min 16:00–21:00 and 22:00–24:00 (21:00–22:00 break), Friday off
--              => 10 + 4 = 14 appointments per doctor per day.
-- Times are Africa/Cairo local time. PHONES/EMAILS BELOW ARE PLACEHOLDERS — replace with real ones.
-- Adding another clinic later = insert another tenants row + its branches/doctors; no schema change.

insert into tenants (id, slug, name, name_ar, default_locale)
values ('00000000-0000-4000-8000-000000000001', 'demo-dental', 'Demo Dental Clinic', 'عيادة ديمو لطب الأسنان', 'ar-EG')
on conflict (slug) do nothing;

insert into branches (id, tenant_id, slug, name, name_ar, address, address_ar, phone,
                      emergency_contact_name, emergency_phone, emergency_email, emergency_services_number)
values
 ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000001', 'mokattam',
  'Mokattam Branch', 'فرع المقطم',
  'Street 9, Building 7511, 2nd Floor, Clinic 5, Mokattam, Cairo',
  'شارع 9، عمارة 7511، الدور الثاني، عيادة رقم 5، المقطم',
  '+20200000001', 'Duty Manager (Mokattam)', '+201000000001', 'mokattam-duty@example.invalid', '123'),
 ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-000000000001', 'maadi',
  'Maadi Branch', 'فرع المعادي',
  'Street 33, Building 512 (Doctors Tower), 4th Floor, Clinic 32, Maadi, Cairo',
  'شارع 33، عمارة 512 (برج الأطباء)، الدور الرابع، عيادة رقم 32، المعادي',
  '+20200000002', 'Duty Manager (Maadi)', '+201000000002', 'maadi-duty@example.invalid', '123')
on conflict (tenant_id, slug) do nothing;

-- Staffed hours (used only for escalation routing): same as the doctors' day. Friday closed.
delete from branch_hours where branch_id in ('00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000b2');
insert into branch_hours (branch_id, weekday, opens, closes)
select b, w, '16:00', '24:00'
from unnest(array['00000000-0000-4000-8000-0000000000b1','00000000-0000-4000-8000-0000000000b2']::uuid[]) b,
     unnest(array[6,0,1,2,3,4]) w;          -- Sat, Sun, Mon, Tue, Wed, Thu

insert into specialties (id, tenant_id, name_en, name_ar)
values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'Dentistry', 'طب الأسنان')
on conflict do nothing;

insert into visit_types (id, tenant_id, code, name_en, name_ar, duration_minutes)
values ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-000000000001', 'dental_visit', 'Dental visit', 'كشف أسنان', 30)
on conflict (tenant_id, code) do nothing;

insert into doctors (id, tenant_id, slug, full_name_en, full_name_ar, specialty_id, slot_minutes) values
 ('00000000-0000-4000-8000-0000000000d1', '00000000-0000-4000-8000-000000000001', 'dr-mohamed-ali',
  'Dr. Mohamed Ali', 'د. محمد علي', '00000000-0000-4000-8000-0000000000a1', 30),
 ('00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-000000000001', 'dr-yousef-el-refaie',
  'Dr. Yousef El-Refaie', 'د. يوسف الرفاعي', '00000000-0000-4000-8000-0000000000a1', 30)
on conflict (tenant_id, slug) do nothing;

insert into doctor_visit_types (doctor_id, visit_type_id)
select d.id, '00000000-0000-4000-8000-0000000000c1' from doctors d where d.tenant_id = '00000000-0000-4000-8000-000000000001'
on conflict do nothing;

-- Mohamed Ali works ONLY at Mokattam; Yousef El-Refaie works ONLY at Maadi. Two blocks per day (break 21:00–22:00).
delete from doctor_schedules where doctor_id in ('00000000-0000-4000-8000-0000000000d1','00000000-0000-4000-8000-0000000000d2');
insert into doctor_schedules (doctor_id, branch_id, weekday, start_time, end_time)
select d, b, w, t.s::time, t.e::time
from (values ('00000000-0000-4000-8000-0000000000d1'::uuid, '00000000-0000-4000-8000-0000000000b1'::uuid),
             ('00000000-0000-4000-8000-0000000000d2'::uuid, '00000000-0000-4000-8000-0000000000b2'::uuid)) as db(d, b),
     unnest(array[6,0,1,2,3,4]) w,
     (values ('16:00','21:00'), ('22:00','24:00')) as t(s, e);
