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
    ["CLINIC_API_URL", "not set — defaulting to http://localhost:3000 for the tools check"],
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

async function checkAgent() {
  const url = env("OPENCLAW_GATEWAY_URL");
  if (!url) {
    record("UNVERIFIED", "agent clinic-receptionist", "needs OPENCLAW_GATEWAY_URL");
    return;
  }
  try {
    const response = await withTimeout(
      (signal) =>
        fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
          method: "POST",
          signal,
          headers: {
            "Content-Type": "application/json",
            ...(env("OPENCLAW_API_KEY") ? { Authorization: `Bearer ${env("OPENCLAW_API_KEY")}` } : {}),
          },
          body: JSON.stringify({
            model: "openclaw/clinic-receptionist",
            stream: false,
            max_tokens: 1,
            messages: [{ role: "user", content: "ping" }],
          }),
        }),
      15000,
    );
    const body = (await response.text()).slice(0, 300);
    if (response.ok) {
      record("PASS", "agent clinic-receptionist", `gateway accepted model openclaw/clinic-receptionist (HTTP ${response.status})`);
    } else {
      record(
        "FAIL",
        "agent clinic-receptionist",
        `HTTP ${response.status}: ${body} — merge openclaw/openclaw.json5 into ~/.openclaw/openclaw.json and enable gateway.http.endpoints.chatCompletions.enabled`,
      );
    }
  } catch (error) {
    record("FAIL", "agent clinic-receptionist", error instanceof Error ? error.message : String(error));
  }
}

async function checkTools() {
  const base = env("CLINIC_API_URL") || "http://localhost:3000";
  const token = env("CLINIC_TOOLS_TOKEN");
  if (!token) {
    record("UNVERIFIED", "booking service", "set CLINIC_TOOLS_TOKEN, then rerun");
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
