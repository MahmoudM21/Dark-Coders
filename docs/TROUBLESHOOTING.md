# Troubleshooting — clinic voice console

Every entry below is a failure that was actually observed on this checkout, with
the evidence that identifies it and the fix. If a symptom is not here, run the
probe named in its section instead of guessing: `npm run clinic:preflight`,
`npm run clinic:stt-probe`, `npm run clinic:latency`.

## "Failed to fetch" while DevTools shows HTTP 200

**What it means:** the request succeeded and the browser then blocked the
*response* from JavaScript, because the response carried no
`Access-Control-Allow-Origin` header. This is a CORS failure on the response, not
a network failure — which is why the status column says 200 and the console still
says "Failed to fetch". A response body of 11 bytes (`{"text":""}`) is a valid,
empty transcript.

**Diagnose (server side, no browser):**

```bash
npm run clinic:stt-probe        # prints status + ACAO on the POST response, cold vs warm
```

If `ACAO (absent)` appears for the POST while the `OPTIONS` line has one, the
service allows the preflight but not the actual response. That is exactly the
case this console hit with Speaches.

**Fix:** use **Settings → Voice & Agents → Speech recognition → Local via app**
(the default). The browser uploads to `/api/asr` on this origin and the server
forwards the file to `ASR_BASE_URL`; the ASR service's CORS policy stops
mattering. Direct browser mode remains available under "Local direct browser"
and is only appropriate when the service sends ACAO on the response.

Note: the headset's `localhost` is the headset, not your computer. A direct URL
pointing at `localhost` from a headset browser will not reach a server on the
desktop.

## Gemini fallback answers "busy" or the generic failure screen

**What it means:** the Gateway refused the model call, so nobody knows whether
Gemini is good at this — do not read a contract failure into it. The bridge
classifies what it can see, and the three real states are visibly different:

| What the caller hears | Audit row | Real meaning |
|---|---|---|
| `الخدمة مشغولة دلوقتي، جرّب بعد ثواني.` | `upstream_429` `RATE_LIMITED` | a 429, or a throttling body, from the provider |
| `تعذر إكمال هذه الخطوة…` | `bridge_error` `INTERNAL` | anything else, including a provider cooldown |

**Diagnose (the reason is in the audit log, not in the screen):**

```sql
select at, event, error_code, input ->> 'message'
from audit_events where session_id = '<the console session>'
  and event in ('upstream_429','bridge_error') order by at;
```

On 2026-10-18 the Google key was out of free-tier quota, and the sequence was:
`429: Google Generative AI API error (429): You exceeded your current quota` →
`All models failed (1): google/gemini-3.8-flash: Provider google is in cooldown
(rate_limit)` → `… in cooldown (model_not_found)` → `Auth profile
"google:setup-…" is temporarily unavailable`. The first one is the cause; every
later message is the Gateway's cooldown state and lasts as long as it lasts.

**Fix:** none in this repo — wait for the quota window, or point the agent's
`fallbacks` at a provider that has quota. **Do not** conclude from these screens
that the failover model is bad, and do not re-map a cooldown onto the busy
screen: a cooldown is not a rate limit the caller can wait out by retrying in a
few seconds. To confirm the override itself works, check that the error names the
requested model (`google/gemini-3.8-flash`) rather than the primary —
`npm run clinic:model-ab` prints exactly that line for a blocked leg.

## Preflight: "This operation was aborted" / "agent ... timed out"

**What it means:** the check gave up before the gateway finished a cold turn. A
first clinic turn on this machine measured **20–60 s** (model connection, agent
workspace read, tool init), so the old hard-coded 15 s timeout aborted a healthy
gateway. The check now waits `CLINIC_PREFLIGHT_TIMEOUT_MS` (default 120000) and
reports the elapsed ms plus the real HTTP status or error code.

**Diagnose and fix:**

```bash
npm run clinic:preflight                          # PASS, or WARN "slower than the 15 s budget"
CLINIC_PREFLIGHT_TIMEOUT_MS=180000 npm run clinic:preflight
node scripts/preflight.mjs --warmup               # two extra timed turns, so the demo starts hot
```

A `WARN` with a valid screen is not a failure: it is the measured time. A `FAIL`
prints the status or the response body.

## First turn is much slower than the rest (cold start)

**What it means:** two caches are empty. The ASR container loads its whisper model
on the first upload, and the gateway pays its first-turn cost (provider
connection, agent workspace). Neither is a bug, and neither can be removed by
retrying faster.

**Fix:**

```bash
npm run clinic:warmup     # one tiny WAV to the ASR, then one "hi" turn through the bridge
```

It prints both times. Run it after starting the containers and before a demo.

## Console: "ما سمعتش كلام واضح، جرّب تاني" / "I didn't hear anything clear"

