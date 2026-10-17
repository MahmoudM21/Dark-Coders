#!/usr/bin/env node
// Per-turn latency probe for the clinic voice path.
//
//   npm run clinic:latency
//   CLINIC_LATENCY_LABEL=nemotron npm run clinic:latency     # label this run
//   CLINIC_LATENCY_LABEL=stateless npm run clinic:latency
//   CLINIC_LATENCY_LABEL=agent-scoped CLINIC_GATEWAY_SESSION=agent-scoped npm run clinic:latency
//
// It drives four voice-like turns (what a caller says, not tool names) through the
// REAL /api/agent bridge and prints, per turn:
//   * ms to the first reasoning delta (the moment the console can show progress)
//   * ms to response.output_text.done (the moment the answer is ready to speak)
//   * how many clinic tool calls happened in that window, counted from audit_events
//     for the session between the request's start and end timestamps (the timestamp
//     column is `at`; there is no `created_at` on that table)
//
// It needs a live app (npm run dev), a live OpenClaw gateway with the clinic agent
// registered, and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY to read audit_events. If
// any of those is missing it refuses and says so: it never prints invented numbers.
// A turn whose answer came from the bridge's error path (no model reply) is not a
// latency measurement: if every turn failed that way the probe refuses instead of
// printing a table, and if only some did it marks those rows as error-path timings.
// The bridge records both cases in audit_events as actor 'bridge' with event
// 'bridge_error' (the model call threw) or 'upstream_429' (provider rate-limited).
//
// It WRITES to the database (a session, a patient, a hold). Reset afterwards with
// supabase/reset_demo.sql.
//
// To compare models, change the agent's primary model in ~/.openclaw/openclaw.json
// (or run the curl A/B in openclaw/README.md section 2 for a single request),
// restart the gateway, and run this again with a different CLINIC_LATENCY_LABEL.

import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(path = ".env") {
  if (!existsSync(path)) return false;
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return true;
}

function env(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function refuse(reason, howTo) {
  console.error("\nRefusing to measure: " + reason);
  if (howTo) console.error(howTo);
  console.error("No numbers were produced for this run.");
  process.exit(2);
}

const BASE = (env("CLINIC_API_URL") || "http://localhost:3000").replace(/\/$/, "");
const LABEL = env("CLINIC_LATENCY_LABEL") || "current agent configuration";
const SESSION_MODE = env("CLINIC_GATEWAY_SESSION") || "stateless";

/** One turn, phrased the way an Egyptian-Arabic caller would say it out loud. */
const SCRIPT = [
  { label: "first turn (greeting)", text: "أهلاً" },
  { label: "what's available?", text: "إيه المواعيد المتاحة؟" },
  { label: "branch choice", text: "فرع المقطم" },
  { label: "booking with a hold", text: "اسمي محمد علي ورقمي 01001112223 وعايز أحجز السبت الساعة 6" },
];

function parseSseChunk(chunk) {
  const events = [];
  for (const segment of chunk.split("\n")) {
    if (!segment.startsWith("data:")) continue;
    const payload = segment.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      /* partial line */
    }
  }
  return events;
}

async function runTurn(text, sessionId, history) {
  const started = Date.now();
  const response = await fetch(BASE + "/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "accept-language": "ar-EG" },
    body: JSON.stringify({
      model: "openclaw/clinic-receptionist",
      turns: [...history, { role: "user", text }],
      session_id: sessionId,
      context: "",
    }),
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    return { started, ended: Date.now(), error: "HTTP " + response.status + ": " + detail };
  }

  let firstReasoningMs = null;
  let answerMs = null;
  let screen = null;
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += next.value;
    const segments = buffer.split("\n");
    buffer = segments.pop() ?? "";
    for (const event of parseSseChunk(segments.join("\n"))) {
      if (event.type === "response.reasoning_summary_text.delta" && firstReasoningMs === null) {
        firstReasoningMs = Date.now() - started;
      }
      if (event.type === "response.output_text.done") {
        answerMs = Date.now() - started;
        try {
          screen = JSON.parse(event.text);
        } catch {
          screen = null;
        }
      }
    }
  }

  return { started, ended: Date.now(), firstReasoningMs, answerMs, screen, error: null };
}

async function readAuditWindow(supabase, sessionId, started, ended) {
  const { data, error } = await supabase
    .from("audit_events")
    .select("event,actor,tool,error_code,at")
    .eq("session_id", sessionId)
    .gte("at", new Date(started).toISOString())
    .lte("at", new Date(ended + 2000).toISOString());
  if (error) return { error: error.message, count: null, rows: [] };
  const rows = data ?? [];
  return { count: rows.length, rows, error: null };
}

