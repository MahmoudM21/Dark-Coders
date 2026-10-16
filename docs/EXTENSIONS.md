# Five live extensions

Each is scoped to about ten minutes of work on top of what is already here, and
each leans on something the system already has: the SQL functions, the audit
trail, or the deterministic tool envelope. None of them needs a new model.

---

## 1. Reminder call ~24 h before the appointment

**What:** an outbound call or message the day before, using the same agent.

**Why it is cheap:** the escalation path already knows how to reach a human
through a webhook, and `clinic_list_my_appointments` already returns everything a
reminder needs.

**Sketch:**

1. Add `clinic_appointments_due(p_within interval)` returning the same row shape
   as `clinic_list_my_appointments`, restricted to `status = 'booked'` and
   `starts_at between now() and now() + p_within`.
2. Add a `scripts/clinic-reminders.mjs` cron job that calls it through
   `supabaseAdmin.rpc`, then POSTs `{appointment_ref, name, phone, local, branch}`
   to the same `ESCALATION_WEBHOOK_URL` (or a new `REMINDER_WEBHOOK_URL`).
3. Log each attempt in `audit_events` with `actor 'scheduler'` so the trail shows
   what was sent and whether it was delivered.
4. Idempotency: add `reminder_sent_at` to `appointments` and skip anything with
   it set — the same single-use discipline as approvals.

**Watch out:** do not let the job "confirm" anything. A reminder is a
notification, not a booking, and it must report the real delivery status exactly
like `escalate` does.

---

## 2. Waitlist when a slot is unavailable

**What:** when `SLOT_UNAVAILABLE` and there are no alternatives the caller likes,
offer to be contacted when something frees up.

**Why it is cheap:** the caller is already identified, so the phone number is
already server-side; the tool envelope already carries `agent_action`.

**Sketch:**

1. Table `waitlist (id, tenant_id, branch_id, patient_id, window tstzrange,
   visit_type_id, status, created_at)`, RLS on, service-role only — same pattern
   as every other table.
2. `clinic_join_waitlist(p_session, p_from, p_to)` plus a `clinic_waitlist_notify`
   function called from `scripts/clinic-reminders.mjs`: when a cancellation frees
   a slot, find the oldest matching waitlist row, mark it `offered`, and hand it
   to the same webhook.
3. Return a new error code `WAITLIST_AVAILABLE` with `agent_action: ask_again` so
   the prompt's error table stays the single source of behaviour.
4. Expose it as a tool: true branch logic already lives in SQL, so this is one
   more `case` in the dispatcher plus one line in the MCP proxy.

**Watch out:** a waitlist offer must not hold the slot silently. Either use the
existing 180-second hold, or let the offer expire — otherwise the waitlist itself
becomes a source of phantom bookings.

---

## 3. Branch switch by voice, mid-conversation

**What:** "خلاص، خليها المعادي" after the caller has already given a time.

**Why it is nearly free:** `select_branch` already releases holds and denies
pending approvals, and `alternatives.other_branches_same_window` already computes
what the other branch has. The tool is idempotent and speakable.

**Sketch:**

1. Nothing to build server-side. Add a demo line to `docs/TESTING.md` and check
   the agent says the doctor's name changed (each branch has a different dentist).
2. Harden the prompt: after a switch, the agent must re-read the new doctor's name
   and must not re-use the old `hold_ref` — a released hold must never be
   confirmed. `APPROVAL_DENIED` is what it will get if it tries; say that out loud
   in the demo.
3. Add a SQL assertion: after a switch, the old hold is `expired` and any pending
   approval for it is `denied`. (Section F of `clinic_smoke.sql` already checks
   exactly this — extend it to cover a switch *after* `identify_patient`.)

---

## 4. A signed approve endpoint instead of a chat message

**What:** replace the "the Approve click is a chat message" weakness in
`docs/ARCHITECTURE.md` §10.1 with a real endpoint.

**Why it matters:** today anyone who can type the exact
`Approved action [apr_…]` string can approve. The database still checks session,
state, expiry and single use, but the *identity* of the approver is asserted by
text.

**Sketch:**

1. `src/routes/api/clinic/approvals/decide.ts`: POST `{approval_id, decision}`
   from the console, requiring the same `CLINIC_TOOLS_TOKEN`-style auth but for
   the operator session, and reject non-same-origin callers
   (`isSameOriginRequest`).
2. Have `console-panels.tsx`'s `onDecideProposal` call the endpoint first and only
   then append the existing system message, so the model still learns the
   decision through the same channel.
3. Keep `clinic_decide_approval` untouched: it is already the authority. The
   endpoint only removes the "anyone can type it" surface.
4. Add a bridge audit event `approval_decision_endpoint` so the drills can show
   both paths.

**Watch out:** do not accept the decision from the request body alone — carry the
approver's identity into `clinic_decide_approval`'s `p_operator` so the audit row
names a real operator rather than `operator:console`.

---

## 5. Real tool traces in the Thinking panel

**What:** the "Exceptional" tier of `docs/ARCHITECTURE.md` §11 — show the actual
tool calls as they happen.

**Why it is cheap:** `audit_events` already records every tool call with
`latency_ms` and `outcome`; the bridge already streams SSE and already knows the
session id.

**Sketch:**

1. In `src/routes/api/agent.ts`, while the model response is in flight, poll
   `audit_events` for this session every 400 ms for rows newer than the last seen
   `at` (the table's only timestamp column).
2. Emit each as a `response.reasoning_summary_text.delta` line —
   `"check_availability → ok (84 ms)"` — which the console already renders in the
   Thinking panel. No console change needed.
3. Never synthesise a line: if nothing new arrived, emit nothing. `P5` in
   `docs/PROMPTS.md` already flags this as a stretch goal for exactly that reason.
4. Guard the cost: stop polling when the model stream ends, and skip the whole
   thing when `CLINIC_TENANT_SLUG` is unset.

**Watch out:** the audit rows are written by the *tool* process, which may commit
after the poll window. Accept that the last row can be missing rather than
inventing it.
