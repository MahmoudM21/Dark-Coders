#!/usr/bin/env node
// ASR CORS / latency probe. Run: npm run clinic:stt-probe
//
// It answers one question with evidence instead of a guess: when the browser uploads a
// recording straight to the local Whisper service, does the POST RESPONSE carry
// Access-Control-Allow-Origin, and how long does the first (cold) call take compared
// with the second?
//
// It sends a generated WAV (a quiet 440 Hz tone, 1 s, 16 kHz mono PCM16) to
// ASR_BASE_URL/audio/transcriptions with an Origin header equal to the app's origin,
// for both `whisper-1` and ASR_MODEL, with and without language=ar. For every call it
// prints: HTTP status, whether the response carries ACAO (and its value), the body,
// and the elapsed ms. The first call of each configuration is the cold one, the second
// is the warm one — both are printed, nothing is averaged or inferred.
//
// It needs the ASR container to be running; it never starts one and never invents a
// result. Exit code is 0 when every call answered HTTP 2xx, 1 otherwise (a CORS header
// is reported, not treated as a failure: the proxy mode exists precisely for that).

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

/** A valid 16-bit PCM WAV in memory: no temp file, no external tool. */
function makeWav({ seconds = 1, sampleRate = 16000, frequency = 440, amplitude = 0.05 } = {}) {
  const samples = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude * 32767);
    data.writeInt16LE(value, i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const ASR_BASE = (env("ASR_BASE_URL") || "http://localhost:8000/v1").replace(/\/$/, "");
const APP_ORIGIN = (() => {
  const raw = env("APP_ORIGIN") || env("CLINIC_API_URL") || "http://localhost:8080";
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
})();
const TIMEOUT_MS = Number(env("STT_PROBE_TIMEOUT_MS") || 300000);

async function probe({ model, language }, wav) {
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "probe.wav");
  form.append("model", model);
  form.append("response_format", "json");
  if (language) form.append("language", language);

  const started = Date.now();
  let response;
  try {
    response = await fetch(`${ASR_BASE}/audio/transcriptions`, {
      method: "POST",
      headers: { Origin: APP_ORIGIN },
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    return {
      status: "no HTTP answer",
      acao: "n/a",
      body: error instanceof Error ? error.message : String(error),
      elapsed: Date.now() - started,
    };
  }
  const body = (await response.text()).slice(0, 300);
  return {
    status: response.status,
    acao: response.headers.get("access-control-allow-origin") ?? "(absent)",
    body: body.replace(/\s+/g, " ").slice(0, 300),
    elapsed: Date.now() - started,
  };
}

/** OPTIONS is what the browser asks first; the POST response is what it actually needs. */
async function probePreflight() {
  try {
    const response = await fetch(`${ASR_BASE}/audio/transcriptions`, {
      method: "OPTIONS",
      headers: {
        Origin: APP_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: response.status,
      acao: response.headers.get("access-control-allow-origin") ?? "(absent)",
      headers: response.headers.get("access-control-allow-headers") ?? "(absent)",
    };
  } catch (error) {
    return { status: "no HTTP answer", acao: "n/a", headers: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  loadEnvFile();
  const wav = makeWav();
  const model = env("ASR_MODEL") || "Systran/faster-whisper-small";

  console.log("ASR probe");
  console.log("  service: " + ASR_BASE);
  console.log("  origin sent: " + APP_ORIGIN);
  console.log("  timeout: " + TIMEOUT_MS + " ms");
  console.log("  wav: " + wav.length + " bytes, 1 s, 16 kHz mono PCM16 (440 Hz tone)");
  console.log("  models: whisper-1, " + model);

  const preflight = await probePreflight();
  console.log("\nOPTIONS /audio/transcriptions");
  console.log("  status " + preflight.status + "  ACAO " + preflight.acao + "  allow-headers " + preflight.headers);

  const configs = [];
  for (const candidate of ["whisper-1", model]) {
    for (const language of [null, "ar"]) {
      const key = candidate + " / " + (language ? "language=" + language : "no language");
      if (configs.some((c) => c.key === key)) continue;
      configs.push({ key, model: candidate, language });
    }
  }

  let failures = 0;
  for (const config of configs) {
    console.log("\n" + config.key);
    for (const attempt of ["first (cold)", "second (warm)"]) {
      const result = await probe(config, wav);
      if (typeof result.status !== "number" || result.status < 200 || result.status >= 300) failures += 1;
      console.log(
        "  " +
          attempt.padEnd(14) +
          " status " +
          String(result.status).padEnd(14) +
          " ACAO " +
          String(result.acao).padEnd(28) +
          " " +
          String(result.elapsed).padStart(6) +
          " ms",
      );
      console.log("    body: " + (result.body || "(empty)"));
    }
  }

  console.log("\nWhat this means");
  console.log("  * ACAO (absent) on a POST response is exactly what makes the browser log");
  console.log("    \"Failed to fetch\" while DevTools shows HTTP 200: the request succeeded,");
  console.log("    the response was blocked from JavaScript. \"Local via app\" avoids it by");
  console.log("    uploading to /api/asr on this origin and forwarding from the server.");
  console.log("  * The first call of each block includes model loading; compare it with the");
  console.log("    second, and run `npm run clinic:warmup` before a demo.");

  if (failures) {
    console.error("\n" + failures + " call(s) did not answer HTTP 2xx. Fix that before a demo.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
