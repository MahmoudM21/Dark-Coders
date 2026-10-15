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

-- Children before parents; appointments/approvals/notes/escalations all point at
-- a call_session, and approvals may authorise an appointment.
delete from audit_events;
delete from call_notes;
delete from escalations;
delete from approvals;
delete from appointments;
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
