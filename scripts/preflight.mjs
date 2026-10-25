#!/usr/bin/env node
// Clinic reception preflight. Run: npm run clinic:preflight
// (or: node scripts/preflight.mjs). It reads .env if present, then checks the
// moving parts and prints PASS / FAIL / WARN / UNVERIFIED for each.
//
// It never invents a result: anything it cannot reach is reported as FAIL or
// UNVERIFIED together with the exact command a human should run. Nothing here
// writes to the database except one throwaway call-session row for the tools
// check, and it is created by the same RPC the bridge uses.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const results = [];

function record(status, name, detail) {
  results.push({ status, name, detail });
  const tag = { PASS: "PASS", FAIL: "FAIL", WARN: "WARN", UNVERIFIED: "UNVERIFIED", SKIP: "SKIP" }[status] ?? status;
  console.log(`[${tag}] ${name}`);
  if (detail) console.log(`       ${detail}`);
}

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

// The Postgres DSN is accepted under either name: DATABASE_URL (the psql convention used in the
// docs) or POSTGRES_URL (what this project's .env ships). Whichever is set is used, and only the
// variable NAME is ever printed — never the value.
function postgresDsn() {
  for (const name of ["DATABASE_URL", "POSTGRES_URL"]) {
    const value = env(name);
    if (value) return { name, value };
  }
  return null;
}

/**
 * The one line this script is allowed to read from ~/.openclaw/.env: CLINIC_API_URL, which is
 * a URL and not a secret. Every other line in that file is ignored, never printed and never
 * copied into process.env.
 */
function openclawClinicApiUrl() {
  const path = join(homedir(), ".openclaw", ".env");
  if (!existsSync(path)) return { source: path, value: null };
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?CLINIC_API_URL\s*=\s*(.*)$/.exec(rawLine);
    if (!match) continue;
    let value = (match[1] ?? "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return { source: path, value: value || null };
  }
  return { source: path, value: null };
}

/** The development ports this checkout has actually run on. */
const APP_PORT_CANDIDATES = [8080, 8081, 3000];

/** The tools base URL resolved by the port check, so no check has to guess a port. */
let toolsBase = null;

function portOf(value) {
  try {
    const url = new URL(value);
    if (url.port) return Number(url.port);
    return url.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/**
 * Whether the clinic tools route answers on this port, and how. A 401 is the route refusing a
 * wrong token; a 200 must carry the tool envelope's meta. Anything else (a 404 from some other
 * server, a proxy error page) is NOT the route, so it is never counted as a dev server.
 */
async function probeToolsRoute(port) {
  try {
    const response = await withTimeout(
      (signal) =>
        fetch(`http://localhost:${port}/api/clinic/tools`, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: "Bearer deliberately-wrong-token" },
          body: JSON.stringify({ tool: "get_clinic_info", args: { session_id: "00000000-0000-4000-8000-000000000000" } }),
        }),
      2500,
    );
    if (response.status === 401) return { port, status: 401, route: true };
    const body = await response.json().catch(() => null);
    const route = Boolean(body && typeof body === "object" && body.meta && typeof body.meta.request_id === "string");
    return { port, status: response.status, route };
  } catch {
    return null;
  }
}

/** The status the app root answers with, or null when nothing is listening there. */
async function probeAppRoot(port) {
  try {
    const response = await withTimeout((signal) => fetch(`http://localhost:${port}/`, { signal }), 2500);
    return response.status;
  } catch {
    return null;
  }
}

/**
 * One app, one port. The MCP proxy and the console must reach the SAME dev server, so the
 * configured CLINIC_API_URL is compared with the port where /api/clinic/tools actually
 * answers, rather than assumed.
 */
