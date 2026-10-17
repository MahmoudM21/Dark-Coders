# Progress — Clinic Reception agent

Branch: `perf/nemotron-latency` (never merged; `main` is untouched by this
session). This session switched the agent's backend model to NVIDIA Nemotron 3
Super and cut the perceived latency of a voice turn, without changing the console
JSON contract or any non-clinic model path.

Read first: `docs/ARCHITECTURE.md` (§8 model, §9 bridge), `docs/PROMPTS.md`
(CONTEXT BLOCK + "Runtime files"), `docs/TESTING.md` (§9 is this session's
checks), `README.md`.

## Done (this session)

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

## Verification (2026-10-17, this checkout)

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
2. **Latency, Nemotron vs Gemini.**
   ```bash
   npm run dev                                   # terminal 1
   CLINIC_LATENCY_LABEL=nemotron npm run clinic:latency
   # point the agent at google/gemini-3.8-flash, restart the gateway:
   CLINIC_LATENCY_LABEL=gemini npm run clinic:latency
   ```
   Paste both tables into `docs/TESTING.md` §9.5. (If your dev server is not on
   port 3000, add `CLINIC_API_URL=http://localhost:<port>`.)
3. **The "available times" turn needs no tool call** — `docs/TESTING.md` §9.1:
   prove it from `audit_events` (`select at, actor, event, tool, outcome,
   latency_ms from audit_events where session_id = '<id>' order by at`).
4. **The filler** — `docs/TESTING.md` §9.2: set `FILLER_DELAY_MS = 1` in
   `src/lib/voice/filler.ts`, hold the mic, speak Arabic; it must play once, not
   appear in the transcript, and never overlap the answer.
5. **No emoji or markdown in anything spoken** — `docs/TESTING.md` §9.3.
6. **Missing key / rate limit honesty** — `docs/TESTING.md` §9.4.
7. **Live conversation eval.** `EVAL_BASE_URL=http://localhost:3000 node scripts/eval-conversations.mjs`
8. **Speech quality.** Whisper transcription and Arabic TTS are manual-only.
9. **`docs/ARCHITECTURE.md` §10.8 DST edge**, partly guarded by smoke section L.

## Known risks

- **Nemotron's Arabic and its JSON/tool-call reliability are untested.** Everything
  downstream — the screen contract, the repair path, the prompt's rules — is
  exercised only against the unit tests and the API smoke until the eval and the
  human script in `docs/TESTING.md` §9 run on a live gateway. If Nemotron drifts
  off-format, the repair path fires and the caller hears "that step could not be
  completed", which is honest but slow.
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
  strict in OpenClaw and the failover has not been observed firing.

## Next session's first action

1. Bring up the gateway with `NVIDIA_API_KEY` and run the A/B pair in
   `openclaw/README.md` §2 — that settles the whole model-switch question.
2. Then `npm run clinic:latency` twice (Nemotron, Gemini) and paste the tables
   into `docs/TESTING.md` §9.5; that is the number the task asked for.
3. Then the human voice script in `docs/TESTING.md` §9.2–§9.4 (filler, no emoji,
   honesty under 429).
4. Then decide whether `find_doctor` should be named in the runtime prompt —
   edit `docs/PROMPTS.md` and `AGENTS.md` in the same commit or the byte-identity
   check breaks.
