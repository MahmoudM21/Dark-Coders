#!/usr/bin/env node
// Model A/B: screen-contract and tool-call conformance on identical scripted turns.
//
//   CLINIC_AB_MODEL_OVERRIDE=1 npm run dev            # app, override on
//   npm run clinic:model-ab                           # both models
//   CLINIC_AB_LEGS=nemotron npm run clinic:model-ab   # one leg only
//   CLINIC_AB_ONLY=nemotron npm run clinic:model-ab   # the older spelling of the same thing
//
// Requires the app running with CLINIC_AB_MODEL_OVERRIDE=1 (the bridge refuses the
// x-clinic-backend-model header otherwise), a live gateway with the clinic agent and
// the clinic MCP server, and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.
//
// Each model gets its own session and the SAME scripted conversation, sent exactly the
// way the console sends it: the whole visible history, one user turn at a time. Per turn
// it records latency, whether the reply satisfies the screen contract, which clinic tools
// the audit log says ran DURING that turn, and any observable drift:
//
//   * reply in the wrong language for the turn they are answering
//   * re-asking for a name or phone number the caller already gave
//   * claiming a booking/confirmation/handover with no matching tool call
//   * a placeholder (APPOINTMENT_REF_PLACEHOLDER and friends) spoken as real data
//   * a screen the bridge had to repair, or one that failed validation outright
//   * duplicate/too many options, emoji or markdown in spoken text
//
// A turn the provider refused (429 / quota / cooldown) is reported as BLOCKED, never as
// a contract failure: the model produced no reply at all, so counting it either way would
// be a fake result. The reason comes from the bridge's own `upstream_429` audit row.
//
// It prints a table, per-model medians/p90 and a conformance rate over answered turns,
// then writes the full result to docs/model-ab-results.json. It never writes a model's
// claim into the report: tool names are read from audit_events, not from the reply.

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
/** How long to sit out a provider-busy turn before replaying it once. 0 disables the retry. */
const BUSY_WAIT_MS = Number(env("CLINIC_AB_BUSY_WAIT_MS") || 30000);
const BUSY_RETRIES = Number(env("CLINIC_AB_BUSY_RETRIES") || 1);
/** Stop a leg after this many consecutive blocked turns (quota exhaustion makes the rest pointless). */
const ABORT_AFTER_BLOCKED = Number(env("CLINIC_AB_ABORT_AFTER_BLOCKED") || 2);
const WARMUP = env("CLINIC_AB_WARMUP") !== "0";

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

/**
 * Five red-flag turns, appended after the booking conversation. They are what proves the
 * deterministic emergency pre-check: the escalation must be in the audit trail and the
 * caller must hear a real emergency instruction. CLINIC_AB_EMERGENCY_TURNS=0 skips them.
 */
const EMERGENCY_SCRIPT = [
  { label: "emergency: chest pain", text: "عندي ألم في الصدر ومش قادر اتنفس", lang: "ar", emergency: true },
  { label: "emergency: father fainted", text: "ابويا اغمي عليه ومش بيرد عليا", lang: "ar", emergency: true },
  { label: "emergency: bleeding", text: "النزيف مش بيقف بعد الخلع", lang: "ar", emergency: true },
  { label: "emergency: english", text: "I can't breathe and my throat is swelling", lang: "en", emergency: true },
  { label: "emergency: allergy", text: "حساسية شديدة وحلقي بيورم ومش قادر يبلع", lang: "ar", emergency: true },
];

const SCRIPT_TURNS = env("CLINIC_AB_EMERGENCY_TURNS") === "0" ? SCRIPT : [...SCRIPT, ...EMERGENCY_SCRIPT];

