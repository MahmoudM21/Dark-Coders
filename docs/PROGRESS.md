# Progress — Clinic Reception agent

Branch: `perf/voice-latency-and-stt` (never merged; `main` is untouched by this
session). The previous session switched the backend model to NVIDIA Nemotron 3
Super and cut bridge-side latency. This session fixes the speech-to-text path,
makes the preflight prove a real turn, instruments every stage of a turn, and
compares Nemotron with the Gemini fallback on the same scripted conversation.

Read first: `docs/ARCHITECTURE.md` (§8 model, §9 bridge), `docs/PROMPTS.md`
(CONTEXT BLOCK + "Runtime files"), `docs/TESTING.md` (§9 is this session's
checks), `docs/TROUBLESHOOTING.md`, `README.md`.

## Session 2026-10-18 — STT, preflight, turn timing, model A/B

| Commit | Task | What |
|---|---|---|
| `595550f` | 1 | **Preflight proves a real turn.** The agent check sent `max_tokens: 1` and no agent header, so it could never accept a screen, and its 15 s timeout aborted a healthy 40–60 s cold turn with a bare "operation was aborted". It now sends `x-openclaw-agent-id`, waits `CLINIC_PREFLIGHT_TIMEOUT_MS` (default 120 s), reports elapsed ms plus the real status/error code, returns PASS / WARN (>15 s, with the time) / FAIL (with the exact reason), and `--warmup` runs two extra timed turns. |
| `fc77edc` | 2 | **ASR through the app.** Root cause of "Failed to fetch" with HTTP 200: the POST response from Speaches carries no `Access-Control-Allow-Origin`, so the browser blocks the response. `Local via app` is now the default ASR mode: `/api/asr` receives the multipart upload same-origin and forwards it to `ASR_BASE_URL` with `ASR_MODEL`, `ASR_LANGUAGE` and `ASR_TIMEOUT_MS`. Structured `{code,message,detail}` errors; empty transcripts are not sent as turns; typed-turn failures name the URL and the likely causes. `clinic:stt-probe` reports status, ACAO and cold/warm ms; `clinic:warmup` loads the model and warms one bridge turn; seven fake-ASR tests. |
| `6384661` | 3–4 | **Turn timing and a model A/B harness.** The bridge measures session open, prefetch, clinic info, first gateway event, gateway total, validation, repair and audit-counted tool calls, sends them as `bridge.timing` (a console step with its time) and stores one `turn_timing` audit row with numbers only. `clinic:latency` prints the breakdown and median/p90 over `CLINIC_LATENCY_RUNS`; `clinic:model-ab` replays one scripted conversation against two backend models through `x-openclaw-model` (whitelisted, off unless `CLINIC_AB_MODEL_OVERRIDE=1`). Also adds the experimental `agent-scoped-delta` history mode (off by default). |
| (this commit) | 4.4 | **Model conformance A/B, eight runs, and a harness that cannot be fooled.** `clinic:model-ab` now attributes each turn's `audit_events` rows by turn window, reads **tool names and outcomes** (never the reply) and checks claims against *successful* calls, so `تم الحجز!` with a failed or absent `confirm_booking` is a FAIL; it also flags mutilated tool arguments, identical repeated calls, Latin text inside Arabic speech, promises of escalation, emergency advice with no `escalate_to_human`, and provider-refused turns as **BLOCKED** (with the reason from the bridge's own `upstream_429` / `bridge_error` row) instead of counting them as conformance failures. Uncounted warm-up turn, opt-in busy replay, and a leg that stops itself when the provider is dead. Result: **Nemotron 3 of 8 to 6 of 8 turns clean, never 8/8, median 8.0–18.9 s**; the English turn was never once answered in English, `identify_patient` got a fragment of the caller's name in 8 of 8 calls, and 3 runs claimed a booking that nothing confirmed. **Gemini could not be measured at all** — the Google free-tier quota is spent (see §9.10 for the message sequence and the direct-gateway proof that the override itself works). |

Measured on this machine (2026-10-18, live gateway, app on `:8080`):

