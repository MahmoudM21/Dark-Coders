#!/usr/bin/env node
// Clinic warm-up. Run: npm run clinic:warmup
//
// Two cold starts cost real seconds on a demo: the ASR container loads its whisper model
// on the first upload, and the gateway pays its first-turn cost (provider connection,
// agent workspace read). This script pays both up front and prints the times.
//
//   1. POST a 1 s WAV to ASR_BASE_URL/audio/transcriptions  (forces the model load)
//   2. POST one "hi" turn to /api/agent for openclaw/clinic-receptionist
//
// It writes a call-session row through the bridge, exactly like a real turn. It never
// retries silently and never prints a success it did not observe.

import { existsSync, readFileSync } from "node:fs";

function loadEnvFile(path = ".env") {
  if (!existsSync(path)) return false;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function env(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function makeWav({ seconds = 1, sampleRate = 16000, frequency = 440, amplitude = 0.05 } = {}) {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const ASR_BASE = (env("ASR_BASE_URL") || "http://localhost:8000/v1").replace(/\/$/, "");
const ASR_MODEL = env("ASR_MODEL") || "Systran/faster-whisper-small";
const ASR_LANGUAGE = env("ASR_LANGUAGE") || "ar";
const ASR_TIMEOUT_MS = Number(env("ASR_TIMEOUT_MS") || 300000);
const APP = (env("CLINIC_API_URL") || "http://localhost:8080").replace(/\/$/, "");
const AGENT_TIMEOUT_MS = Number(env("CLINIC_WARMUP_AGENT_TIMEOUT_MS") || 120000);

async function warmAsr() {
  const form = new FormData();
  form.append("file", new Blob([makeWav()], { type: "audio/wav" }), "warmup.wav");
  form.append("model", ASR_MODEL);
  form.append("language", ASR_LANGUAGE);
  form.append("response_format", "json");
  const started = Date.now();
  try {
    const response = await fetch(`${ASR_BASE}/audio/transcriptions`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });
    const body = (await response.text()).slice(0, 200);
    return {
      ok: response.ok,
      line: `ASR ${response.status} in ${Date.now() - started} ms${response.ok ? "" : " — " + body}`,
    };
  } catch (error) {
    return {
      ok: false,
      line: `ASR did not answer in ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)} — is the container running? (${ASR_BASE})`,
    };
  }
}

async function warmAgent() {
  const started = Date.now();
  try {
    const response = await fetch(`${APP}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "accept-language": "ar-EG" },
      body: JSON.stringify({
        model: "openclaw/clinic-receptionist",
        turns: [{ role: "user", text: "hi" }],
        session_id: crypto.randomUUID(),
        context: "",
      }),
      signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
    });
    const body = await response.text();
    const done = body
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => {
        try {
          return JSON.parse(line.slice(5).trim());
        } catch {
          return null;
        }
      })
      .filter((event) => event && event.type === "response.output_text.done")
      .at(-1);
    let validScreen = false;
    if (done?.text) {
      try {
        const screen = JSON.parse(done.text);
        validScreen = screen?.kind === "screen" && typeof screen?.screen?.text === "string";
      } catch {
        validScreen = false;
      }
    }
    return {
      ok: response.ok && validScreen,
      line:
        `bridge ${response.status} in ${Date.now() - started} ms` +
        (response.ok && !validScreen ? " — the answer was not valid screen JSON" : "") +
        (response.ok ? "" : " — " + body.slice(0, 200)),
    };
  } catch (error) {
    return {
      ok: false,
      line: `bridge did not answer in ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)} — is the app running? (${APP}, npm run dev)`,
    };
  }
}

async function main() {
  loadEnvFile();
  console.log("Clinic warm-up");
  const asr = await warmAsr();
  console.log((asr.ok ? "[PASS] " : "[FAIL] ") + asr.line);
  const agent = await warmAgent();
  console.log((agent.ok ? "[PASS] " : "[FAIL] ") + agent.line);
  if (!asr.ok || !agent.ok) {
    console.error("\nWarm-up incomplete. A demo in this state will show the failure above on the first real turn.");
    process.exitCode = 1;
    return;
  }
  console.log("\nBoth paths are warm. Start the demo.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