async function checkPortConsistency() {
  const configured = env("CLINIC_API_URL");
  const fromFile = openclawClinicApiUrl();

  const answering = [];
  for (const port of APP_PORT_CANDIDATES) {
    const probe = await probeToolsRoute(port);
    if (probe?.route) answering.push(probe);
  }
  const roots = [];
  for (const port of APP_PORT_CANDIDATES) {
    if ((await probeAppRoot(port)) !== null) roots.push(port);
  }

  if (answering.length === 0) {
    record(
      "UNVERIFIED",
      "port consistency",
      `no app answered /api/clinic/tools on ${APP_PORT_CANDIDATES.map((port) => `:${port}`).join(", ")} — start one with npm run dev, or set CLINIC_API_URL`,
    );
    return;
  }

  const answeringPorts = answering.map((entry) => entry.port);
  const preferred = portOf(configured ?? "") ?? portOf(fromFile.value ?? "");
  toolsBase = preferred && answeringPorts.includes(preferred) ? `http://localhost:${preferred}` : `http://localhost:${answeringPorts[0]}`;

  if (configured && fromFile.value && portOf(configured) !== portOf(fromFile.value)) {
    record(
      "FAIL",
      "port consistency",
      `CLINIC_API_URL is ${configured} in .env but ${fromFile.value} in ${fromFile.source}. Fix: make both ${toolsBase} (that is where /api/clinic/tools answered).`,
    );
  } else if (preferred === null) {
    record(
      "WARN",
      "port consistency",
      `CLINIC_API_URL is not set in .env or ${fromFile.source}; using ${toolsBase}, where /api/clinic/tools answered. Fix: add CLINIC_API_URL=${toolsBase} to both files.`,
    );
  } else if (!answeringPorts.includes(preferred)) {
    record(
      "FAIL",
      "port consistency",
      `CLINIC_API_URL points at :${preferred} but /api/clinic/tools answers on ${answeringPorts.map((port) => `:${port}`).join(", ")}. Fix: set CLINIC_API_URL=${toolsBase} in .env and ${fromFile.source} (or start the app on :${preferred}).`,
    );
  } else {
    record("PASS", "port consistency", `CLINIC_API_URL :${preferred} is the port where /api/clinic/tools answered`);
  }

  if (roots.length > 1) {
    record(
      "WARN",
      "more than one dev server",
      `the app root answers on ${roots.map((port) => `:${port}`).join(", ")} — stop the stale one, or the console and the MCP proxy will talk to different servers`,
    );
  }
}