**What it means:** the ASR answered successfully with an empty transcript (tone,
silence, or the wrong language). The console never sends an empty turn to the
agent — an empty user message would make the model invent a question.

**Fix:** speak again, and check the recognition language in Settings (default
`ar`). If every upload is empty, the model may still be loading: run
`npm run clinic:warmup` and watch `clinic:stt-probe`.

## Console: "Local via app ASR returned HTTP 504 — ASR_TIMEOUT"

**What it means:** the ASR service accepted the connection but did not answer
within `ASR_TIMEOUT_MS` (default 300000). On a CPU container this is usually a
cold model load, occasionally a wedged container.

**Diagnose:**

```bash
curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" -m 10 http://localhost:8000/v1/models
docker ps                                  # is the Speaches container actually running?
```

`000` after the timeout means the port accepts TCP but no HTTP answer arrives:
restart the container. If `/v1/models` answers but uploads time out, raise
`ASR_TIMEOUT_MS` or pre-load the model with `npm run clinic:warmup`.

## Bridge: HTTP 502 or "Could not reach OpenClaw Gateway"

**What it means:** the app could not get a usable answer from the gateway. The
bridge never fakes a screen for this; it returns the gateway's error.

**Diagnose:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18789/
openclaw gateway            # foreground, so the error is visible
npm run clinic:preflight    # gateway, agent and tools checks
```

A gateway that answers `200` on `/` but fails chat-completions usually has no
`NVIDIA_API_KEY` in its environment (`~/.openclaw/.env`) or the agent entry is not
merged. Check `openclaw agents list`.

## A turn is slow and the console step says where

Open the message's **steps** and read **Bridge timing**:

```
session 1.4 s · context 1.8 s · first event 22.5 s · gateway 24.1 s · total 26.6 s · 0 tool calls
```

- `gateway_first_event_ms` dominates → the model/provider is the cost, not the
  bridge. Compare models with `npm run clinic:model-ab`.
- `context_ms` dominates → the availability prefetch or `clinic_get_info` is slow;
  check the cache TTLs and the database.
- `repair_used: true` → the page answered off-contract and had to be regenerated;
  `npm run clinic:model-ab` reports which turns drift.
- The same numbers are in `audit_events` (`event = 'turn_timing'`), one row per
  turn, numbers only.

## Model A/B refuses the header

`x-clinic-backend-model` is accepted only when the **app server** was started with
`CLINIC_AB_MODEL_OVERRIDE=1`, and only for the two models under test. Restart it:

```bash
CLINIC_AB_MODEL_OVERRIDE=1 npm run dev
npm run clinic:model-ab
```

It changes the backend model for that request only; the agent's own configuration
and the default model are untouched.

## A turn ends with "Failed step: TURN_DEADLINE"

**What it means:** the model had not answered within `CLINIC_TURN_DEADLINE_MS`
(default 60,000 ms), so the bridge aborted the gateway request itself — the
connection closes, the provider stops working on it — and told the caller
`الرد أخد وقت أطول من المسموح (60 ثانية). جرّب تاني.` / `That took longer than
allowed (60 s). Please try again.` Nothing was booked, cancelled or rescheduled
by that turn.

**Diagnose:**

```sql
select at, input from audit_events where event = 'turn_deadline' order by at desc limit 5;
```

`input.elapsed_ms` is the deadline clock (it should be ≈ `deadline_ms`), and
`input.turn_ms` includes session open and the context prefetch. A run of these
rows means the provider is slow, not that the bridge is: compare with
`gateway_first_event_ms` in the `turn_timing` rows, and raise the deadline only if
healthy turns are genuinely slower:

```bash
CLINIC_TURN_DEADLINE_MS=90000 npm run dev
```

The default is 60 s because a cold first turn on this machine measured 51.7 s; a
smaller value aborts turns that would have answered.

## The caller is told "لسه ما اتأكدش حاجة" and the console shows a **Guard** step

**What it means:** that is the confirmation guard doing its job. The reply claimed
a booking, a cancellation or a reschedule — or stated a confirmation code — and
the `audit_events` rows for the same turn and session contain no successful
`confirm_booking` / `reschedule_appointment` / `cancel_appointment` with a
matching `input.result_ref`, so the claim was replaced by the fixed truthful
sentence before the caller heard it.

```sql
select at, outcome, input from audit_events where event = 'blocked_false_confirmation' order by at desc limit 10;
```

`input.pattern` names the rule that fired (`ar_booked`, `en_confirmed`,
`appointment_ref`, `uuid`, …) and `input.codes` counts the unverified codes; the
raw sentence is deliberately not stored. A cluster of these means the model is
drifting towards claiming work it did not do — `npm run clinic:model-ab` scores
it, and the same turn would have been a fabricated booking before the guard
existed. Do not silence it: fix the turn (usually a missing approval or a failed
tool call).