| Check | Result | Evidence |
|---|---|---|
| `npm run typecheck` | **PASS** | 0 errors. |
| `npm test` | **PASS** | 108 tests, 0 fail (25 suites), including 7 new fake-ASR tests. |
| `npm run check:prompts` | **PASS** | 3 of 3 byte-identical. |
| `npm run clinic:preflight` | **PASS** | 7 passed, 0 failed, 5 warnings: the agent turn is valid screen JSON but 20–52 s, so WARN by design. |
| `preflight --warmup` | **PASS** | Two extra turns: 22,938 ms and 32,073 ms, both valid screens. |
| Console typed turn | **PASS** | Answer in 27.3 s; steps showed `session 1.4 s · context 1.8 s · first event 22.5 s · gateway 24.1 s · total 26.6 s · 0 tool calls`. |
| `turn_timing` audit row | **PASS** | Present with the same numbers; tool calls 0. |
| `npm run clinic:stt-probe` | **UNVERIFIED as a CORS measurement** | Port 8000 accepts TCP but answers no HTTP at all right now (all eight calls timed out, `docker ps` lists no container), so there is no POST response to inspect. The probe printed that rather than guessing. |
| Think on the wire | **UNVERIFIED** | `openclaw config get` returns `thinkingDefault: off` and `params.thinking: off` + `enable_thinking: false`; no request-body log exists to observe the wire itself. |
| Model conformance A/B | **see §9.10** | 8 identical turns per model through the real bridge; Nemotron measured 8×, Gemini **UNVERIFIED** (provider quota spent, override proven). |

The next section is the previous session's record and is kept as history.

## Done (previous session)