async function withTimeout(promise, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promise(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function checkEnvironment(logPath) {
  const required = ["OPENCLAW_GATEWAY_URL", "CLINIC_TOOLS_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const optional = [
    ["CLINIC_API_URL", "not set — the port check will use whichever dev port answers /api/clinic/tools"],
    ["OPENCLAW_API_KEY", "not set — the gateway will reject the request if it requires auth"],
    ["ESCALATION_WEBHOOK_URL", "not set — escalate_to_human will truthfully report delivery_failed"],
  ];
  const missing = required.filter((name) => !env(name));
  const present = required.filter((name) => env(name));
  if (missing.length) {
    record("FAIL", "environment", `missing: ${missing.join(", ")} — copy .env.example to .env and fill it in`);
  } else {
    record("PASS", "environment", `required present: ${present.join(", ")}`);
  }
  for (const [name, detail] of optional) {
    if (!env(name)) record("WARN", `environment ${name}`, detail);
  }
  if (!env("CLINIC_TENANT_SLUG") || env("CLINIC_TENANT_SLUG") === "demo-dental") {
    record("WARN", "environment CLINIC_TENANT_SLUG", "using 'demo-dental' (the seeded demo clinic)");
  }
  if (!env("SUPABASE_SERVICE_ROLE_KEY") && process.env["VITE_SUPABASE_SERVICE_ROLE_KEY"]) {
    record("FAIL", "environment security", "SUPABASE_SERVICE_ROLE_KEY must not be exposed with a VITE_ prefix");
  }
  const dsn = postgresDsn();
  if (dsn) {
    record(
      "PASS",
      "postgres dsn",
      `${dsn.name} is set — needed by the psql steps: supabase/migrations, seed_clinic_demo.sql, reset_demo.sql, tests/clinic_smoke.sql`,
    );
  } else {
    record(
      "WARN",
      "postgres dsn",
      "neither DATABASE_URL nor POSTGRES_URL is set — the database check below still works over the Supabase REST API, but the psql steps (migration, seed_clinic_demo.sql, reset_demo.sql, tests/clinic_smoke.sql) need one of them in .env",
    );
  }
  record("PASS", "env file", logPath ? `loaded ${logPath}` : "no .env file found; relying on the shell environment");
}

async function checkDatabase(tenantSlug) {
  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    record("UNVERIFIED", "database", "set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then rerun: npm run clinic:preflight");
    return;
  }
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const tenant = await withTimeout(
      (signal) => client.from("tenants").select("id,slug,name_ar").eq("slug", tenantSlug).abortSignal(signal).maybeSingle(),
      8000,
    );
    if (tenant.error) {
      record("FAIL", "database", `tenants lookup failed: ${tenant.error.message}`);
      return;
    }
    if (!tenant.data) {
      record("FAIL", "database", `no tenant with slug '${tenantSlug}' — apply supabase/seed_clinic_demo.sql`);
      return;
    }
    record("PASS", "database", `tenant '${tenant.data.slug}' found (${tenant.data.name_ar})`);

    const branches = await client.from("branches").select("slug,phone,emergency_phone,emergency_email").eq("tenant_id", tenant.data.id);
    if (branches.error) {
      record("FAIL", "database branches", branches.error.message);
      return;
    }
    record("PASS", "database branches", `${branches.data.length} branch(es): ${branches.data.map((b) => b.slug).join(", ")}`);

    const placeholders = branches.data.filter((b) =>
      [b.phone, b.emergency_phone, b.emergency_email].some((v) => typeof v === "string" && v.includes("example.invalid")),
    );
    if (placeholders.length) {
      record(
        "WARN",
        "emergency contacts are placeholders",
        `${placeholders.map((b) => b.slug).join(", ")} use example.invalid / +20 2 000000x — replace them in supabase/seed_clinic_demo.sql before any real escalation test`,
      );
    } else {
      record("PASS", "emergency contacts", "no placeholder addresses detected");
    }
  } catch (error) {
    record("FAIL", "database", error instanceof Error ? error.message : String(error));
  }
}

