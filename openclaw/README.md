# OpenClaw runtime package for Clinic Reception

Everything needed to run the `clinic-receptionist` agent on an installed OpenClaw
gateway: a config fragment, the agent instructions, two skills, and a stdio MCP
proxy that forwards tool calls to the booking service in this repo.

---

## 1) Environment

Set these in the **gateway** environment (`~/.openclaw/.env`, or the shell/service
that starts the gateway):

| Variable | Purpose |
| --- | --- |
| `NVIDIA_API_KEY` | Gateway only. Auto-enables the `nvidia` provider. Primary model. |
| `GEMINI_API_KEY` | Gateway only, optional. Only used by the failover. |
| `CLINIC_API_URL` | Base URL of this app, e.g. `http://localhost:3000`. |
| `CLINIC_TOOLS_TOKEN` | Bearer token the MCP proxy sends to `/api/clinic/tools`. |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `CLINIC_TENANT_SLUG` | Read by the app, not the gateway. |

`NVIDIA_API_KEY` and `GEMINI_API_KEY` never belong in this repo, in the console's
`.env`, in a prompt, or in git. `CLINIC_API_URL` / `CLINIC_TOOLS_TOKEN` are not
written into the config either: the fragment references them as `${CLINIC_API_URL}`
and `${CLINIC_TOOLS_TOKEN}`, which OpenClaw substitutes from the gateway process
environment when it loads the config.

> A missing `${VAR}` stays visibly unresolved, logs a warning, and is unavailable
> to the consumer. The MCP proxy exits with
> `Missing required environment variables: CLINIC_API_URL and CLINIC_TOOLS_TOKEN`
> — check the gateway log if the clinic tools disappear.

---

## 2) What this revision changed, and why

The previous `openclaw.json5` was written from doc pages for an older release.
Rewritten against the **installed** OpenClaw — `2026.10.4 (383c124)` — and checked
three ways: the 2.4 MB `openclaw config schema` output, the docs shipped inside the
package (`node_modules/openclaw/docs/`), and the CLI itself.

**Corrections that would have silently disabled features:**

| Was | Now | Why |
| --- | --- | --- |
| `openclaw/agents/…/AGENT.md` | `AGENTS.md` | OpenClaw injects `AGENTS.md` (plural) from the workspace. The old name was never read; the agent would have run with a "missing file" marker instead of its instructions. |
| `mcp.clinic.get_clinic_info` | `clinic__get_clinic_info` | MCP tools are `<safe-server>__<safe-tool>`. The old names matched nothing. |
| `skills.directory` | *(removed)* | Not a key. The root `skills` object has `allowBundled`/`load`/`install`/`limits`/`workshop`/`entries`; extra roots go in `skills.load.extraDirs`. |
| `"session.*"`, `"messaging.*"` in `deny` | `group:sessions`, `group:messaging` | Tool ids are `sessions`, `sessions_list`, `session_status`, `message`. `session.*` matched nothing. |
| `models.providers.nvidia` block | *(removed)* | The provider auto-enables when `NVIDIA_API_KEY` is set, and `nvidia/nvidia/nemotron-3-super-120b-a12b` is a bundled catalog row. The block was unnecessary surface. |
| *(absent)* | `agents.ownership: "explicit"` | **Required.** Adding a second agent makes the roster multi-agent, and validation rejects that without the marker (see §3). |

### Key-by-key evidence

Confirmed against the installed version:

| Key | Evidence |
| --- | --- |
| `agents.entries.<id>` + `workspace`, `agentDir`, `model`, `models`, `thinkingDefault`, `skills`, `tools` | `openclaw config schema` → `agents.entries` object props |
| `agents.ownership` | schema `const: "explicit"`; enforced by `openclaw config validate` |
| `model: { primary, fallbacks }` | schema `anyOf: [string, {primary, fallbacks[]}]`, `additionalProperties: false` |
| `agents.entries.*.models["<ref>"].params` | schema (free-form); `docs/gateway/config-agents/models.md` merge precedence: defaults.params → defaults.models[ref].params → entries.*.models[ref].params → entries.*.params |
| `thinkingDefault: "off"` | schema enum includes `off`; `docs/tools/thinking.md` resolution order (level 3, above model `params.thinking`) |
| `params.thinking` | `docs/tools/thinking.md`; `docs/gateway/config-agents/models.md` |
| `params.chat_template_kwargs` | `docs/gateway/config-agents/models.md` — "merged into top-level `api: "openai-completions"` request bodies"; `docs/providers/nvidia.md` |
| `tools.allow` / `deny`, `group:*`, deny-wins, intersection | `docs/gateway/config-tools/tool-policy.md`, `docs/tools/multi-agent-sandbox-tools.md` |
| MCP tool naming `clinic__<tool>` | `docs/tools/multi-agent-sandbox-tools.md` |
| `mcp.servers.<name>` = `transport`/`command`/`args`/`cwd`/`env`/`enabled` | schema; `transport` enum `stdio`/`sse`/`streamable-http`; `docs/tools/mcp.md` |
| `${VAR}` substitution in any config string | `docs/gateway/config-secrets-env.md`, which uses an MCP `env` example |
| `gateway.http.endpoints.chatCompletions.enabled` | schema boolean, "default: false" |
| `google/gemini-3.8-flash` is resolvable | `openclaw models list --refresh` lists it (text+image+video, 1049k, auth yes) |
| `nvidia/nvidia/nemotron-3-super-120b-a12b` | bundled catalog row (`docs/providers/nvidia.md`), listed as `default,configured` |

**UNVERIFIED — needs your running gateway:**

- That the MCP server actually advertises the 13 tool names at runtime, so the
  allowlist matches. Prove it with `openclaw mcp probe clinic`.
- That the allow/deny intersection really leaves only those tools. Prove it by
  asking the agent to run a shell command and checking it is refused.
- That thinking is genuinely off for this model on NVIDIA's endpoint (no
  `reasoning_content` before the answer).
- That `${CLINIC_API_URL}` / `${CLINIC_TOOLS_TOKEN}` resolve (needs them in the
  gateway environment).
- That the Gemini failover actually trips on a 429.
- Whether `${VAR}` substitution is applied to `mcp.servers.*.env` at *runtime*
  as well as at load. The docs say "any config string"; the schema only constrains
  the value to a string. `openclaw mcp probe clinic` is the deciding test: if the
  child process reports missing env vars, put the two values in `~/.openclaw/.env`
  and reference them bare.

---

## 3) `agents.ownership` — read this before merging

Adding `clinic-receptionist` next to `main` makes the roster multi-agent, and
OpenClaw refuses such a config without a generation marker:

```
agents.ownership: multi-agent rosters require agents.ownership="explicit" or one
legacy default=true marker; add agents.ownership="explicit" or run openclaw doctor
```

The fragment sets it. The consequence is deliberate and worth knowing: **ambient**
surfaces — channels, heartbeat, system-agent consults, Talk, cron, and bare CLI
operations — must now resolve a surface-specific owner or fail closed. The console
is unaffected because it names the agent explicitly in the model string
(`openclaw/clinic-receptionist`). If you route a channel to an agent later, add a
`bindings` entry; the sole-agent fallback no longer applies.

### Bridge session modes

The bridge sends `x-openclaw-agent-id: clinic-receptionist` by default and does
not send a session key. This is intentionally stateless at the Gateway: the
bridge already sends the recent console turns in `messages`, so the Gateway
does not need to load a stored transcript and risk duplicating that context.

To use Gateway-owned session continuity instead, set `CLINIC_GATEWAY_SESSION=agent-scoped`
in the app environment. The bridge then sends
`x-openclaw-session-key: agent:clinic-receptionist:clinic-<consoleSessionId>`.
Do not use the old unscoped `clinic:<consoleSessionId>` form.

