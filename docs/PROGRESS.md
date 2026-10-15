# Progress — Clinic Reception agent

Branch: `main`. This session audited the interrupted work, repaired it, closed
P6, the amendments and most of P7/P8, and stopped before the one thing that needs
PostgreSQL.

## Done (this session)

| Commit | Phase | What |
|---|---|---|
| `2595274` | P2, P5 | **Repair: the tree did not compile and its tests failed.** Fixed `normalizePhone` (Egyptian `01XXXXXXXXX` returned `+2001…`; the trunk zero must be dropped → `+201…`). Added an explicit `Envelope` type plus `isErrorEnvelope`, and rewired `db.server`/`tools.server`/`escalation.server`/`agent.ts` so error narrowing is real instead of an untyped `"ok" in x` check. Added `.ts` extensions to the clinic imports so Node's type stripping resolves them. Regenerated `src/routeTree.gen.ts` so `/api/clinic/tools` is a known route. |
| `a2347a7` | P3 | **Repair: the MCP proxy was broken.** `server.mjs` had the literal placeholder `Authorization: \`******,` instead of `Bearer ${CLINIC_TOOLS_TOKEN}`, so every tool call would have been 401. Same placeholder in the README curl. |
| `5849a39` | P4 | **Repair: `AGENT.md` was truncated** before its `OUTPUT FORMAT` and `Examples` sections (59 of 78 lines), so the model had no JSON contract; all three runtime files were CRLF. Rewrote them from the `docs/PROMPTS.md` blocks. |
| `e82f3bc` | P6 | Registered the clinic agent in `src/lib/settings/voice.ts` (the roster `set_agent` validates against), aliased `clinic-receptionist` in `models.ts` (+ test), extended the `set_agent` help text, added the *Clinic receptionist · Gemini 3.8 Flash* provider preset. |
| `c3e448d` | Amendments 3–5 | `.env.example` now names `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`. Added `scripts/preflight.mjs` (`npm run clinic:preflight`), `scripts/webhook-echo.mjs`, `supabase/reset_demo.sql`, `docs/TESTING.md`; preflight and `openclaw/README.md` warn that seed phones/emails are placeholders. |
| `fabe385` | P8 | Rewrote the root README (what was built, decisions and why, where AI helped, how to run, limits, verified vs not) and started this file. |
| `835436f` | P3 | Committed the MCP proxy lockfile so it installs reproducibly. |
| `45c7d0a` | **Amendment 1** | Added the 13th tool, `find_doctor`, end to end (SQL, contracts, dispatcher, proxy schema, allow-list, spec, tests). |
| `45c7d0a` | P3 | **Found and fixed a silent startup crash:** `server.tool()` was passed a `z.object(...)` schema, which this MCP SDK rejects at registration ("expected a Zod schema or ToolAnnotations"), so the proxy died on start. It now passes Zod raw shapes. Added `npm run clinic:mcp-smoke`. |
| `4f4b08f` | P7.1, P7.2 | Extended `clinic_smoke.sql` (duplicate approvals, two-session hold handover, DST invariants) with no weakened assertions; added `scripts/clinic-api-smoke.mjs` (`npm run clinic:api-smoke`). |
| (this commit) | P8 | `docs/DEMO.md` and `docs/EXTENSIONS.md`. |

## Status of P1–P8

| Phase | State |
|---|---|
| P0 ground truth | **UNVERIFIED** — needs a running gateway (commands below). |
| P1 database | Files complete; **smoke test not executed here** (no PostgreSQL). |
| P2 Booking Service | Implemented, typechecks, unit-tested. Live round trip scripted but **not executed** (no DB). |
| P3 OpenClaw agent/MCP/config | Proxy **verified** by `clinic:mcp-smoke` (handshake, 13 tools, bearer header, forward). Agent/gateway behaviour **UNVERIFIED**. |
| P4 Prompts + eval | Prompt files byte-identical. `scripts/eval-conversations.mjs` **still not run** and still weaker than P4 asks (see defects). |
| P5 Bridge | Implemented (a–i). Stretch (i) live tool traces: **not implemented** — sketch in `docs/EXTENSIONS.md` §5. |
| P6 Console registration | **Done.** |
| P7 Hardening | 1 and 2 **written** (unrun SQL); 3 (bridge failure drill table) **not done**. |
| P8 README + demo | README, `docs/DEMO.md`, `docs/EXTENSIONS.md` **done**. |