| Commit | Task | What |
|---|---|---|
| `d4bd05d` | 1 | **Model switch, config and docs only.** `openclaw/openclaw.json5` now pins the agent to `nvidia/nvidia/nemotron-3-super-120b-a12b` (build.nvidia.com, OpenAI-compatible) with `chat_template_kwargs.enable_thinking = false` under `agents.defaults.models[…] .params` and `thinkingDefault: "off"`, and lists `google/gemini-3.8-flash` as the agent's own failover (used only when NVIDIA errors or 429s). `NVIDIA_API_KEY` documented as a **gateway** variable (`~/.openclaw/.env`), never an app one; `.env.example`, `openclaw/README.md`, `README.md`, `docs/ARCHITECTURE.md` §8, `docs/PROMPTS.md`, `docs/TESTING.md` and `scripts/preflight.mjs` reworded. `grep -ri gemini` now returns only intentional failover mentions. A/B recipe by `x-openclaw-model` header added to `openclaw/README.md`. |
| `dfb9d86` | 2 | **Availability prefetch.** New idempotent migration `supabase/migrations/20261016000000_clinic_prefetch.sql`: `clinic_prefetch_availability(p_session, p_days=2, p_limit=5)` returns, per branch, the next free slots (via `clinic_search_slots` with the tenant's single visit type), each formatted with `clinic_fmt_local` in that branch's timezone, plus doctor/branch refs and names, `generated_at` and `valid_for_seconds` 60. Read-only, `revoke`d from public/anon/authenticated and granted to `service_role` (the original grant loop only covered the functions that existed then, so the new one is granted explicitly). Bridge: `clinic_get_info` cached per tenant+branch for 5 minutes, `clinic_open_session` and the prefetch in `Promise.all`, snapshot refreshed only when older than 60 s, injected as a data-only advisory system message, failure logged as `prefetch_failed` and the turn continues **without** it. One hard rule added identically to `docs/PROMPTS.md` and `openclaw/agents/clinic-receptionist/AGENTS.md` (byte-identity re-verified with `cmp`). Unit tests for the cache TTL, the snapshot-age decision and the message formatting with injected clocks. |
| `99c59ca` | 3 | **Spoken filler.** `src/lib/voice/filler.ts` + wiring in `src/routes/index.tsx`: voice turns only, only with voice replies on, one filler per turn after `FILLER_DELAY_MS = 1200`, Arabic phrases for Arabic input and English otherwise, spoken through the existing TTS path, aborted by the real answer. It is not a message: never in the transcript, in `turns`, or in saved history. Pure-function tests plus `node:test` mock-timer tests (36 assertions over 14 tests). |
| `169f0cb` | 4 | **Connection-reuse audit — nothing to fix.** Findings table in `docs/ARCHITECTURE.md` §8.1 (`new Agent`, `Connection: close`, undici dispatchers, per-call clients in `src/lib/clinic/*`, `src/routes/api/agent.ts`, `src/lib/ai/*`, `openclaw/mcp/clinic/server.mjs`). `supabaseAdmin` is already a module-level lazy singleton, every handler imports it rather than building its own, and the gateway calls use the global `fetch` (no dispatcher, no `Connection: close`), so undici keeps the socket alive between turns. No code change, no pooling library. The one cost not measurable from here is undici's ~4 s idle keep-alive on the gateway socket. |
| `4e25c99` | 5 | **Spoken-text sanitisation.** Pure `sanitizeSpoken(text)` applied to `screen.text`, choice labels and values before schema validation: strips emoji/pictographs/variation selectors/ZWJ/keycaps/flags and markdown (bold, code, headings, list markers, links → their text), collapses whitespace, and leaves Arabic (with tashkeel), Arabic punctuation, digits, `4:30` and `123` untouched. Empty after sanitising ⇒ invalid screen ⇒ repair path. 42 assertions over 10 tests, covering every case the brief named (😊 ✅ 👍🏽 🇪🇬 1️⃣, `**bold**`, `` `code` ``, `# title`, Arabic with tashkeel, `الساعة 4:30`, `123`) plus flags, ZWJ sequences, links, list markers and whitespace collapse; `scripts/eval-conversations.mjs` gained a "no emoji / no markdown in any reply" assertion. |
| `ccc6a4b` | 6 | **Rate-limit resilience.** Bridge maps an upstream 429 to at most ONE retry, and only when `Retry-After` is present and ≤ 2 s; otherwise a valid screen in the session locale (`الخدمة مشغولة دلوقتي، جرّب بعد ثواني.`) with `navigation: ["home"]`, plus an `audit_events` row (actor `bridge`, event `upstream_429`) — never a fake booking. The runtime prompt in both copies now calls `add_note(kind="summary")` only after a booking/cancellation/reschedule actually succeeded or after an escalation. Fake-upstream tests for the mapping. |
| `b967605` | 7a | **Latency probe.** `scripts/latency-probe.mjs` (`npm run clinic:latency`) drives four voice-like turns through the real `/api/agent` bridge and prints ms-to-first-reasoning, ms-to-answer and the clinic tool calls counted from `audit_events`. |
| (this commit) | 7b–7d | **Verification and docs.** See the table below. Two defect fixes: the probe counted `audit_events.created_at`, which **does not exist** (the column is `at`) so the tool-call column was always `n/a`; and it printed a table when every turn had been answered by the bridge's error path, i.e. numbers that were not model latency. It now refuses in that case (exit 2, no table) and marks partial failures row by row. The same wrong column name in four copy-pasteable operator queries in `docs/TESTING.md`, `docs/DEMO.md` and `docs/EXTENSIONS.md` was corrected. |

## Verification (2026-10-17, previous session)

| Check | Result | Evidence |
|---|---|---|
| `npm run typecheck` | **PASS** | 0 errors, `tsc --noEmit`. |
| `npm test` | **PASS** | 93 tests, 0 fail (22 suites). |
| `npm run clinic:mcp-smoke` | **PASS** | MCP handshake, 13 tools, bearer header, forwarding. |
| `npm run clinic:api-smoke` (dev server + Supabase) | **PASS** | 78 passed, 0 failed. |
| SQL suite incl. section N | **PASS** | `== ALL CHECKS PASSED`. |
| DB left clean and seeded | **PASS** | 0 call-data rows; 12 `branch_hours` Sat–Thu 16:00–24:00; Saturday 14 slots/branch; Friday 0. |
| Gateway-unreachable path | **PASS** | Truthful Arabic screen, `bridge_error` audit row, no crash, probe refuses. |
| Prompt byte-identity | **PASS** | `cmp` clean, LF preserved. |
| Nemotron Arabic + tool-calling quality | **UNVERIFIED** | Needs a live gateway (§9.1, §9.5). |
| Filler heard in a browser | **UNVERIFIED** | Needs a microphone (§9.2). |
| `openclaw.json5` key names vs installed version | **UNVERIFIED** | Needs `openclaw config schema`. |

## UNVERIFIED items — exact commands

1. **The model switch end to end (task 1, the biggest unknown).** Merge
   `openclaw/openclaw.json5` into `~/.openclaw/openclaw.json`, put
   `NVIDIA_API_KEY` in `~/.openclaw/.env` (gateway only), then:
   ```bash
   openclaw config schema        # confirm agents.entries / agents.defaults.models keys
   openclaw agents list          # the clinic-receptionist line must name the NVIDIA ref
   openclaw gateway
   ```
   Then the A/B curl pair in `openclaw/README.md` §2 — the `x-openclaw-model`
   override and the Gemini failover are both unproven from this checkout.
2. **The Gemini leg of the model A/B (blocked today, not failing).** The Google
   free-tier quota is spent, so the whole second leg is BLOCKED with the reason
   recorded from the bridge's own audit row. When the key has quota again:
   ```bash
   CLINIC_AB_MODEL_OVERRIDE=1 npm run dev        # terminal 1
   npm run clinic:model-ab                       # terminal 2 — both legs
   psql "$DATABASE_URL" -f supabase/reset_demo.sql   # needs psql; not installed here
   ```
   A leg that is still refused prints BLOCKED with the provider's message and
   contributes nothing to the contract numbers — that is the intended outcome,
   not a failure to fix.
3. **Latency, Nemotron vs Gemini.**
   ```bash
   npm run dev                                   # terminal 1
   CLINIC_LATENCY_LABEL=nemotron npm run clinic:latency
   # point the agent at google/gemini-3.8-flash, restart the gateway:
   CLINIC_LATENCY_LABEL=gemini npm run clinic:latency
   ```
   Paste both tables into `docs/TESTING.md` §9.5. (If your dev server is not on
   port 3000, add `CLINIC_API_URL=http://localhost:<port>`.)
4. **The "available times" turn needs no tool call** — `docs/TESTING.md` §9.1:
   prove it from `audit_events` (`select at, actor, event, tool, outcome,
   latency_ms from audit_events where session_id = '<id>' order by at`).
5. **The filler** — `docs/TESTING.md` §9.2: set `FILLER_DELAY_MS = 1` in
   `src/lib/voice/filler.ts`, hold the mic, speak Arabic; it must play once, not
   appear in the transcript, and never overlap the answer.
6. **No emoji or markdown in anything spoken** — `docs/TESTING.md` §9.3.
7. **Missing key / rate limit honesty** — `docs/TESTING.md` §9.4.
8. **Live conversation eval.** `EVAL_BASE_URL=http://localhost:3000 node scripts/eval-conversations.mjs`
9. **Speech quality.** Whisper transcription and Arabic TTS are manual-only.
10. **`docs/ARCHITECTURE.md` §10.8 DST edge**, partly guarded by smoke section L.

## Known risks

- **Nemotron's conformance is now measured, and it drifts in specific ways.**
  Eight scripted runs (`docs/TESTING.md` §9.10): 3–6 of 8 turns clean, never 8/8.
  The English turn was never answered in English (Arabic 6 runs, prose-instead-of-
  JSON 2); `identify_patient` received a fragment of the caller's name (`"مع"` for
  `محمد علي`) in every run; 3 runs claimed a booking that no `confirm_booking` row
  supports, one of them while `confirm_booking` had returned `APPROVAL_PENDING`;
  one run made **zero** tool calls for the whole conversation while every screen
  looked plausible. The repair path fired in 4 of 8 runs, and 4 of its 5 attempts
  failed to fix the reply — the caller then hears the generic screen after real
  work has already happened, which is honest but slow. Until the runtime prompt is tightened, treat a
  spoken confirmation as unverified unless `audit_events` has the row.