The installed OpenClaw 2026.10.4 docs (`docs/gateway/openai-http-api.md`) say
that Chat Completions is stateless per request unless `user` or
`x-openclaw-session-key` is supplied. The installed endpoint implementation
also converts every supplied `messages` entry into the current agent prompt,
while a session key separately selects the Gateway's stored session. That
means sending the full bridge history in agent-scoped mode can duplicate
context; the bridge's `OPENCLAW_GATEWAY_MERGES_HISTORY=1` switch sends only the
latest user turn for that mode.

---

## 4) Merge the fragment (PowerShell)

`scripts/merge-openclaw-config.mjs` deep-merges the fragment into
`%USERPROFILE%\.openclaw\openclaw.json`. It only writes paths it owns
(`agents.ownership`, `agents.entries.clinic-receptionist`, `mcp.servers.clinic`,
`gateway.http.endpoints.chatCompletions.enabled`); everything else — including
`gateway.auth.token`, `plugins`, and `agents.entries.main` — is preserved. It
writes a timestamped backup first, validates the merged result against the
installed schema, and refuses to write if validation fails.

Always dry-run first:

```powershell
cd C:\path\to\living-ai-talk

# 1. Show the diff and the validation result. Writes nothing.
npm run clinic:openclaw-merge -- --dry-run
```

Read the diff. It prints `+` additions, `~` changes, `!` existing values it
deliberately kept, and every secret as `***redacted***`. Then apply:

```powershell
# 2. Back up and write.
npm run clinic:openclaw-merge
```

```powershell
# 3. Restart the gateway so it reloads the config.
openclaw gateway restart

# 4. Health check.
openclaw gateway status
openclaw doctor
```

If `doctor` reports anything about the agent roster or a model ref, fix it before
going further. Then confirm the agent and its tools exist:

```powershell
openclaw agents list
openclaw mcp doctor clinic
openclaw mcp probe clinic
```

