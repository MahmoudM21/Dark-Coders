#!/usr/bin/env node
// Model A/B: screen-contract and tool-call conformance on identical scripted turns.
//
//   CLINIC_AB_MODEL_OVERRIDE=1 (on the app server) npm run clinic:model-ab
//   CLINIC_AB_ONLY=nemotron npm run clinic:model-ab      # one model
//
// Requires the app running with CLINIC_AB_MODEL_OVERRIDE=1 (the bridge refuses the
// x-clinic-backend-model header otherwise), a live gateway with the clinic agent and
// the clinic MCP server, and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
//
// Each model gets its own session and the SAME scripted conversation, sent exactly the
// way the console sends it: the whole visible history, one user turn at a time. Per turn
// it records latency, whether the reply satisfies the screen contract, which clinic
// tools the audit log says ran, and any observable drift:
//
//   * reply in the wrong language for the turn they are answering
//   * re-asking for a name or phone number the caller already gave
//   * a screen the bridge had to repair, or one that failed validation outright
//   * duplicate/too many options, emoji or markdown in spoken text
//
// It prints a table, per-model medians/p90 and a conformance pass rate, then writes the
// full result to docs/model-ab-results.json. It never writes a model's claim into the
// report: tool counts come from audit_events via the bridge's turn_timing event.

import { existsSync, readFileSync, writeFileSync } from "node:fs";

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

const APP = (env("CLINIC_API_URL") || "http://localhost:8080").replace(/\/$/, "");
const TURN_TIMEOUT_MS = Number(env("CLINIC_AB_TIMEOUT_MS") || 180000);

const MODELS = [
  { key: "nemotron", id: "nvidia/nvidia/nemotron-3-super-120b-a12b" },
  { key: "gemini", id: "google/gemini-3.8-flash" },
];