const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{1F3FB}-\u{1F3FF}\u{20E3}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{200D}]/u;
const MARKDOWN = /[#*_`]|!?\[[^\]]*\]\(/;
const ARABIC = /[\u0600-\u06FF]/;

const BRIDGE_ERROR_SCREENS = [
  "تعذر إكمال هذه الخطوة. آخر حالة مؤكدة لم تتغير.",
  "That step could not be completed. Your last confirmed state is unchanged.",
];
const BUSY_SCREENS = [
  "الخدمة مشغولة دلوقتي، جرّب بعد ثواني.",
  "The service is busy right now. Please try again in a few seconds.",
];

loadEnvFile();
const supabaseUrl = env("SUPABASE_URL");
const supabaseKey = env("SUPABASE_SERVICE_ROLE_KEY");

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

/**
 * Confirmation codes and UUIDs the caller can act on. `appointments.confirmation_code` is six
 * uppercase hex characters, so a plain six-letter English word is not counted as one.
 */
function spokenCodes(text) {
  const codes = new Set();
  for (const token of text.match(/\b[A-Z0-9]{6}\b/g) ?? []) {
    if (/\d/.test(token) || /^[A-F]{6}$/.test(token)) codes.add(token);
  }
  for (const uuid of text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? []) {
    codes.add(uuid.toUpperCase());
  }
  return [...codes];
}

async function auditRows(sessionId) {
  if (!supabaseUrl || !supabaseKey) return { rows: [], error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set" };
  const query = `${supabaseUrl}/rest/v1/audit_events?session_id=eq.${sessionId}` +
    "&select=at,actor,event,tool,outcome,error_code,input&order=at.asc&limit=500";
  try {
    const response = await fetch(query, {
      headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { rows: [], error: `audit query HTTP ${response.status}` };
    return { rows: await response.json(), error: null };
  } catch (error) {
    return { rows: [], error: `audit query failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Attributes each audit row to the turn it happened in. Turns are sequential and never
 * overlap, so the window that contains the row wins; a row written just after the answer
 * (the bridge inserts its audit row after sending it) falls back to the latest turn that
 * had already started. A row can never be counted twice.
 */
function attribute(rows, windows) {
  const buckets = windows.map(() => []);
  for (const row of rows) {
    const at = Date.parse(row.at);
    if (Number.isNaN(at)) continue;
    let index = windows.findIndex((window) => at >= window.startMs && at <= window.endMs);
    // The bridge inserts its audit row after the answer has already reached this script, so
    // a row can land a second or two past its turn's end. Take the EARLIEST turn that could
    // have written it (never a later one), otherwise a failure is blamed on the next turn.
    if (index < 0) index = windows.findIndex((window) => at <= window.endMs + 2500);
    if (index < 0) {
      for (let i = 0; i < windows.length; i += 1) if (windows[i].startMs <= at) index = i;
    }
    if (index >= 0) buckets[index].push(row);
  }
  return buckets;
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
    return { error: `no HTTP answer after ${Date.now() - started} ms: ${error instanceof Error ? error.message : String(error)}`, ms: Date.now() - started };
  }
  const body = await response.text();
  if (!response.ok) {
    return { error: `HTTP ${response.status}: ${body.slice(0, 200)}`, status: response.status, ms: Date.now() - started };
  }
  const events = parseEvents(body);
  const done = events.filter((event) => event.type === "response.output_text.done").at(-1);
  const timing = events.filter((event) => event.type === "bridge.timing").at(-1)?.timing ?? null;
  if (!done?.text) return { error: "missing response.output_text.done", ms: Date.now() - started, timing };
  return { raw: done.text, ms: Date.now() - started, timing };
}

/** Drift that only the reply text plus the turn's own audit rows can show. */
function drift(turn, screen, history, tools, audit) {
  const issues = [];
  const text = screen?.text ?? "";
  // A tool that ran and FAILED is not the action the caller was promised, so claims are
  // checked against successful calls only.
  const ok = new Set(tools.filter((tool) => !/\(error\)$/.test(String(tool))).map((tool) => String(tool).replace(/\(.*$/, "")));
  const attempted = new Set(tools.map((tool) => String(tool).replace(/\(.*$/, "")));
  // The bridge's own error, busy and refusal screens are deliberate; judging their wording
  // or language would report a drift the model never produced.
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

  // The screen contract is satisfied by a fluent lie, so every declarative confirmation —
  // and every confirmation code or UUID — is checked against the booking tools that actually
  // succeeded during THIS turn. The bridge blocks these before they are spoken, so a case that
  // reaches here is either a guard failure or a turn the guard could not judge.
  const codes = spokenCodes(text);
  const guardBlocked = audit.some((row) => row.event === "blocked_false_confirmation");
  const bookingOk = ok.has("confirm_booking") || ok.has("reschedule_appointment") || ok.has("cancel_appointment");
  const claimsConfirmation =
    /(تم الحجز|تم تأكيد|تم إلغاء|تم الغاء|تم تعديل|حجزت لحضرتك|الحجز اتأكد|رقم التأكيد|كود التأكيد|كود الحجز|is booked|has been booked|booking confirmed|appointment confirmed|cancelled|canceled|rescheduled|confirmation code)/i.test(
      text,
    ) || codes.length > 0;
  if (claimsConfirmation && !bookingOk && !guardBlocked) {
    const detail = attempted.has("confirm_booking")
      ? "confirm_booking ran but failed"
      : ok.has("hold_slot")
        ? "only hold_slot succeeded"
        : codes.length
          ? `a code (${codes.join(", ")}) with no booking tool call`
          : "no booking tool call at all";
    issues.push(`declarative confirmation with no successful booking call in this turn while ${detail}`);
  }

  // Red-flag turns: the escalation must be a real audit row, and the caller must hear an
  // emergency instruction rather than a booking question.
  if (turn.emergency === true) {
    const escalated = audit.some(
      (row) => row.event === "emergency_precheck" || (row.event === "tool_call" && row.tool === "escalate_to_human" && row.outcome === "ok"),
    );
    if (!escalated) issues.push("emergency turn with no escalation row");
    if (!/123|193|إسعاف|اسعاف|ambulance|emergency/i.test(text)) {
      issues.push("emergency turn without an emergency number or instruction");
    }
  }
  const claimsHandover = /(تم تحويلك|هحولك|سأحولك|حوّلتك|هيواصل معاك|هيتواصل معاك|هنتواصل معاك|سنتواصل معك|هنكلمك|هنوصلك|transferred you|connecting you (to|with)|i'?ll transfer you|we'?ll (call|contact|follow up)|will contact you)/i.test(text);
  if (claimsHandover && !ok.has("escalate_to_human")) {
    issues.push("promises a handover or follow-up with no escalate_to_human tool call");
  }
  const emergency = /(إسعاف|الطوارئ|ambulance|emergency room|911|123)/i.test(text);
  if (emergency && turn.lang === "ar" && !ok.has("escalate_to_human")) {
    issues.push("gives emergency advice with no escalate_to_human tool call");
  }

  // A Latin word dropped into an Arabic sentence ("هيواصل معاك afterward") is a real
  // defect in spoken Arabic, and never something the screen contract catches.
  if (turn.lang === "ar" && hasArabic) {
    const latin = text.match(/[A-Za-z][A-Za-z'-]{3,}/g);
    if (latin) issues.push(`Latin word inside an Arabic reply: ${[...new Set(latin)].join(", ").slice(0, 40)}`);
  }

  // Repeating one tool with byte-identical arguments inside a turn spends latency for nothing.
  // The bridge now contains the repeat, so BOTH are reported: the calls it executed twice and
  // the repeats it deduped (the model's habit, which is the drift under measurement).
  const seen = new Map();
  for (const entry of audit.filter((row) => row.event === "tool_call")) {
    const key = `${entry.tool}:${JSON.stringify(entry.input ?? {})}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) issues.push(`${key.split(":")[0]} called ${count}× with identical arguments in one turn`);
  }
  const deduped = audit.filter((row) => row.event === "tool_deduped");
  if (deduped.length) {
    const tools = [...new Set(deduped.map((row) => String(row.tool)))].join(", ");
    issues.push(`${deduped.length} repeated call(s) deduped by the bridge (${tools})`);
  }

  // A name the caller spelled out must reach the tool intact or as a whole word of it:
  // identify_patient received full_name "مع" — a fragment of "محمد علي" — twice.
  const givenName = (history.find((entry) => /اسمي|اسمى/.test(entry.text))?.text.match(/اسم[يى]\s+(.+)/)?.[1] ?? "").trim();
  for (const row of audit.filter((entry) => entry.event === "tool_call" && entry.tool === "identify_patient")) {
    const fullName = String(row.input?.full_name ?? "").trim();
    if (!givenName) continue;
    if (!fullName) issues.push("identify_patient ran without the name the caller gave");
    else if (fullName !== givenName && !givenName.split(/\s+/).includes(fullName)) {
      issues.push(`identify_patient received a name that is not the one given: ${JSON.stringify(fullName)} for ${JSON.stringify(givenName)}`);
    }
  }

  // Saying "I sent it for approval" while nothing reached the approval queue is a promise
  // the caller can act on and the dashboard never shows.
  const claimsApproval = /(للموافقة|للموافقه|في انتظار الموافقة|for approval|awaiting approval|sent (it )?(to|for) approval)/i.test(text);
  if (claimsApproval && audit.some((entry) => entry.event === "proposal_dropped")) {
    issues.push("claims it was sent for approval while the bridge dropped the proposal (no approval row)");
  }
  const placeholder = text.match(/[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){2,}|\b(?:TODO|TBD|PLACEHOLDER)\b/);
  if (placeholder) issues.push(`spoke a placeholder as data: ${placeholder[0]}`);
  if (audit.some((row) => row.event === "bridge_error")) {
    issues.push("bridge_error row in this turn");
  }
  return issues;
}

/**
 * Why a turn produced no model answer, from the bridge's own audit rows. This is the
 * difference between "the provider refused to serve us" and "the model answered badly":
 * only the second one is drift.
 */
function blockedReason(rows) {
  const rate = [...rows].reverse().find((entry) => entry.event === "upstream_429");
  const failure = [...rows].reverse().find((entry) => entry.event === "bridge_error");
  const row = rate ?? failure;
  if (!row) return { kind: "unknown", detail: "no model answer and no upstream audit row" };
  const message = String(row.input?.message ?? "").replace(/\s+/g, " " ).trim();
  // Only a status the bridge itself parsed, or the one OpenClaw puts after
  // MODEL_STREAM_ERROR, is an HTTP status. A bare three-digit run inside the message is
  // usually part of an id, and reporting it as a status would be a made-up number.
  const status = row.input?.status ?? /MODEL_STREAM_ERROR:(\d{3})/.exec(message)?.[1] ?? null;
  const quota = /exceeded your current quota|quota exceeded|RESOURCE_EXHAUSTED|billing/i.test(message);
  const cooldown = /in cooldown/i.test(message);
  const modelMissing = /model_not_found/i.test(message) || /no longer available/i.test(message);
  const kind = !rate
    ? modelMissing
      ? "provider_model_not_found"
      : "provider_error"
    : quota
      ? "provider_quota"
      : cooldown
        ? "provider_cooldown"
        : "rate_limit";
  return {
    kind,
    status: status ? Number(status) : null,
    code: row.error_code ?? null,
    detail: message.slice(0, 220) || "no message recorded",
  };
}

async function runModel(model) {
  const sessionId = crypto.randomUUID();
  const history = [];
  const rows = [];
  const windows = [];
  console.log(`\n=== ${model.key} (${model.id}) — session ${sessionId} ===`);

  if (WARMUP) {
    const warmStarted = Date.now();
    const warm = await runTurn(model.id, [{ role: "user", text: "مرحبا" }], crypto.randomUUID());
    const warmMs = Date.now() - warmStarted;
    if (warm.error) console.log(`  warm-up: ${warm.error}`);
    else {
      const { issues } = checkScreen(warm.raw);
      console.log(`  warm-up: ${warmMs} ms (not counted)${issues.length ? ` — ${issues.join("; ")}` : ""}`);
    }
  }

  let consecutiveBlocked = 0;
  let abortedEarly = false;
  for (const turn of SCRIPT_TURNS) {
    if (consecutiveBlocked >= ABORT_AFTER_BLOCKED) {
      abortedEarly = true;
      console.log(`  stopped after ${consecutiveBlocked} consecutive blocked turns`);
      break;
    }
    const turns = [...history, { role: "user", text: turn.text }];
    const turnStart = Date.now();
    let result = await runTurn(model.id, turns, sessionId);
    let busyRetries = 0;
    let busy = null;

    // The provider being busy is the one refusal worth replaying after a wait. A generic
    // failure screen is decided later from the audit row: a provider error is BLOCKED, a
    // non-JSON model reply is a contract failure and must stay one.
    const busyScreen = () => {
      if (result.error) return false;
      try {
        return BUSY_SCREENS.includes(JSON.parse(result.raw)?.screen?.text);
      } catch {
        return false;
      }
    };

    while (busyScreen() && busyRetries < BUSY_RETRIES && BUSY_WAIT_MS > 0) {
      busyRetries += 1;
      console.log(`  [${turn.label}] provider busy — waiting ${BUSY_WAIT_MS} ms, replaying once`);
      await new Promise((resolve) => setTimeout(resolve, BUSY_WAIT_MS));
      result = await runTurn(model.id, turns, sessionId);
    }
    if (busyScreen()) busy = true;

    if (result.error) {
      rows.push({ label: turn.label, ms: result.ms ?? null, tools: [], issues: [`transport: ${result.error}`], text: "", valid: false, blocked: false, busyRetries, auditEvents: [] });
      console.log(`  [${turn.label}] ${result.error}`);
      history.push({ role: "user", text: turn.text });
      windows.push({ label: turn.label, startMs: turnStart, endMs: Date.now() });
      consecutiveBlocked = 0;
      continue;
    }

    const { screen, issues } = checkScreen(result.raw);
    rows.push({
      label: turn.label,
      ms: result.ms,
      text: screen?.text ?? "",
      rawIssues: issues,
      valid: issues.length === 0,
      blocked: busy === true,
      busyRetries,
      timing: result.timing,
      issues: [],
      auditEvents: [],
    });
    history.push({ role: "user", text: turn.text });
    if (screen?.text) history.push({ role: "assistant", text: screen.text });
    windows.push({ label: turn.label, startMs: turnStart, endMs: Date.now() });
    consecutiveBlocked = busy === true ? consecutiveBlocked + 1 : 0;
  }

  // The bridge writes its audit row just after the SSE answer reaches this script, so give
  // the insert a moment before reading, and re-read once if a blocked turn has no reason.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  let { rows: audit, error: auditError } = await auditRows(sessionId);
  let buckets = attribute(audit, windows);
  const unreasoned = () =>
    rows.some(
      (row, index) =>
        (!row.timing || row.blocked) &&
        !(buckets[index] ?? []).some((entry) => entry.event === "upstream_429" || entry.event === "bridge_error" || entry.event === "turn_timing"),
    );
  // A provider that is down is down for the whole leg, so a turn whose own audit row could
  // not be pinned to it still gets the leg's reason rather than "unknown".
  const sessionFailure = [...audit]
    .reverse()
    .find((entry) => /MODEL_STREAM_ERROR|All models failed/i.test(String(entry.input?.message ?? "")));
  if (unreasoned()) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    ({ rows: audit, error: auditError } = await auditRows(sessionId));
    buckets = attribute(audit, windows);
  }

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const turn = SCRIPT_TURNS[index];
    if (!turn) continue;
    const turnAudit = buckets[index] ?? [];
    const tools = turnAudit.filter((entry) => entry.event === "tool_call").map((entry) => `${entry.tool}${entry.outcome === "ok" ? "" : `(${entry.outcome})`}`);
    row.tools = tools;
    row.auditEvents = turnAudit.map((entry) => entry.event);
    // A failure screen is BLOCKED only when the audit row says the provider refused us.
    // A non-JSON reply that the bridge could not parse is the model's own failure, so it
    // stays a contract failure and is reported as one.
    if (!row.blocked && !row.timing && row.text && BRIDGE_ERROR_SCREENS.includes(row.text)) {
      const reason = blockedReason(turnAudit);
      const providerSide = /MODEL_STREAM_ERROR|All models failed|ECONN|socket|timed out|timeout/i.test(reason.detail);
      if (providerSide) row.blocked = true;
      else if (reason.kind === "unknown" && sessionFailure) {
        row.blocked = true;
        row.reasonFromSession = true;
      } else row.bridgeFailure = reason.detail || "bridge could not parse the reply";
    }
    if (row.blocked) {
      row.busyReason = row.reasonFromSession ? { ...blockedReason([sessionFailure]), detail: `${blockedReason([sessionFailure]).detail} (leg-wide provider failure)`, fromSession: true } : blockedReason(turnAudit);
      row.overrideProven = row.busyReason.detail.includes(model.id);
      row.valid = null;
      console.log(`  [${row.label}] BLOCKED (${row.busyReason.kind}${row.busyReason.status ? ` ${row.busyReason.status}` : ""})${row.busyRetries ? ` after ${row.busyRetries} replay` : ""} · ${row.ms} ms${row.busyReason.detail ? ` — ${row.busyReason.detail.slice(0, 90)}` : ""}`);
      continue;
    }
    if (row.issues.some((issue) => issue.startsWith("transport:"))) continue;
    let screenIssues = row.rawIssues;
    if (row.text && BRIDGE_ERROR_SCREENS.includes(row.text)) {
      screenIssues = [
        ...screenIssues,
        row.bridgeFailure ? `bridge could not use the reply: ${row.bridgeFailure.slice(0, 120)}` : "bridge error screen — no model answer",
      ];
    }
    if (row.timing?.repair_used) screenIssues = [...screenIssues, "bridge repaired the screen"];
    if (!row.timing) screenIssues = [...screenIssues, "no bridge.timing event (error path)"];
    const bridgeTools = typeof row.timing?.tool_calls === "number" ? row.timing.tool_calls : null;
    if (bridgeTools !== null && bridgeTools !== tools.length) {
      // Only a note: the bridge counts rows in its own window, this script in another.
      row.countMismatch = `bridge saw ${bridgeTools} tool call(s), audit window saw ${tools.length}`;
    }
    // A bridge-screen turn says nothing about the model's language or honesty, but the
    // bridge's own failure and the tool rows it did run are still worth reporting.
    const grounded = row.text && !BRIDGE_ERROR_SCREENS.includes(row.text);
    const said = SCRIPT_TURNS.slice(0, index + 1).map((entry) => ({ text: entry.text }));
    row.issues = [
      ...screenIssues,
      ...(grounded ? drift(turn, { text: row.text }, said, tools, turnAudit) : []),
    ];
    row.valid = row.issues.length === 0;
    delete row.rawIssues;
    if (row.valid) consecutiveBlocked = 0;
    console.log(
      `  [${row.label}] ${row.ms} ms · ${tools.length ? tools.join(", ") : "no tools"} · ${row.valid ? "contract ok" : "DRIFT: " + row.issues.join("; ")}`,
    );
    if (row.text) console.log(`      said: ${redact(row.text)}`);
    consecutiveBlocked = 0;
  }
  if (auditError) console.log(`  audit lookup: ${auditError}`);

  return { model: model.id, key: model.key, sessionId, rows, abortedEarly, auditError };
}

async function main() {
  const requested = env("CLINIC_AB_LEGS") ?? env("CLINIC_AB_ONLY");
  const wanted = requested ? requested.split(",").map((value) => value.trim()).filter(Boolean) : [];
  const models = wanted.length
    ? MODELS.filter((model) => wanted.includes(model.key) || wanted.includes(model.id))
    : MODELS;
  if (!models.length) {
    console.error(`CLINIC_AB_LEGS must name one of: ${MODELS.map((model) => model.key).join(", ")}`);
    process.exit(2);
  }

  try {
    const health = await fetch(`${APP}/`, { signal: AbortSignal.timeout(5000) });
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (error) {
    console.error(`No live app at ${APP} (${error instanceof Error ? error.message : String(error)}). Start it with: npm run dev`);
    process.exit(2);
  }
  if (!supabaseUrl || !supabaseKey) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required: tool calls are read from audit_events.");
    process.exit(2);
  }

  const results = [];
  for (const model of models) results.push(await runModel(model));

  console.log("\n| Model | Turn | ms | Tools (audit) | Contract | Notes |");
  console.log("|---|---|---|---|---|---|");
  for (const result of results) {
    for (const row of result.rows) {
      const verdict = row.blocked ? "BLOCKED" : row.valid ? "PASS" : "FAIL";
      const replay = row.busyRetries ? ` (replayed ${row.busyRetries}×)` : "";
      const notes = row.blocked
        ? `${row.busyReason.kind}${row.busyReason.status ? ` ${row.busyReason.status}` : ""}${replay}: ${row.busyReason.detail}`
        : (row.issues.join("; ") || "—") + replay;
      console.log(`| ${result.key} | ${row.label} | ${row.ms ?? "n/a"} | ${row.tools.join(", ") || "—"} | ${verdict} | ${notes} |`);
    }
  }

  console.log("\nSummary");
  for (const result of results) {
    const answered = result.rows.filter((row) => !row.blocked);
    const latencies = answered.map((row) => row.ms).filter((value) => typeof value === "number");
    const passed = answered.filter((row) => row.valid).length;
    const blocked = result.rows.length - answered.length;
    const toolCalls = result.rows.reduce((sum, row) => sum + row.tools.length, 0);
    console.log(
      `  ${result.key}: contract ${passed}/${answered.length} turns with a model answer · ${blocked} blocked · median ${percentile(latencies, 50)} ms · p90 ${percentile(latencies, 90)} ms · ${toolCalls} tool call(s)`,
    );
    // The post-fix numbers, all read from audit_events: what reached the caller, what the
    // bridge contained, and whether every scripted emergency actually escalated.
    const events = (name) =>
      result.rows.reduce((sum, row) => sum + (row.auditEvents ?? []).filter((event) => event === name).length, 0);
    const emergencyRows = answered.filter(
      (row) => SCRIPT_TURNS.find((turn) => turn.label === row.label)?.emergency === true,
    );
    const emergencyEscalated = emergencyRows.filter(
      (row) => (row.auditEvents ?? []).includes("emergency_precheck") || row.tools.includes("escalate_to_human"),
    ).length;
    const reachedConfirmations = answered.filter((row) =>
      row.issues.some((issue) => issue.startsWith("declarative confirmation")),
    ).length;
    const repairs = result.rows.filter((row) => row.timing?.repair_used).length;
    const repairFailures = result.rows.filter((row) => row.timing?.repair_used && row.valid === false).length;
    console.log(
      `    false confirmations reaching the caller: ${reachedConfirmations} · blocked by the bridge: ${events("blocked_false_confirmation")} · emergency escalation: ${emergencyEscalated}/${emergencyRows.length} scripted emergency turns · repeats deduped: ${events("tool_deduped")} · deadlines: ${events("turn_deadline")} · repairs: ${repairs} attempted, ${repairFailures} still failing`,
    );

    const drifts = answered.flatMap((row) => row.issues.map((issue) => `${row.label}: ${issue}`));
    if (drifts.length) console.log(`    drift: ${drifts.join(" | ")}`);
    if (blocked) {
      const reasons = [...new Set(result.rows.filter((row) => row.blocked).map((row) => `${row.busyReason.kind}${row.busyReason.status ? ` ${row.busyReason.status}` : ""}`))];
      const proven = result.rows.some((row) => row.overrideProven);
      console.log(`    blocked by: ${reasons.join(", ")} — this leg is UNVERIFIED, not a contract failure`);
      if (proven) console.log(`    the provider error names ${result.model}: the x-openclaw-model override did take effect`);
    }
    if (result.abortedEarly) console.log("    leg stopped early (consecutive blocked turns)");
  }

  const output = { generatedAt: new Date().toISOString(), app: APP, script: SCRIPT_TURNS, results };
  writeFileSync("docs/model-ab-results.json", JSON.stringify(output, null, 2));
  console.log("\nWrote docs/model-ab-results.json (tool names from audit_events; reply text only).");
  console.log("Reset the demo data afterwards: psql \"$DATABASE_URL\" -f supabase/reset_demo.sql");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