`mcp probe` is the one that matters: it must show the 13 `clinic__*` tools. If the
server fails to start, `mcp doctor` names the reason (almost always a missing
`CLINIC_API_URL` / `CLINIC_TOOLS_TOKEN`, or `node` not being on the gateway's PATH).

### Restore, if you need to

```powershell
Get-ChildItem $HOME\.openclaw\openclaw.json.bak-clinic-* | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Copy-Item <that path> $HOME\.openclaw\openclaw.json
openclaw gateway restart
```

### Options

| Flag | Effect |
| --- | --- |
| `--dry-run` | Print the diff and validation result; write nothing. |
| `--no-validate` | Skip schema validation. The parse round-trip still runs. |
| `--config <path>` | Merge into a different file (used by the tests). |
| `--fragment <path>` | Merge a different fragment. |
| `--workspace <path>` | Where to copy `AGENTS.md` + skills. |
| `--no-sync-workspace` | Don't copy the workspace files. |

The script also copies `openclaw/agents/clinic-receptionist/AGENTS.md` and the two
skills into the agent workspace (`~/.openclaw/workspace-clinic` by default), because
OpenClaw reads `AGENTS.md` from the workspace and scans `<workspace>/skills` first.
Creates are shown in the diff; unchanged files are left alone.

---

## 5) The agent's tools are locked down

The agent runs on the global `tools.profile: "full"`, so its own policy is what
restricts it. An agent-level allowlist **intersects** every earlier layer and deny
always wins, so `allow` alone limits the agent to the 13 clinic tools. `deny` is
belt-and-braces across `group:runtime`, `group:fs`, `group:web`, `group:sessions`,
`group:ui`, `group:automation`, `group:messaging`, `group:nodes`, `group:agents`,
`group:media`, `group:memory` and `group:openclaw`.

`group:plugins` is deliberately **not** denied: configured MCP servers are
plugin-owned, so denying that group would deny the clinic tools themselves.

Two consequences worth knowing:

- The 13 names are listed explicitly rather than as `clinic__*`, so a tool added to
  `openclaw/mcp/clinic/server.mjs` later stays unreachable until it is added here.
- If OpenClaw ends up with **no** callable tools it stops the run before calling the
  model instead of falling back to a text-only agent. So if every clinic turn fails,
  check that the MCP server started (`openclaw mcp doctor clinic --probe`) — the
  allowlist is the usual reason.

If you ever enable a sandbox (`agents.defaults.sandbox.mode` `all`/`non-main`), MCP
tools are filtered by a second gate: add `bundle-mcp` to
`tools.sandbox.tools.alsoAllow`.

---

## 6) Model: Nemotron 3 Super, Gemini 3.8 Flash as failover

- Primary `nvidia/nvidia/nemotron-3-super-120b-a12b`, served by NVIDIA's
  OpenAI-compatible API. The `nvidia` provider auto-enables from `NVIDIA_API_KEY`;
  no provider block is needed.
- Thinking off, at three levels so it cannot drift: `thinkingDefault: "off"`,
  `models[ref].params.thinking: "off"`, and
  `params.chat_template_kwargs.enable_thinking: false` (the request-level control
  that stops the template emitting reasoning before the visible answer — exactly
  what the voice console would otherwise read aloud).
- Failover `google/gemini-3.8-flash`. Object form is required to opt in: a bare
  string, or an object with only `primary`, is **strict** and never falls back.

### A/B the two models on a live gateway — UNVERIFIED until you run it

```powershell
# primary
curl.exe -sS "$env:OPENCLAW_GATEWAY_URL/v1/chat/completions" `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $env:OPENCLAW_API_KEY" `
  -H "x-openclaw-model: nvidia/nvidia/nemotron-3-super-120b-a12b" `
  -d '{\"model\":\"openclaw/clinic-receptionist\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"إيه المواعيد المتاحة؟\"}]}'

# failover, same turn
curl.exe -sS "$env:OPENCLAW_GATEWAY_URL/v1/chat/completions" `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $env:OPENCLAW_API_KEY" `
  -H "x-openclaw-model: google/gemini-3.8-flash" `
  -d '{\"model\":\"openclaw/clinic-receptionist\",\"stream\":false,\"messages\":[{\"role\":\"user\",\"content\":\"إيه المواعيد المتاحة؟\"}]}'
```

For end-to-end numbers, run `npm run clinic:latency` once per model, changing the
agent's primary in between (`docs/TESTING.md` §9.5). Neither the override header nor
the failover has been exercised against a real gateway from this checkout.

---

## 7) MCP proxy dependencies

```powershell
cd C:\path\to\living-ai-talk\openclaw\mcp\clinic
npm install
```

The merge script points `args` and `cwd` at this directory, so `node` resolves
`@modelcontextprotocol/sdk` from here regardless of the gateway's working directory.

---

## 8) Smoke-test the endpoint

```powershell
curl.exe -sS "$env:OPENCLAW_GATEWAY_URL/v1/chat/completions" `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer $env:OPENCLAW_API_KEY" `
  -d '{\"model\":\"openclaw/clinic-receptionist\",\"messages\":[{\"role\":\"user\",\"content\":\"what are your opening hours?\"}]}'
```

A working turn produces a JSON screen and a real `get_clinic_info` call in
`audit_events`.

---

## 9) The seeded contacts are placeholders

The demo seed (`supabase/seed_clinic_demo.sql`) ships **placeholder** branch phones,
duty-manager phones and emails (`+20 2 0000000x`, `*@example.invalid`), and the
emergency-services number is seeded as config (`123`), not hard-coded. Replace them
before any escalation test: otherwise `escalate_to_human` reports `delivery_failed`
(or worse, pages nobody) while the agent honestly says it could not reach the team.
`npm run clinic:preflight` warns while placeholder addresses are still present.

---

## 10) Voice settings (Arabic)

- ASR: local Whisper-compatible server (`Settings → Voice & Agents → ASR engine: local`), auto language detect.
- TTS: browser device voice with `ar-EG`/`ar-SA` installed, or gateway TTS.
- Kokoro's default voice is English; avoid it for Arabic unless explicitly configured.
