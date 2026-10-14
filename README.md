# OpenClaw Voice & Spatial Console (`living-ai-talk`)

A DarkCoders voice, chat, and 3D WebXR console designed for multi-agent orchestration on **OpenClaw**.

> **Candidates:** Read **[`ASSIGNMENT.md`](./ASSIGNMENT.md)** for full assignment instructions, architecture integration points, and deliverables.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment template and configure your OpenClaw Gateway URL
cp .env.example .env

# Verify types, tests, and production build
npm run typecheck
npm test
npm run build

# Start development server
npm run dev
```

## Key Scripts

- `npm run dev` — Start the Vite + TanStack Start dev server
- `npm run build` — Build client, SSR, and Nitro server bundles
- `npm run typecheck` — Run TypeScript compiler checks (`tsc --noEmit`)
- `npm test` — Run the unit test suite (`node --test`)
- `npm run lint` — Run ESLint

## Architecture Reference

- **`ASSIGNMENT.md`** — Candidate challenge brief, requirements, and grading rubric
- **`src/config/unified-plan.yaml`** — `VoiceChatOpenClawArchitecture` (`darkcoders.ai/v1alpha1`) specification
- **`src/routes/index.tsx`** — Main voice/chat/spatial console and run lifecycle controller
- **`src/routes/api/agent.ts`** — Server route connecting the console to your OpenClaw Gateway
- **`src/lib/settings/voice.ts`** — OpenClaw agent roster (`AGENTS`) and voice/ASR settings
- **`src/lib/voice/screen.ts`** — Structured screen, voice command (`app_commands`), and `action_proposal` parser
"# Dark-Coders" 