/** A turn that never reached the model: the bridge fell back to a truthful screen. */
function modelFailure(rows) {
  const hit = rows.find(
    (row) => row.actor === "bridge" && (row.event === "bridge_error" || row.event === "upstream_429"),
  );
  if (!hit) return null;
  return hit.event + (hit.error_code ? " (" + hit.error_code + ")" : "");
}

function firstNote(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return "";
}

async function main() {
  loadEnvFile();
  console.log("Clinic latency probe — label: " + LABEL);
  console.log("Bridge: " + BASE + "/api/agent\n");
  console.log("Gateway session mode: " + SESSION_MODE);

  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    refuse(
      "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set, so clinic tool calls cannot be counted.",
      "Put them in .env (the scratch project), then rerun: npm run clinic:latency",
    );
  }
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const health = await fetch(BASE + "/", { signal: AbortSignal.timeout(5000) });
    if (!health.ok) refuse("the app at " + BASE + " answered HTTP " + health.status + ".");
  } catch (error) {
    refuse(
      "no live app at " + BASE + " (" + (error instanceof Error ? error.message : String(error)) + ").",
      "Start the app first: npm run dev  — and make sure the OpenClaw gateway is running with the clinic-receptionist agent." +
        " If the app is on another port, set CLINIC_API_URL (it tried " + BASE + ").",
    );
  }

  const preflight = await fetch(BASE + "/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "accept-language": "ar-EG" },
    body: JSON.stringify({ model: "openclaw/clinic-receptionist", turns: [{ role: "user", text: "ping" }], session_id: "preflight-" + Date.now(), context: "" }),
  });
  if (preflight.status === 502) {
    refuse(
      "the bridge cannot reach the OpenClaw gateway (HTTP 502): " + (await preflight.text()).slice(0, 200),
      "Start the gateway (~/.openclaw) with NVIDIA_API_KEY set, then rerun: npm run clinic:latency",
    );
  }
  await preflight.text();

  const sessionId = crypto.randomUUID();
  const history = [];
  const rows = [];
  for (const step of SCRIPT) {
    const turn = await runTurn(step.text, sessionId, history);
    const audit = await readAuditWindow(supabase, sessionId, turn.started, turn.ended);
    const failure = modelFailure(audit.rows);
    rows.push({
      label: step.label,
      firstReasoning: turn.firstReasoningMs,
      answer: turn.answerMs,
      tools: audit.count,
      failure,
      notes: firstNote(
        turn.error,
        audit.error,
        failure ? failure + " — answer came from the bridge, not the model" : "",
        turn.screen && turn.screen.kind !== "screen" ? "non-screen answer" : "",
      ),
    });
    console.log("[" + step.label + "] " + (turn.error ? turn.error : "turn " + step.text));
    if (turn.screen && turn.screen.screen && turn.screen.screen.text) {
      console.log("    spoke: " + String(turn.screen.screen.text).slice(0, 120));
    }
    history.push({ role: "user", text: step.text });
    if (turn.screen && turn.screen.screen && typeof turn.screen.screen.text === "string") {
      history.push({ role: "assistant", text: turn.screen.screen.text });
    }
  }

  if (rows.length > 0 && rows.every((row) => row.failure !== null)) {
    refuse(
      "every turn was answered by the bridge's error path, so there is no model latency to report: " +
        rows[0].failure +
        ".",
      "Start the OpenClaw gateway with the clinic-receptionist agent (NVIDIA_API_KEY set) and rerun: npm run clinic:latency",
    );
  }
  const errorPathTurns = rows.filter((row) => row.failure !== null);
  if (errorPathTurns.length > 0) {
    console.error(
      "\nWARNING: " +
        String(errorPathTurns.length) +
        " of " +
        String(rows.length) +
        " turns never reached the model (" +
        errorPathTurns.map((row) => row.label + ": " + row.failure).join("; ") +
        "). Those rows are error-path timings, not model latency.\n",
    );
  }

  const headers = ["Turn", "First reasoning (ms)", "Answer ready (ms)", "Clinic tool calls", "Notes"];
  const table = [headers].concat(
    rows.map((row) => [
      row.label,
      row.firstReasoning === null ? "n/a" : String(row.firstReasoning),
      row.answer === null ? "n/a" : String(row.answer),
      row.tools === null ? "n/a" : String(row.tools),
      row.notes,
    ]),
  );
  const widths = headers.map((_, column) => Math.max(...table.map((line) => line[column].length)));
  console.log("\n| " + table[0].map((cell, i) => cell.padEnd(widths[i])).join(" | ") + " |");
  console.log("|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|");
  for (const line of table.slice(1)) {
    console.log("| " + line.map((cell, i) => cell.padEnd(widths[i])).join(" | ") + " |");
  }

  console.log("\nSession: " + sessionId + " (label: " + LABEL + ")");
  console.log("Record these numbers in docs/TESTING.md and reset the demo data with supabase/reset_demo.sql.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
