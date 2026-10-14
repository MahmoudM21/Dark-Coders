# AI & Agent Engineering Assignment

**Give our voice console something worth talking to.**

We built a console that can already listen, think out loud, and show its work. What it doesn't have is a brain. That's your job.

Build an AI agent — or a small team of them — that does something genuinely useful, teach it to talk, and let it act. Pick a problem you find interesting. There's no single right answer, and we care far more about how you think than about how much code you write.

---

## 1. The idea

Most take-homes ask you to build a UI from scratch. We'd rather skip the boilerplate. So we're handing you a working voice console and letting you spend your time on the interesting half: the agents behind it.

Make it yours. A security analyst, a research assistant, a code reviewer, a trip planner, a game master — anything you'd actually enjoy building.

## 2. What you'll build

- **An agent with a point of view.** Something that solves a real problem, built on OpenClaw, using whatever model you like.
- **A voice.** The console already speaks; you give it something worth saying.
- **Real work, not just chat.** Teach it to use tools and skills so it actually gets things done.
- **A sense of caution.** Anything risky stops and asks a human first.

## 3. What we're handing you

- **A working console.** Hold-to-talk, a hands-free mode, a live step-by-step view, and a 3D WebXR room — all built.
- **A starting blueprint.** Our full architecture is in the repo (`src/config/unified-plan.yaml`) if you want a guide. Follow it, adapt it, or ignore it — your call.
- **An approval panel.** Already wired. When your agent proposes something risky, the console asks you before it runs.
- **Room to play.** The frontend works out of the box, so nothing stands between you and the agent you want to build.

## 4. What we'd love to see

- **Talk to it.** Voice in, voice out — natural enough that you'd actually use it.
- **Watch it think.** Its steps, tools, and reasoning show up live as it works.
- **It actually does things.** Real skills and tools, not a chatbot pretending.
- **It knows its limits.** Anything consequential waits for a human "yes".

---

## 5. Where to plug in

Three places matter, and you don't need more to start:

- **The bridge** — `src/routes/api/agent.ts` is where the console talks to your agent. Point it at your OpenClaw setup (`OPENCLAW_GATEWAY_URL`).
- **Your agents** — register them in `src/lib/settings/voice.ts` (`AGENTS`) and they appear in the console and the 3D room automatically.
- **The approval panel** — `src/components/console-panels.tsx` already catches risky action requests. You just have to teach your agent to ask.

## 6. Time

A weekend is plenty. The core should take a focused half-day; polish and stretch goals can take longer. Don't over-engineer it — a small, sharp system beats a big, half-working one.

## 7. Ground rules

- **Use AI tools.** We expect it. Just note in your README where they helped — we're looking at *how* you used them.
- **Rough is fine.** We're reading your judgment, not your polish.
- **No fake results.** If something fails, show the real error. Never swap in fake data behind the scenes.

## 8. How we'll read it

- **Baseline** — it works. We can talk to it, it answers, and it uses a tool or two.
- **Strong** — it handles the messy cases too, the code reads well, and you clearly thought before you typed.
- **Exceptional** — it feels like it could grow. It does things we didn't ask for, and we'd trust it to make its own decisions.

## 9. What to send

- Your code — a repo or a zip.
- An `openclaw/` folder with your agents and skills, so we can run them.
- A short README: what you built, the calls you made, and where AI helped.

## 10. What happens next

We'll sit down together and walk through what you built — your choices, your trade-offs, and a small extension, live. It's a conversation, not a test. You'll hear back from us either way.

---

## Appendix — the agent contract

*For when you get there. Skip until you've started.*

### Plain replies

Local models can answer in plain text — the console will show it as-is.

### Interactive screens

To drive the console's buttons, voice, and choices, return a screen:

```json
{
  "kind": "screen",
  "screen": {
    "text": "Plain spoken language. Written to be read aloud.",
    "choices": [
      { "id": "inspect_logs", "label": "Inspect logs", "value": "Inspect the recent service logs" }
    ],
    "navigation": ["cancel"]
  },
  "app_commands": []
}
```

- `text` is spoken aloud on the final step — keep it natural and markdown-free.
- `choices` (max 4) become buttons; `value` is what the user would say.
- `navigation` is any of `back`, `cancel`, `home`.
- `app_commands` lets the agent drive the app itself (`set_view`, `set_agent`, `open_headset`, …).

### Asking before risky actions

When your agent wants to do something consequential, it proposes it instead of doing it:

```json
{
  "kind": "screen",
  "screen": { "text": "I've prepared this and need your OK first.", "choices": [], "navigation": ["cancel"] },
  "action_proposal": {
    "id": "act_01",
    "title": "Restart staging worker",
    "tool": "ops.restart_service",
    "summary": "Gracefully restarts worker-02 after draining active jobs.",
    "risk": "medium"
  },
  "app_commands": []
}
```

The console shows this in the approval panel with **Approve / Deny**, and sends the human's decision back into the conversation. Read-only tools don't need approval; state-changing or external ones do.

### Tooling

Read-only tools can run directly. Anything that writes, deletes, or reaches outside the workspace must go through `action_proposal`. Secrets never belong in prompts or in the browser — keep them in your OpenClaw setup or the server environment.

## Appendix — running it

```bash
npm install
cp .env.example .env       # set OPENCLAW_GATEWAY_URL and any model keys
npm run typecheck && npm test
npm run dev
```

Speech output defaults to your device's built-in voice, so it works immediately. A local Whisper server can be used for speech input, and a Kokoro or OpenClaw TTS route for richer voices — both configurable under **Settings → Voice & Agents**.
