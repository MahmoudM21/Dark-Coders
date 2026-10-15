# Progress — Clinic Reception agent

Branch: `main`. Last session audited the interrupted work, repaired it, closed
P6 and the amendments, and stopped before P7/P8.

## Done (this session)

| Commit | Phase | What |
|---|---|---|
| `2595274` | P2, P5 | **Repair: the tree did not compile and its tests failed.** Fixed `normalizePhone` (Egyptian `01XXXXXXXXX` was returning `+2001…`; the trunk zero must be dropped → `+201…`). Added an explicit `Envelope` type plus `isErrorEnvelope` and rewired `db.server`/`tools.server`/`escalation.server`/`agent.ts` so error narrowing is real instead of an untyped `"ok" in x` check. Added `.ts` extensions to the clinic imports so Node's type stripping can resolve them. Regenerated `src/routeTree.gen.ts` so `/api/clinic/tools` is a known route. **Verified:** `npm run typecheck` 0 errors, `npm test` 35/35. |
| `a2347a7` | P3 | **Repair: the MCP proxy was broken.** `server.mjs:93` had the literal placeholder `Authorization: \`******,` instead of `Bearer ${CLINIC_TOOLS_TOKEN}`, so every tool call would have been 401. Same placeholder in the `openclaw/README.md` curl. **Verified:** `node --check`; running the proxy with no env exits 1 with the missing-variable message. |
| `5849a39` | P4 | **Repair: `AGENT.md` was truncated** before its `OUTPUT FORMAT` and `Examples` sections (59 of 78 lines), so the model had no JSON contract; all three runtime files were CRLF. Rewrote all three from the `docs/PROMPTS.md` blocks. **Verified:** byte-compare of the committed blobs vs the doc blocks → IDENTICAL, no CRLF. |
| `e82f3bc` | P6 | Registered the clinic agent in `src/lib/settings/voice.ts` (the roster the `set_agent` command validates against), aliased `clinic-receptionist` → `openclaw/clinic-receptionist` in `models.ts` (+ test), extended the `set_agent` help text in `prompt.ts`, and added the *Clinic receptionist · Gemini 3.8 Flash* provider preset. **Verified:** typecheck 0 errors, 35/35 tests. |
| `c3e448d` | Amendments 1/3/4/5 | `.env.example` now names `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (the two the server client actually reads). Added `scripts/preflight.mjs` (`npm run clinic:preflight`), `scripts/webhook-echo.mjs`, `supabase/reset_demo.sql`, `docs/TESTING.md`; preflight and `openclaw/README.md` warn that seed phones/emails are placeholders. **Verified:** `node --check` both scripts, curl GET/POST/400 against the echo server, preflight runs end-to-end. |

Also: `README.md` rewritten for P8 (what was built, the decisions and why, where
AI helped, how to run, known limits, verified vs not) and the stray
`"# Dark-Coders"` trailer removed.

## Status of P1–P8

| Phase | State |
|---|---|
| P0 ground truth | **UNVERIFIED** — needs a running gateway (see below). |
| P1 database | Files complete; **smoke test not run here** (no PostgreSQL in this environment). |
| P2 Booking Service | Implemented, typechecks, unit-tested. Live curl round trip **UNVERIFIED** (no DB). |
| P3 OpenClaw agent/MCP/config | Files delivered and repaired; the proxy runs and refuses to start without env. Agent/gateway behaviour **UNVERIFIED**. |
| P4 Prompts + eval | Prompt files byte-identical. `scripts/eval-conversations.mjs` exists but has **not been run** (needs gateway); it only checks screen parsing today, not the listed behavioural assertions. |
| P5 Bridge | Implemented (a–i). Stretch (i) live tool traces in the Thinking panel: **not implemented**. |
| P6 Console registration | **Done** (this session). |
| P7 Hardening | **Not started.** |
| P8 README + demo | README done; `docs/DEMO.md` and `docs/EXTENSIONS.md` **not written**. |

## Open question — the "13 tools"

Amendment 1 says "13 tools including `select_branch`". `docs/ARCHITECTURE.md`
§6.2 enumerates exactly **12**, and the code, `openclaw.json5` allow-list and the
MCP proxy all implement those 12 including `select_branch`. No 13th tool is named
anywhere in the repo, so nothing was invented. **Needs a decision:** name the 13th
tool, or confirm 12 is the intended number of model-facing tools.

## UNVERIFIED items — exact commands

1. **SQL smoke test (P1, P7).** No PostgreSQL was available (no `psql`, no
   `initdb`; Docker installed but its daemon is not running).
   ```bash
   # needs postgresql-contrib for btree_gist; PG 15+
   export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/clinic_demo"
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/migrations/20261015120000_clinic_reception.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/seed_clinic_demo.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -P pager=off -f supabase/tests/clinic_smoke.sql
   # must end with: == ALL CHECKS PASSED
   ```
2. **Gateway truth (P0).** Needs `OPENCLAW_GATEWAY_URL` + `OPENCLAW_API_KEY`:
   ```bash
   curl -sS "$OPENCLAW_GATEWAY_URL/v1/chat/completions" \
     -H "Content-Type: application/json" -H "Authorization: Bearer $OPENCLAW_API_KEY" \
     -d '{"model":"openclaw/clinic-receptionist","messages":[{"role":"user","content":"what are your opening hours?"}]}'
   ```
   Confirm: is the chat-completions endpoint enabled; does `x-openclaw-session-key`
   isolate a session; does the gateway merge `messages` with the stored transcript
   (the bridge assumes **not** unless `OPENCLAW_GATEWAY_MERGES_HISTORY=1`);
   does `x-openclaw-model: google/gemini-3.8-flash` override; does streaming
   deliver `delta.reasoning_content`.
3. **Live conversation (P4/P5 acceptance).** Needs the gateway + Gemini key +
   the dev server:
   ```bash
   npm run dev
   EVAL_BASE_URL=http://localhost:3000 node scripts/eval-conversations.mjs
   ```
4. **Agent reachability + tools round trip.** `npm run clinic:preflight` with a
   filled `.env`; today it reports `UNVERIFIED` for gateway, agent, tools, ASR.
5. **Speech.** Whisper transcription and Arabic TTS quality are manual-only.
6. **`openclaw/openclaw.json5` key names.** The file says at the top they are
   unverified; check with `openclaw config schema` on the installed version.
7. **DST edge.** Egypt's autumn transition and the 22:00–24:00 slot ambiguity
   (`docs/ARCHITECTURE.md` §10.8) — untested.

## Known defects / caveats

- `scripts/eval-conversations.mjs` is weaker than P4 asks: it checks that each
  reply parses as a screen, but does **not** yet assert "no booking before
  `confirm_booking` succeeded", the emergency same-turn rule, the price-unknown
  rule, the injection case, or that `session_id` is present in every tool call.
  Treat its PASS table as partial.
- The bridge opens a session on **every** clinic request, including the approval
  click interception path — that is intentional (`clinic_open_session` is
  idempotent per session id) but worth re-reading before changing.
- `reset_demo.sql` deletes `audit_events`, which the migration makes append-only
  for `service_role`; it must therefore be run as the migration owner.
- Approval ids must match `apr_[a-z0-9]{12}` for the bridge regex to fire —
  verified in the migration's generator, but re-check if that SQL changes.

## Next session's first action

1. Decide the "13 tools" question above, then either add the missing tool
   across `contracts.ts`, `tools.server.ts`, `openclaw.json5` and the MCP proxy,
   or correct the amendment to 12.
2. Bring up PostgreSQL and run the smoke test; it is the single biggest
   unverified claim in the deliverable. Then P7.1 (DST, held-slot reschedule,
   duplicate approvals, two-session hold race).
3. Then P7.2/P7.3 (API smoke script + bridge failure drill table) and P8
   (`docs/DEMO.md`, `docs/EXTENSIONS.md`).
