-- Reset the demo between rehearsals / test runs.
-- Keeps the clinic setup (tenants, branches, branch_hours, specialties,
-- visit_types, doctors, doctor_visit_types, doctor_schedules, doctor_time_off)
-- and deletes only the call data: sessions, patients, appointments, approvals,
-- escalations, notes and the audit trail.
--
-- Run it AFTER the migration and seed, e.g.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/reset_demo.sql
-- It is idempotent and safe to run on a database that is already empty.
--
-- audit_events is append-only for the application role (service_role has
-- update/delete revoked), so the truncation below runs as the migration owner.

begin;

-- Children before parents, in the order the foreign keys actually require:
--   call_notes    -> appointments, call_sessions
--   appointments  -> approvals, call_sessions, patients, branches, doctors, visit_types
--   approvals     -> call_sessions
--   escalations   -> call_sessions, branches
--   call_sessions -> patients, branches
--   patients      -> tenants
-- audit_events carries no foreign key, so its position does not matter.
--
-- appointments MUST be deleted before approvals. appointments.approval_id is a
-- foreign key into approvals (appointments_approval_fk) and every confirmed
-- booking sets it, so deleting approvals first raises
--   ERROR: update or delete on table "approvals" violates foreign key constraint
--          "appointments_approval_fk" on table "appointments"
-- and, because the deletes below share one transaction, nothing is deleted at all.
-- supabase/tests/clinic_smoke.sql section M guards this ordering.
delete from audit_events;
delete from call_notes;
delete from appointments;
delete from approvals;
delete from escalations;
delete from call_sessions;
delete from patients;

commit;

-- Report what is left, so a run is self-checking.
select 'tenants'            as table_name, count(*) from tenants
union all select 'branches',           count(*) from branches
union all select 'branch_hours',       count(*) from branch_hours
union all select 'doctors',            count(*) from doctors
union all select 'doctor_schedules',   count(*) from doctor_schedules
union all select 'visit_types',        count(*) from visit_types
union all select 'patients',           count(*) from patients
union all select 'call_sessions',      count(*) from call_sessions
union all select 'appointments',       count(*) from appointments
union all select 'approvals',          count(*) from approvals
union all select 'escalations',        count(*) from escalations
union all select 'call_notes',         count(*) from call_notes
union all select 'audit_events',       count(*) from audit_events
order by table_name;