/** A realistic conversation: the points where a receptionist model drifts. */
const SCRIPT = [
  { label: "booking request", text: "أهلاً، عايز أحجز كشف أسنان", lang: "ar" },
  { label: "branch", text: "فرع المقطم", lang: "ar" },
  { label: "name", text: "اسمي محمد علي", lang: "ar" },
  { label: "phone", text: "رقمي 01001112223", lang: "ar" },
  { label: "preferred time", text: "عايز السبت بعد 5", lang: "ar" },
  { label: "choose first slot", text: "اختار أول ميعاد", lang: "ar" },
  { label: "language switch", text: "What are your opening hours?", lang: "en" },
  { label: "urgent pain", text: "عندي ألم شديد", lang: "ar" },
];

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\u{20E3}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{200D}]/u;
const MARKDOWN = /[#*_`]|!?\[[^\]]*\]\(/;
const ARABIC = /[\u0600-\u06FF]/;

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** Contract checks the bridge and eval-conversations.mjs both enforce. */
function checkScreen(raw) {
  const issues = [];
  let screen = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.kind !== "screen" && parsed.kind !== "action_proposal") issues.push("kind is not screen");
    screen = parsed.screen;
    if (!screen || typeof screen.text !== "string" || !screen.text.trim()) issues.push("screen.text missing");
    else if (screen.text.length > 240) issues.push(`screen.text is ${screen.text.length} chars (max 240)`);
    const choices = Array.isArray(screen.choices) ? screen.choices : [];
    const navigation = Array.isArray(screen.navigation) ? screen.navigation : [];
    if (choices.length + navigation.length > 4) issues.push(`${choices.length + navigation.length} choices+navigation (max 4)`);
    const ids = choices.map((choice) => choice?.id);
    if (new Set(ids).size !== ids.length) issues.push("duplicate choice ids");
    for (const choice of choices) {
      if (typeof choice?.id !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(choice.id)) issues.push(`bad choice id ${JSON.stringify(choice?.id)}`);
      if (typeof choice?.label !== "string" || !choice.label || choice.label.length > 40) issues.push("bad choice label");
    }
    for (const [field, value] of [
      ["text", screen.text],
      ...choices.flatMap((choice, index) => [
        [`choices[${index}].label`, choice?.label],
        [`choices[${index}].value`, choice?.value],
      ]),
    ]) {
      if (typeof value !== "string") continue;
      if (EMOJI.test(value)) issues.push(`${field} has an emoji`);
      if (MARKDOWN.test(value)) issues.push(`${field} has markdown`);
    }
  } catch (error) {
    issues.push(`not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { screen, issues };
}

function parseEvents(body) {
  const events = [];
  for (const chunk of body.split(/\n\n+/)) {
    const line = chunk.split("\n").map((value) => value.trim()).find((value) => value.startsWith("data:"));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()));
    } catch {
      /* partial */
    }
  }
  return events;
}

function redact(text) {
  return String(text).replace(/\+?\d[\d\s-]{5,}\d/g, "[number]").slice(0, 160);
}

async function runTurn(modelId, turns, sessionId) {
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${APP}/api/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "accept-language": "ar-EG",
        "x-clinic-backend-model": modelId,
      },
      body: JSON.stringify({ model: "openclaw/clinic-receptionist", turns, session_id: sessionId, context: "" }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
  } catch (error) {
    return { error: `no HTTP answer after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}` };
  }
  const body = await response.text();
  if (!response.ok) {
    return { error: `HTTP ${response.status}: ${body.slice(0, 200)}`, status: response.status };
  }
  const events = parseEvents(body);
  const done = events.filter((event) => event.type === "response.output_text.done").at(-1);
  const timing = events.filter((event) => event.type === "bridge.timing").at(-1)?.timing ?? null;
  if (!done?.text) return { error: "missing response.output_text.done", ms: Date.now() - started, timing };
  return { raw: done.text, ms: Date.now() - started, timing };
}

function drift(turn, screen, history) {
  const issues = [];
  const text = screen?.text ?? "";
  // The bridge's own error and busy screens are deliberately in the session locale; judging
  // their language would report a drift the model never produced.
  const bridgeSays = /(تعذر إكمال هذه الخطوة|الخدمة مشغولة|That step could not be completed|The service is busy)/.test(text);
  if (bridgeSays) return issues;
  const expectsArabic = turn.lang === "ar";
  const hasArabic = ARABIC.test(text);
  if (expectsArabic && !hasArabic) issues.push("replied in English to an Arabic turn");
  if (!expectsArabic && hasArabic && !/[a-z]{4}/i.test(text)) issues.push("replied in Arabic to an English turn");

  const saidName = history.some((entry) => /اسمي|اسمى/.test(entry.text));
  const saidPhone = history.some((entry) => /01\d{9}|\+20\d{9,}/.test(entry.text));
  if (saidName && /(اسمك|اسم حضرتك|your (full )?name)/i.test(text) && !/اسمي/.test(text)) {
    issues.push("re-asks for the name");
  }
  if (saidPhone && /(رقم (ال)?موبايل|رقم (ال)?تليفون|رقم (ال)?هاتف|phone number|mobile number)/i.test(text)) {
    issues.push("re-asks for the phone number");
  }
  return issues;
}

async function runModel(model) {
  const sessionId = crypto.randomUUID();
  const history = [];
  const rows = [];
  console.log(`\n=== ${model.key} (${model.id}) — session ${sessionId} ===`);
  for (const turn of SCRIPT) {
    const turns = [...history, { role: "user", text: turn.text }];
    const result = await runTurn(model.id, turns, sessionId);
    if (result.error) {
      rows.push({ label: turn.label, ms: result.ms ?? null, tools: null, issues: [result.error], text: "", valid: false });
      console.log(`  [${turn.label}] ${result.error}`);
      history.push({ role: "user", text: turn.text });
      continue;
    }
    const { screen, issues } = checkScreen(result.raw);
    const turnIssues = [...issues, ...drift(turn, screen, turns)];
    // The bridge's own fallback screen is valid JSON but it means no model answer was used:
    // counting it as a contract pass would hide a failed turn.
    if (screen?.text === "تعذر إكمال هذه الخطوة. آخر حالة مؤكدة لم تتغير." || screen?.text === "That step could not be completed. Your last confirmed state is unchanged.") {
      turnIssues.push("bridge error screen — no model answer");
    }
    if (!result.timing) turnIssues.push("no bridge.timing event (error path)");
    if (screen?.text === "الخدمة مشغولة دلوقتي، جرّب بعد ثواني." || screen?.text === "The service is busy right now. Please try again in a few seconds.") {
      turnIssues.push("provider busy screen (429) — no answer");
    }
    if (result.timing?.repair_used) turnIssues.push("bridge repaired the screen");
    const tools = typeof result.timing?.tool_calls === "number" ? result.timing.tool_calls : null;
    rows.push({
      label: turn.label,
      ms: result.ms,
      tools,
      issues: turnIssues,
      text: screen?.text ?? "",
      valid: turnIssues.length === 0,
      timing: result.timing,
    });
    console.log(
      `  [${turn.label}] ${result.ms} ms · ${tools ?? "n/a"} tool call(s) · ${turnIssues.length ? "DRIFT: " + turnIssues.join("; ") : "contract ok"}`,
    );
    if (screen?.text) console.log(`      said: ${redact(screen.text)}`);
    history.push({ role: "user", text: turn.text });
    if (screen?.text) history.push({ role: "assistant", text: screen.text });
  }
  return { model: model.id, key: model.key, sessionId, rows };
}

async function main() {
  loadEnvFile();
  const only = env("CLINIC_AB_ONLY");
  const models = only ? MODELS.filter((model) => model.key === only || model.id === only) : MODELS;
  if (!models.length) {
    console.error(`CLINIC_AB_ONLY must be one of: ${MODELS.map((model) => model.key).join(", ")}`);
    process.exit(2);
  }

  try {
    const health = await fetch(`${APP}/`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (error) {
    console.error(`No live app at ${APP} (${error instanceof Error ? error.message : String(error)}). Start it with: npm run dev`);
    process.exit(2);
  }

  const results = [];
  for (const model of models) results.push(await runModel(model));

  console.log("\n| Model | Turn | ms | Tool calls | Contract | Drift |");
  console.log("|---|---|---|---|---|---|");
  for (const result of results) {
    for (const row of result.rows) {
      console.log(
        `| ${result.key} | ${row.label} | ${row.ms ?? "n/a"} | ${row.tools ?? "n/a"} | ${row.valid ? "PASS" : "FAIL"} | ${row.issues.join("; ") || "—"} |`,
      );
    }
  }

  console.log("\nSummary");
  for (const result of results) {
    const latencies = result.rows.map((row) => row.ms).filter((value) => typeof value === "number");
    const passed = result.rows.filter((row) => row.valid).length;
    const toolCalls = result.rows.reduce((sum, row) => sum + (typeof row.tools === "number" ? row.tools : 0), 0);
    console.log(
      `  ${result.key}: contract ${passed}/${result.rows.length} · median ${percentile(latencies, 50)} ms · p90 ${percentile(latencies, 90)} ms · ${toolCalls} tool call(s) total`,
    );
    const drifts = result.rows.flatMap((row) => row.issues.map((issue) => `${row.label}: ${issue}`));
    if (drifts.length) console.log(`    drift: ${drifts.join(" | ")}`);
  }

  const output = { generatedAt: new Date().toISOString(), app: APP, script: SCRIPT, results };
  writeFileSync("docs/model-ab-results.json", JSON.stringify(output, null, 2));
  console.log("\nWrote docs/model-ab-results.json (tool counts from audit_events; assistant text only).");
  console.log("Reset the demo data afterwards: psql \"$DATABASE_URL\" -f supabase/reset_demo.sql");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
