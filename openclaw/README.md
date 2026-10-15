# OpenClaw runtime package for Clinic Reception

## 1) Required environment

Set these in your gateway/server environment:

- `OPENCLAW_GATEWAY_URL`
- `OPENCLAW_API_KEY`
- `CLINIC_API_URL` (example: `http://localhost:3000`)
- `CLINIC_TOOLS_TOKEN`
- `GEMINI_API_KEY` (on gateway)
- `CLINIC_TENANT_SLUG=demo-dental`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- Optional: `ESCALATION_WEBHOOK_URL`

## 2) Enable chat-completions endpoint

In your OpenClaw config, ensure:

- `gateway.http.endpoints.chatCompletions.enabled`

> `docs.openclaw.ai` was unreachable in this environment, so key-name verification remains unverified.

## 3) Load the config fragment

1. Open your `~/.openclaw/openclaw.json`.
2. Merge `openclaw/openclaw.json5` into it.
3. Replace `/ABSOLUTE/PATH/TO/repo` placeholders with your real absolute path.

## 4) Install MCP proxy deps

```bash
cd /home/runner/work/Dark-Coders/Dark-Coders/openclaw/mcp/clinic
npm install
```

## 5) Smoke-test gateway

```bash
curl -sS "$OPENCLAW_GATEWAY_URL/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $OPENCLAW_API_KEY" \
  -d '{"model":"openclaw/clinic-receptionist","messages":[{"role":"user","content":"what are your opening hours?"}]}'
```

## 6) Warning: the seeded contacts are placeholders

The demo seed (`supabase/seed_clinic_demo.sql`) ships **placeholder** branch
phones, duty-manager phones and emails (`+20 2 0000000x`, `*@example.invalid`),
and the emergency-services number is seeded as config (`123`), not hard-coded.
Replace them with real values before any escalation test: otherwise
`escalate_to_human` will report `delivery_failed` (or worse, page nobody) while
the agent honestly says it could not reach the team. `npm run clinic:preflight`
warns while placeholder addresses are still present.

## 7) Voice settings (Arabic)

- ASR: local Whisper-compatible server (`Settings -> Voice & Agents -> ASR engine: local`), auto language detect.
- TTS: browser device voice with `ar-EG`/`ar-SA` voice installed, or gateway TTS.
- Kokoro default voice is English; avoid it for Arabic unless explicitly configured.