## Decisions taken

- **The 13th tool is `find_doctor`** (confirmed with the requester). Read-only,
  tier T0, no branch required — naming a dentist is one of the ways a caller picks
  a branch. Matches slug, name substring or any single name word, in Arabic or
  English; `NOT_FOUND` with the query echoed back rather than a guess.
- **`AGENT.md` was NOT edited to mention it**, because it must stay byte-identical
  to the "Runtime files" block in `docs/PROMPTS.md`. Follow-up below.

## UNVERIFIED items — exact commands

1. **SQL smoke test (P1, P7.1).** No PostgreSQL and no running Docker daemon here.
   ```bash
   # postgresql-contrib required for btree_gist; PG 15+
   export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/clinic_demo"
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/migrations/20261015120000_clinic_reception.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f supabase/seed_clinic_demo.sql
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -P pager=off -f supabase/tests/clinic_smoke.sql
   # must end with: == ALL CHECKS PASSED
   ```
   Sections K and L are **new and never executed**. If either fails, fix the SQL
   or the assertion — do not delete it.
2. **API smoke (P2, P7.2).** Needs the dev server and a database:
   ```bash
   npm run dev
   # with .env filled in:
   npm run clinic:api-smoke
   ```
3. **Gateway truth (P0).**
   ```bash
   curl -sS "$OPENCLAW_GATEWAY_URL/v1/chat/completions" \
     -H "Content-Type: application/json" -H "Authorization: Bearer $OPENCLAW_API_KEY" \
     -d '{"model":"openclaw/clinic-receptionist","messages":[{"role":"user","content":"what are your opening hours?"}]}'
   ```
   Confirm: chat-completions enabled; `x-openclaw-session-key` isolates a session;
   whether the gateway **merges `messages` with the stored transcript** (the bridge
   assumes not unless `OPENCLAW_GATEWAY_MERGES_HISTORY=1`); whether
   `x-openclaw-model: google/gemini-3.8-flash` overrides; whether
   `delta.reasoning_content` arrives.
4. **Live conversation (P4/P5).** `EVAL_BASE_URL=http://localhost:3000 node scripts/eval-conversations.mjs`
5. **Preflight with a filled `.env`**: `npm run clinic:preflight`.
6. **Speech.** Whisper transcription and Arabic TTS quality are manual-only.
7. **`openclaw/openclaw.json5` key names.** The file says at the top they are
   unverified; check against the installed version (`openclaw config schema`).
8. **DST.** `docs/ARCHITECTURE.md` §10.8; now partly guarded by smoke section L,
   which has not run.

## Known defects / caveats

- `scripts/eval-conversations.mjs` is weaker than P4 asks: it checks that each
  reply parses as a screen, but does **not** assert "no booking before
  `confirm_booking` succeeded", the emergency same-turn rule, the price-unknown
  rule, the injection case, or that `session_id` is present in every tool call.
  Treat its PASS table as partial.
- The MCP proxy registers every tool with the description `Clinic tool: <name>`.
  That is thin context for a model choosing a tool; real one-line descriptions
  would help the agent, and `find_doctor` is the clearest candidate.
- The bridge opens a session on every clinic request, including the approval-click
  interception path. That is intentional (`clinic_open_session` is idempotent per
  session id) but worth re-reading before changing.
- `reset_demo.sql` deletes `audit_events`, which the migration makes append-only
  for `service_role`; it must be run as the migration owner.
- The approval regex requires `apr_[a-z0-9]{12}` while the DB generator emits
  lower-case hex (`apr_[a-f0-9]{12}`). The regex is a superset, so it matches —
  but if either side changes, re-check (`clinic_smoke.sql` asserts the id shape).
- `docs/PROMPTS.md` and `openclaw/agents/clinic-receptionist/AGENT.md` do not
  mention `find_doctor`. If you want it in the prompt, edit **both** in the same
  commit or the byte-identity check breaks.

## Next session's first action

1. Bring up PostgreSQL (`postgres:16` has `btree_gist`) and run the smoke test
   above. Sections K and L are new; everything else was passing before this
   session and only the migration changed.
2. Then `npm run clinic:api-smoke` against a running dev server, and P7.3 — the
   bridge failure drill table in `docs/TESTING.md` §5 with observed behaviour.
3. Then decide whether to update `docs/PROMPTS.md` + `AGENT.md` together to name
   `find_doctor` in the runtime prompt.
