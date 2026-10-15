# Six-minute voice demo

Run `npm run clinic:preflight` first and clear the `FAIL` lines. Do the demo in
one conversation so the session (and its holds, approvals and notes) stay
together. `docs/TESTING.md` has the full pre-flight and the SQL that proves each
claim; this page is the script you read from.

**Before you start:** replace the seed's placeholder phones/emails, or leave
`ESCALATION_WEBHOOK_URL` unset — section 4 *depends* on it being unset, and says
so out loud.

The Arabic is written the way an Egyptian caller would say it. Anything in
_italics_ is what you should see, not say.

---

## 0:00 — Greeting and branch (30 s)

> **You:** أهلاً، عايز أحجز كشف أسنان

_Reply greets with the clinic name — عيادة ديمو لطب الأسنان — and asks which
branch. Two buttons appear: **فرع المقطم** and **فرع المعادي**._

Say the point out loud: there is **no branch in the server config**; the caller
chooses. Nothing can be scheduled until they do.

## 0:30 — Branch, identity (60 s)

> **You:** فرع المقطم

_Names د. محمد علي once. The Run panel shows `select_branch → ok`._

> **You:** اسمي محمد علي

_Asks for the phone — one question, not two._

> **You:** ٠١٠٠١١١٢٢٢٣
>
> (Say it slowly; Arabic-Indic digits are fine, and so is plain `01001112223`. It
> is stored as `+201001112223`.)

_Mentions once that it will save the name and phone to manage the booking._

## 1:30 — Availability and hold (90 s)

> **You:** عايز السبت بعد 5

_At most **three** slots, with Arabic weekday and time taken straight from the
tool's `spoken_ar` — the model never does date arithmetic. Buttons appear; the
spoken text does **not** repeat them._

> **You:** (pick one, or) أيوه

_Reads back doctor, branch, day and time, and asks for a clear yes. Says the hold
is short (180 s)._

## 3:00 — The approval gate (90 s) — the centrepiece

> **You:** أيوه

_Reply says it is waiting for approval. Now look at the **approval panel**: the
title and summary were written by the database, not the model — "Book Mohamed Ali
with Dr. Mohamed Ali … Mokattam Branch." Say that out loud, then prove it is not
just a claim:_

```sql
select id, title, summary, risk, status from approvals order by created_at desc limit 1;
```

_The panel text matches the row, character for character, and the id is
`apr_` + 12 hex. Click **✓ Approve**._

> **The console sends:** `Approved action [apr_…] (…). Proceed and report the result.`

_The bridge verifies the id against the database, the agent calls
`confirm_booking`, and the reply confirms doctor, branch, day, time, the Arabic
branch address, and reads the confirmation code **once**. Only now may the agent
say "booked"._

```sql
select appointment_ref, status from appointments order by created_at desc limit 1;   -- booked
select status, decided_by, used_at from approvals order by created_at desc limit 1;  -- approved, used
```

## 4:30 — It tells the truth when things fail (60 s)

**Slot taken.** In a second conversation, book the same slot, then in the first
try to hold it again. Expect `SLOT_UNAVAILABLE`, a re-check, and up to three
alternatives — never "booked".

**Cancel inside the cutoff.** Ask to cancel the appointment you just made (it is
within the 12-hour cutoff). Expect `OUTSIDE_POLICY`: the agent explains the rule
from the tool's own details and offers a human handoff. Nothing changes in the
database.

**Emergency, with no webhook configured.** With `ESCALATION_WEBHOOK_URL` unset:

> **You:** عندي chest pain ومش قادر أتنفس

_In the **same turn** the agent calls `escalate_to_human(severity="emergency")`,
tells you to call the emergency number from the tool result (the seeded `123`),
and stops trying to book. Because delivery failed it must say it could **not**
confirm the team was reached and give the clinic phone — it must never say
"notified"._

```sql
select severity, route, status, channel, error from escalations order by created_at desc limit 1;
-- status = delivery_failed, channel = none, error = ESCALATION_WEBHOOK_URL is not configured
```

Then run `npm run clinic:webhook-echo`, set the URL, and repeat: now the receiver
prints the escalation and the agent says the team was notified. The difference in
wording is the whole point.

## 5:30 — Close (30 s)

Show `audit_events` for the session — every tool call, its outcome and its
latency, in order:

```sql
select created_at, actor, event, tool, outcome, error_code from audit_events order by created_at;
```

Then the one-sentence summary: *the model understands and speaks, deterministic
code decides and executes, and the database — not the model — authors and
verifies every approval.*

---

## If the gateway is not available

Everything except the model's wording can still be demonstrated: run
`npm run clinic:mcp-smoke` (13 tools, real handshake, bearer token), then
`npm run clinic:api-smoke` (the tool envelopes and error codes end to end), and
walk the SQL checks above. Say plainly that the replies are scripted output, not
the agent.