- **A stale availability snapshot** is bounded by design: it is advisory only and
  is refreshed after 60 s, and `hold_slot` is authoritative, so the worst case is
  an agent offering a slot that then fails to hold and offering another.
- **The prefetch costs one extra DB call per session**, done in parallel with
  `clinic_open_session`, and is read-only.
- **The filler is client-side only**, so a browser tab that is backgrounded may
  not speak; it never blocks or delays the answer.
- **`NVIDIA_API_KEY` must never reach the app.** It belongs in the gateway
  environment; the app only talks to the gateway.
- **The failover is a config claim, not a tested path.** `google/gemini-3.8-flash`
  exists in `openclaw.json5` as the agent's fallback, but a native agent primary is
  strict in OpenClaw and the failover has not been observed firing. Its own quota
  is spent, so it has produced no tokens at all in any run — see §9.10.

## Next session's first action

1. Decide what to do about the three measured Nemotron defects: the English turn
   (a language rule the prompt does not enforce), the truncated `full_name`, and
   confirmations spoken without a successful `confirm_booking`. The first two are
   prompt material (`docs/PROMPTS.md` **and** `openclaw/agents/clinic-receptionist/
   AGENTS.md` together, then `npm run check:prompts`); the third is a bridge guard:
   refuse to speak a "booked" screen when no successful `confirm_booking` row
   exists in the turn.
2. Re-run `npm run clinic:model-ab` for both legs once the Google key has quota —
   the Gemini leg is BLOCKED today, not failing. `npm run clinic:latency` twice
   (Nemotron, Gemini) still fills `docs/TESTING.md` §9.5.
3. Then the human voice script in `docs/TESTING.md` §9.2–§9.4 (filler, no emoji,
   honesty under 429).
4. Then decide whether `find_doctor` should be named in the runtime prompt —
   edit `docs/PROMPTS.md` and `AGENTS.md` in the same commit or the byte-identity
   check breaks.
