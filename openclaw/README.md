# OpenClaw runtime package for Clinic Reception

## 1) Required environment

Set these in your gateway/server environment:

- `OPENCLAW_GATEWAY_URL`
- `OPENCLAW_API_KEY`
- `CLINIC_API_URL` (example: `http://localhost:3000`)
- `CLINIC_TOOLS_TOKEN`
- `NVIDIA_API_KEY` — **gateway only** (`~/.openclaw/.env`); the agent's primary model
- `GEMINI_API_KEY` — **gateway only**, optional; used only by the failover
- `CLINIC_TENANT_SLUG=demo-dental`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- Optional: `ESCALATION_WEBHOOK_URL`

`NVIDIA_API_KEY` and `GEMINI_API_KEY` are gateway variables. They never belong in
the console's `.env`, in a prompt, or in git.

## 2) Model: Nemotron 3 Super, with Gemini 3.8 Flash as failover

- Primary: `nvidia/nvidia/nemotron-3-super-120b-a12b` (build.nvidia.com, served
  over NVIDIA's OpenAI-compatible API at `https://integrate.api.nvidia.com/v1`).
- Thinking is **off** for voice latency:
  `agents.defaults.models["nvidia/nvidia/nemotron-3-super-120b-a12b"].params.chat_template_kwargs.enable_thinking = false`,
  and the agent's `thinkingDefault` is `"off"`. Without it Nemotron streams
  reasoning before the visible answer.
- Failover: `google/gemini-3.8-flash`, used only when NVIDIA errors or
  rate-limits (429). A native agent primary is **strict** in OpenClaw, so the
  failover applies only because the agent's own `model` object lists it.

Key names were checked against docs.openclaw.ai on 2026-10-16
(`providers/nvidia`, `concepts/model-failover`, `gateway/config-agents/models`,
and the `agents.entries` per-agent page). That last page is why this fragment now
uses `agents.entries.<id>` instead of the earlier `agents.list[]`: the documented
per-agent override store is `entries`, keyed by the stable agent id. Confirm on
your installed version with `openclaw config schema` and `openclaw agents list`
before trusting it.

### A/B the two models on a live gateway — **UNVERIFIED until you run it**

The chat-completions endpoint accepts a per-request override, so you can compare
without editing the config:

```bash
# primary
curl -sS "$OPENCLAW_GATEWAY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENCLAW_API_KEY" \
  -H "x-openclaw-model: nvidia/nvidia/nemotron-3-super-120b-a12b" \
  -d '{"model":"openclaw/clinic-receptionist","stream":false,"messages":[{"role":"user","content":"إيه المواعيد المتاحة؟"}]}'

# fallback, same turn
curl -sS "$OPENCLAW_GATEWAY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENCLAW_API_KEY" \
  -H "x-openclaw-model: google/gemini-3.8-flash" \
  -d '{"model":"openclaw/clinic-receptionist","stream":false,"messages":[{"role":"user","content":"إيه المواعيد المتاحة؟"}]}'
```

For end-to-end numbers instead of one curl, run `npm run clinic:latency` once
with each header (see `docs/TESTING.md` §9). Neither the override header nor the
failover has been exercised against a real gateway from this checkout.

## 3) Enable chat-completions endpoint

In your OpenClaw config, ensure:

- `gateway.http.endpoints.chatCompletions.enabled`

> `docs.openclaw.ai` was unreachable when the config fragment was first written, so
> the key names there were unverified. The ones in `openclaw.json5` were re-checked
> against the docs on 2026-10-16; check them once more with `openclaw config schema`
> for your installed version.

## 4) Load the config fragment

1. Open your `~/.openclaw/openclaw.json`.
2. Merge `openclaw/openclaw.json5` into it.
3. Replace `/ABSOLUTE/PATH/TO/repo` placeholders with your real absolute path.

## 5) Install MCP proxy deps

```bash
cd /home/runner/work/Dark-Coders/Dark-Coders/openclaw/mcp/clinic
npm install
```

## 6) Smoke-test gateway

```bash
curl -sS "$OPENCLAW_GATEWAY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENCLAW_API_KEY" \
  -d '{"model":"openclaw/clinic-receptionist","messages":[{"role":"user","content":"what are your opening hours?"}]}'
```

## 7) Warning: the seeded contacts are placeholders

The demo seed (`supabase/seed_clinic_demo.sql`) ships **placeholder** branch
phones, duty-manager phones and emails (`+20 2 0000000x`, `*@example.invalid`),
and the emergency-services number is seeded as config (`123`), not hard-coded.
Replace them with real values before any escalation test: otherwise
`escalate_to_human` will report `delivery_failed` (or worse, page nobody) while
the agent honestly says it could not reach the team. `npm run clinic:preflight`
warns while placeholder addresses are still present.

## 8) Voice settings (Arabic)

- ASR: local Whisper-compatible server (`Settings -> Voice & Agents -> ASR engine: local`), auto language detect.
- TTS: browser device voice with `ar-EG`/`ar-SA` voice installed, or gateway TTS.
- Kokoro default voice is English; avoid it for Arabic unless explicitly configured.
