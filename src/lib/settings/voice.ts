import { useLocal } from "@/lib/settings/store";
import { speak } from "@/lib/voice/speak";

export type VoiceEngine = "cloud" | "browser" | "kokoro";
export type AsrEngine = "cloud" | "local";
export type AgentProfile = { label: string; persona: string };
export type VoiceSettings = {
  agent: string;
  engine: VoiceEngine;
  rate: number;
  standbyPause: number;
  browserVoice: string;
  kokoroUrl: string;
  kokoroVoice: string;
  asrEngine: AsrEngine;
  asrUrl: string;
  asrModel: string;
  customAgents?: Record<string, AgentProfile>;
};

/**
 * Starter OpenClaw agent roster.
 * Candidates: register your own OpenClaw agents here (or add them live in General Settings -> Voice)
 * so the console, voice commands ("set_agent"), and 3D WebXR AgentRail route to your agents.
 */
export const AGENTS: Record<string, AgentProfile> = {
  general: { label: "OpenClaw orchestrator", persona: "Act as the root OpenClaw orchestrator (dc-orchestrator): classify intent, route to specialist skills/tools, and synthesize clear spoken answers." },
  ciso: { label: "CISO · security & risk", persona: "Act as the organisation's chief information security officer: prioritise risk, controls, evidence and approvals." },
  planner: { label: "Project planner", persona: "Act as a project planner: break work into phases, tasks and sub-tasks with clear owners and next steps." },
  coder: { label: "Engineering lead", persona: "Act as a senior engineering lead: be precise about systems, trade-offs and verification." },
};

export function getAgents(v?: Partial<VoiceSettings>): Record<string, AgentProfile> {
  return { ...AGENTS, ...(v?.customAgents ?? {}) };
}

export const ENGINE_LABEL: Record<VoiceEngine, string> = {
  browser: "Native · installed device voices",
  kokoro: "Kokoro · local/self-hosted TTS server",
  cloud: "OpenClaw · gateway / cloud voice",
};

const VOICE_KEY = "openclaw.voice";
export const DEFAULT_VOICE: VoiceSettings = { agent: "general", engine: "browser", rate: 1, standbyPause: 900, browserVoice: "", kokoroUrl: "http://localhost:8880", kokoroVoice: "af_heart", asrEngine: "local", asrUrl: "http://localhost:8000/v1", asrModel: "whisper-1", customAgents: {} };
export const useVoiceSettings = () => useLocal(VOICE_KEY, DEFAULT_VOICE);

function speakBrowser(text: string, v: VoiceSettings, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (!("speechSynthesis" in window)) return reject(new Error("This browser has no device voice."));
    const u = new SpeechSynthesisUtterance(text);
    u.rate = v.rate;
    const voice = speechSynthesis.getVoices().find((x) => x.name === v.browserVoice);
    if (voice) u.voice = voice;
    u.onend = () => resolve();
    u.onerror = (e) => (e.error === "interrupted" || e.error === "canceled" ? resolve() : reject(new Error(`Device voice failed: ${e.error}`)));
    signal?.addEventListener("abort", () => speechSynthesis.cancel(), { once: true });
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

async function speakKokoro(text: string, v: VoiceSettings, signal?: AbortSignal) {
  let res: Response;
  try {
    res = await fetch(`${v.kokoroUrl.replace(/\/$/, "")}/v1/audio/speech`, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: signal ?? null,
      body: JSON.stringify({ model: "kokoro", input: text, voice: v.kokoroVoice, speed: v.rate, response_format: "mp3" }),
    });
  } catch (e) {
    if (signal?.aborted) return;
    throw new Error(`Couldn't reach the Kokoro server at ${v.kokoroUrl}.`, { cause: e });
  }
  if (!res.ok) throw new Error(`Kokoro returned ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const audio = new Audio(url);
  await new Promise<void>((resolve, reject) => {
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("Kokoro audio could not play"));
    signal?.addEventListener("abort", () => { audio.pause(); resolve(); }, { once: true });
    void audio.play().catch(reject);
  }).finally(() => URL.revokeObjectURL(url));
}

/** Speaks with the chosen engine only — a failure is reported, never silently swapped. */
export function speakWith(v: VoiceSettings, text: string, signal?: AbortSignal) {
  if (v.engine === "browser") return speakBrowser(text, v, signal);
  if (v.engine === "kokoro") return speakKokoro(text, v, signal);
  return speak(text, signal, v.rate);
}