async function checkGateway() {
  const url = env("OPENCLAW_GATEWAY_URL");
  if (!url) {
    record("UNVERIFIED", "gateway", "set OPENCLAW_GATEWAY_URL, then rerun");
    return;
  }
  try {
    const response = await withTimeout(
      (signal) =>
        fetch(url, { method: "GET", headers: env("OPENCLAW_API_KEY") ? { Authorization: `Bearer ${env("OPENCLAW_API_KEY")}` } : {}, signal }),
      5000,
    );
    // Any HTTP answer proves something is listening; the chat endpoint itself is checked separately.
    record("PASS", "gateway reachable", `${url} answered ${response.status}`);
  } catch (error) {
    record("FAIL", "gateway", `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function agentConfig() {
  const id = env("CLINIC_AGENT_ID") || "clinic-receptionist";
  return { id, model: `openclaw/${id}` };
}

function preflightTimeoutMs() {
  const raw = Number(env("CLINIC_PREFLIGHT_TIMEOUT_MS"));
  return Number.isFinite(raw) && raw > 0 ? raw : 120000;
}

/** One turn against the gateway. Returns enough detail for the caller to report the real outcome. */
async function agentTurn(content) {
  const url = env("OPENCLAW_GATEWAY_URL");
  const { id: agentId, model } = agentConfig();
  const timeoutMs = preflightTimeoutMs();
  const started = Date.now();
  try {
    // The agent id travels in the header, exactly as the bridge sends it; no session key, so the
    // gateway opens a throwaway stateless conversation instead of failing on an unknown session.
    const response = await withTimeout(
      (signal) =>
        fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            "x-openclaw-agent-id": agentId,
            ...(env("OPENCLAW_API_KEY") ? { Authorization: `Bearer ${env("OPENCLAW_API_KEY")}` } : {}),
          },
          body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content }] }),
        }),
      timeoutMs,
    );
    const body = await response.text();
    return { response, body, elapsed: Date.now() - started, timeoutMs };
  } catch (error) {
    return { error, elapsed: Date.now() - started, timeoutMs };
  }
}

/** True when a chat-completions body carries the screen envelope the console requires. */
function validScreenBody(body) {
  try {
    const payload = JSON.parse(body);
    if (payload?.error) return { ok: false, code: payload.error.code ?? payload.error.type, message: payload.error.message };
    const content = payload?.choices?.[0]?.message?.content;
    const raw = typeof content === "string" ? content : JSON.stringify(content);
    const screen = JSON.parse(raw);
    const ok = screen?.kind === "screen" && typeof screen?.screen?.text === "string" && screen.screen.text.trim().length > 0;
    return { ok, screen };
  } catch {
    return { ok: false };
  }
}

async function checkAgent() {
  const url = env("OPENCLAW_GATEWAY_URL");
  if (!url) {
    record("UNVERIFIED", "agent clinic-receptionist", "needs OPENCLAW_GATEWAY_URL");
    return;
  }
  const first = await agentTurn("ping");
  if (first.error) {
    const aborted = first.error?.name === "AbortError" || /abort/i.test(String(first.error?.message));
    record(
      "FAIL",
      "agent clinic-receptionist",
      aborted
        ? `timed out after ${first.elapsed} ms (CLINIC_PREFLIGHT_TIMEOUT_MS=${first.timeoutMs}). A cold gateway turn can exceed 15 s; raise the timeout or rerun with --warmup once the agent is warm. No HTTP status was received.`
        : `no HTTP answer after ${first.elapsed} ms: ${first.error instanceof Error ? first.error.message : String(first.error)} — is the gateway on ${url}?`,
    );
    return;
  }
  const { response, body, elapsed } = first;
  const { model: agentModel } = agentConfig();
  const verdict = validScreenBody(body);
  if (response.ok && verdict.ok) {
    record(
      elapsed > 15000 ? "WARN" : "PASS",
      "agent clinic-receptionist",
      elapsed > 15000
        ? `valid screen JSON from ${agentModel} (HTTP ${response.status}) but the turn took ${elapsed} ms — slower than the 15 s budget. Run: node scripts/preflight.mjs --warmup`
        : `valid screen JSON from ${agentModel} (HTTP ${response.status}) in ${elapsed} ms`,
    );
  } else if (response.ok && !verdict.ok) {
    record(
      "FAIL",
      "agent clinic-receptionist",
      `HTTP ${response.status} after ${elapsed} ms but the reply is not valid screen JSON (needs kind:"screen" and a non-empty screen.text): ${body.slice(0, 600)}`,
    );
  } else {
    const code = verdict.code ? ` error code ${JSON.stringify(verdict.code)}` : "";
    record("FAIL", "agent clinic-receptionist", `HTTP ${response.status} after ${elapsed} ms${code}: ${body.slice(0, 600)}`);
  }

  // --warmup: two more turns, so the model/provider connection and any lazy tool init are hot
  // before a human starts a demo. Each turn is timed and reported separately.
  if (process.argv.includes("--warmup") && response.ok && verdict.ok) {
    for (const [index, content] of ["hi", "thanks"].entries()) {
      const turn = await agentTurn(content);
      if (turn.error) {
        record("FAIL", `agent warmup ${index + 2}/3`, `no HTTP answer after ${turn.elapsed} ms: ${turn.error instanceof Error ? turn.error.message : String(turn.error)}`);
        break;
      }
      const warmed = validScreenBody(turn.body);
      record(
        turn.response.ok && warmed.ok ? "PASS" : "FAIL",
        `agent warmup ${index + 2}/3`,
        turn.response.ok && warmed.ok
          ? `valid screen JSON in ${turn.elapsed} ms`
          : `HTTP ${turn.response.status} after ${turn.elapsed} ms: ${turn.body.slice(0, 600)}`,
      );
    }
  }
}

async function checkTools() {
  const base = env("CLINIC_API_URL") || toolsBase;
  const token = env("CLINIC_TOOLS_TOKEN");
  if (!token) {
    record("UNVERIFIED", "booking service", "set CLINIC_TOOLS_TOKEN, then rerun");
    return;
  }
  if (!base) {
    record(
      "UNVERIFIED",
      "booking service",
      "no app answered on the known dev ports and CLINIC_API_URL is not set — run npm run dev, then rerun",
    );
    return;
  }
  const endpoint = `${base.replace(/\/$/, "")}/api/clinic/tools`;

  try {
    const unauthorised = await withTimeout(
      (signal) =>
        fetch(endpoint, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: "Bearer definitely-not-the-token" },
          body: JSON.stringify({ tool: "get_clinic_info", args: { session_id: "00000000-0000-4000-8000-000000000000" } }),
        }),
      8000,
    );
    const body = await unauthorised.text();
    if (unauthorised.status === 401) {
      record("PASS", "tools route auth", `wrong token rejected with 401 (${endpoint})`);
    } else {
      record("FAIL", "tools route auth", `expected 401 for a wrong token, got ${unauthorised.status}: ${body.slice(0, 200)}`);
    }
  } catch (error) {
    record("FAIL", "tools route", `could not reach ${endpoint}: ${error instanceof Error ? error.message : String(error)} — is the dev server running? (npm run dev)`);
    return;
  }

  // A fresh session exercises auth + the RPC round trip without changing any booking.
  const sessionId = crypto.randomUUID();
  try {
    const opened = await withTimeout(
      (signal) =>
        fetch(endpoint, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ tool: "get_clinic_info", args: { session_id: sessionId } }),
        }),
      8000,
    );
    const envelope = await opened.json();
    if (envelope && envelope.ok === true) {
      record("PASS", "booking service", `get_clinic_info returned ok for a fresh session (${sessionId})`);
    } else if (envelope && envelope.ok === false && envelope.error && envelope.error.code === "NOT_FOUND") {
      record(
        "WARN",
        "booking service",
        "authenticated call reached the database but the session was unknown — the bridge opens sessions via clinic_open_session; run a real conversation to confirm",
      );
    } else {
      record("FAIL", "booking service", `unexpected envelope: ${JSON.stringify(envelope).slice(0, 300)}`);
    }
  } catch (error) {
    record("FAIL", "booking service", error instanceof Error ? error.message : String(error));
  }
}

async function checkSpeech() {
  const asrUrl = env("CLINIC_ASR_URL") || "http://localhost:8000/v1";
  try {
    const response = await withTimeout((signal) => fetch(`${asrUrl.replace(/\/$/, "")}/models`, { signal }), 4000);
    if (response.ok) {
      record("PASS", "speech input (ASR)", `${asrUrl} answered ${response.status}`);
    } else {
      record("WARN", "speech input (ASR)", `${asrUrl} answered ${response.status}; set the ASR URL under Settings -> Voice & Agents`);
    }
  } catch {
    record(
      "UNVERIFIED",
      "speech input (ASR)",
      `no Whisper-compatible server at ${asrUrl}. Start one, then set ASR URL under Settings -> Voice & Agents. Typing the Arabic phrases by hand tests the same path.`,
    );
  }
  record(
    "UNVERIFIED",
    "speech output (TTS)",
    "device voices and Kokoro cannot be checked from Node. In the console pick TTS = device voice with an ar-EG/ar-SA voice installed; Kokoro's default voice is English. See openclaw/README.md section 7.",
  );
}

async function main() {
  console.log("Clinic reception preflight\n");
  const loaded = loadEnvFile();
  const tenantSlug = env("CLINIC_TENANT_SLUG") || "demo-dental";

  checkEnvironment(loaded ? ".env" : null);
  await checkDatabase(tenantSlug);
  await checkGateway();
  await checkAgent();
  await checkPortConsistency();
  await checkTools();
  await checkSpeech();

  const failed = results.filter((r) => r.status === "FAIL").length;
  const warned = results.filter((r) => r.status === "WARN").length;
  const unverified = results.filter((r) => r.status === "UNVERIFIED").length;
  console.log(`\n${results.length - failed - warned - unverified} passed, ${failed} failed, ${warned} warnings, ${unverified} unverified.`);
  if (failed) {
    console.log("Fix the FAIL lines above before a demo. UNVERIFIED lines need a human at the machine.");
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
