#!/usr/bin/env node
// End-to-end smoke test for the Booking Service HTTP endpoint.
//
//   CLINIC_API_URL=http://localhost:3000 CLINIC_TOOLS_TOKEN=... \
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... CLINIC_TENANT_SLUG=demo-dental \
//   node scripts/clinic-api-smoke.mjs
//
// It does NOT need the OpenClaw gateway or a model. Sessions are opened through
// the same clinic_open_session RPC the bridge uses, then every tool call goes
// through POST /api/clinic/tools exactly as the MCP proxy does, asserting the
// envelope, the error code, `retryable` and `agent_action`.
//
// NOT covered here, on purpose — these need the bridge or a human:
//   * the approval *decision* path (approve/deny/expired/replayed) is driven by
//     /api/agent when the operator clicks, not by a tool call;
//   * a database outage (stop Postgres and watch it return DB_ERROR);
//   alongside the bridge failure drills in docs/TESTING.md §5.
//
// WARNING: it writes to the database (a session, a patient, a hold). Run it
// against a scratch database, or reset afterwards with supabase/reset_demo.sql.

import { createClient } from "@supabase/supabase-js";

const EXPECTED_ACTION = {
  VALIDATION_ERROR: "ask_again",
  NOT_VERIFIED: "ask_again",
  BRANCH_REQUIRED: "ask_again",
  NOT_FOUND: "ask_again",
  SLOT_UNAVAILABLE: "offer_alternatives",
  PATIENT_CONFLICT: "offer_alternatives",
  HOLD_EXPIRED: "restart_hold",
  INVALID_STATE: "ask_again",
  OUTSIDE_POLICY: "explain_policy",
  APPROVAL_PENDING: "wait_for_approval",
  APPROVAL_DENIED: "apologize_and_stop",
  APPROVAL_EXPIRED: "ask_again",
  APPROVAL_ALREADY_USED: "apologize_and_stop",
  APPROVAL_NOT_FOUND: "apologize_and_stop",
  APPROVAL_MISMATCH: "apologize_and_stop",
  FORBIDDEN: "apologize_and_stop",
  UNAUTHORIZED: "apologize_and_stop",
  RATE_LIMITED: "retry_once",
  UPSTREAM_TIMEOUT: "retry_once",
  DB_ERROR: "retry_once",
  INTERNAL: "retry_once",
  DELIVERY_FAILED: "apologize_and_stop",
  NOTIFICATION_NOT_CONFIGURED: "apologize_and_stop",
};

const failures = [];
let passed = 0;

function check(condition, message, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${message}`);
  } else {
    console.log(`  FAIL  ${message}${detail ? ` — ${detail}` : ""}`);
    failures.push(message);
  }
}

function env(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const BASE = (env("CLINIC_API_URL") || "http://localhost:3000").replace(/\/$/, "");
const TOKEN = env("CLINIC_TOOLS_TOKEN");
const TENANT = env("CLINIC_TENANT_SLUG") || "demo-dental";

async function callTool(tool, args, token = TOKEN) {
  const response = await fetch(`${BASE}/api/clinic/tools`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ tool, args }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

/** Asserts the envelope shape and, for failures, the mapped agent_action. */
function assertError(result, label, expectedCode) {
  const body = result.body;
  if (!body || body.ok !== false || !body.error) {
    check(false, `${label} -> ${expectedCode}`, `got ${JSON.stringify(body).slice(0, 200)}`);
    return;
  }
  check(body.error.code === expectedCode, `${label} -> ${expectedCode}`, `got ${body.error.code}`);
  const expectedAction = EXPECTED_ACTION[expectedCode];
  check(
    body.error.agent_action === expectedAction,
    `${label} carries agent_action ${expectedAction}`,
    `got ${body.error.agent_action}`,
  );
  check(typeof body.error.retryable === "boolean", `${label} reports retryable as a boolean`);
  check(typeof body.meta?.latency_ms === "number", `${label} reports meta.latency_ms`);
}

function assertOk(result, label) {
  const body = result.body;
  check(body?.ok === true, `${label} -> ok`, `got ${JSON.stringify(body).slice(0, 200)}`);
  return body?.data;
}

async function main() {
  if (!TOKEN) {
    console.error("CLINIC_TOOLS_TOKEN is required (it is the bearer token for /api/clinic/tools).");
    process.exit(2);
  }
  const supaUrl = env("SUPABASE_URL");
  const supaKey = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!supaUrl || !supaKey) {
    console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to open a session for the test.");
    process.exit(2);
  }

  console.log(`Clinic API smoke test against ${BASE} (tenant ${TENANT})\n`);
  const admin = createClient(supaUrl, supaKey, { auth: { persistSession: false, autoRefreshToken: false } });

  // ------------------------------------------------------------------ auth
  console.log("Auth");
  const unauthorised = await callTool("get_clinic_info", { session_id: crypto.randomUUID() }, "definitely-wrong");
  check(unauthorised.status === 401, "a wrong token is rejected with HTTP 401", `got ${unauthorised.status}`);
  assertError(unauthorised, "wrong token", "UNAUTHORIZED");

  // ------------------------------------------------------- unknown session
  console.log("\nValidation and unknown session");
  const noSession = await callTool("get_clinic_info", {});
  assertError(noSession, "missing session_id", "VALIDATION_ERROR");
  const unknown = await callTool("get_clinic_info", { session_id: crypto.randomUUID() });
  assertError(unknown, "unknown session", "NOT_FOUND");

  // ------------------------------------------------------- real session
  console.log("\nHappy path on a fresh session");
  const sessionId = crypto.randomUUID();
  const opened = await admin.rpc("clinic_open_session", {
    p_session: sessionId,
    p_tenant_slug: TENANT,
    p_channel: "api_smoke",
    p_locale: "ar-EG",
  });
  if (opened.error || opened.data?.ok !== true) {
    console.error(`could not open a session: ${opened.error?.message ?? JSON.stringify(opened.data).slice(0, 200)}`);
    process.exit(2);
  }
  console.log(`  (session ${sessionId})`);

  const info = assertOk(await callTool("get_clinic_info", { session_id: sessionId }), "get_clinic_info");
  check(Array.isArray(info?.branches) && info.branches.length === 2, "get_clinic_info lists both branches");

  // find_doctor, the 13th tool: read-only and valid before a branch is chosen.
  const doctor = assertOk(await callTool("find_doctor", { session_id: sessionId, query: "يوسف" }), "find_doctor(يوسف)");
  check(
    doctor?.doctors?.[0]?.branch_ref === "maadi",
    "find_doctor maps the dentist to his branch",
    JSON.stringify(doctor).slice(0, 200),
  );
  assertError(await callTool("find_doctor", { session_id: sessionId, query: "" }), "find_doctor with no query", "VALIDATION_ERROR");
  const noMatch = await callTool("find_doctor", { session_id: sessionId, query: "zzz-nobody" });
  assertError(noMatch, "find_doctor with no match", "NOT_FOUND");

  // Branch is still required for scheduling.
  assertError(
    await callTool("check_availability", { session_id: sessionId, from: new Date().toISOString(), to: new Date(Date.now() + 86400000).toISOString() }),
    "check_availability before a branch",
    "BRANCH_REQUIRED",
  );
  assertError(await callTool("select_branch", { session_id: sessionId, branch_ref: "giza" }), "select_branch with a bad ref", "NOT_FOUND");
  const branch = assertOk(await callTool("select_branch", { session_id: sessionId, branch_ref: "mokattam" }), "select_branch(mokattam)");
  check(typeof branch?.address_ar === "string" && branch.address_ar.length > 0, "select_branch returns the Arabic address");

  // Identity: a bad phone must be rejected before any RPC.
  assertError(await callTool("identify_patient", { session_id: sessionId, full_name: "Smoke Test", phone: "0100" }), "identify_patient with a bad phone", "VALIDATION_ERROR");

  // Hold before identifying must be refused.
  const anySlot = assertOk(
    await callTool("check_availability", {
      session_id: sessionId,
      from: new Date().toISOString(),
      to: new Date(Date.now() + 14 * 86400000).toISOString(),
      limit: 3,
    }),
    "check_availability after select_branch",
  );
  const startsAt = anySlot?.slots?.[0]?.starts_at;
  check(typeof startsAt === "string", "availability returns at least one slot", JSON.stringify(anySlot).slice(0, 200));

  if (typeof startsAt === "string") {
    assertError(
      await callTool("hold_slot", { session_id: sessionId, doctor_ref: "dr-mohamed-ali", starts_at: startsAt }),
      "hold before identify_patient",
      "NOT_VERIFIED",
    );
  }

  assertOk(await callTool("identify_patient", { session_id: sessionId, full_name: "Smoke Test", phone: "01001112223" }), "identify_patient");

  console.log("\nHold and approval");
  const hold = assertOk(
    await callTool("hold_slot", { session_id: sessionId, doctor_ref: "dr-mohamed-ali", starts_at: startsAt }),
    "hold_slot",
  );
  const holdRef = hold?.hold_ref;
  check(typeof holdRef === "string", "hold_slot returns a hold_ref");

  if (typeof startsAt === "string" && typeof holdRef === "string") {
    // Off-grid: the doctor's grid is every 30 minutes from 16:00.
    assertError(
      await callTool("hold_slot", {
        session_id: sessionId,
        doctor_ref: "dr-mohamed-ali",
        starts_at: new Date(Date.parse(startsAt) + 7 * 60000).toISOString(),
      }),
      "hold_slot off the grid",
      "SLOT_UNAVAILABLE",
    );
    assertError(
      await callTool("request_approval", { session_id: sessionId, action: "confirm_booking", appointment_ref: "NOPE" }),
      "request_approval for an unknown ref",
      "NOT_FOUND",
    );
    const first = assertOk(
      await callTool("request_approval", { session_id: sessionId, action: "confirm_booking", appointment_ref: holdRef }),
      "request_approval",
    );
    check(first?.status === "pending", "the approval is pending", `got ${first?.status}`);
    check(/^apr_[a-f0-9]{12}$/.test(String(first?.approval_id)), "the approval id is server-generated (apr_ + 12 hex)");
    const second = assertOk(
      await callTool("request_approval", { session_id: sessionId, action: "confirm_booking", appointment_ref: holdRef }),
      "request_approval again",
    );
    check(second?.approval_id === first?.approval_id, "asking again returns the same live approval");

    // Executing before the operator decides must not succeed.
    assertError(
      await callTool("confirm_booking", { session_id: sessionId, approval_id: String(first?.approval_id) }),
      "confirm before the operator decides",
      "APPROVAL_PENDING",
    );
    assertError(
      await callTool("confirm_booking", { session_id: sessionId, approval_id: "apr_doesnotexist" }),
      "confirm with an unknown approval",
      "APPROVAL_NOT_FOUND",
    );
  }

  console.log("\nEscalation and rate limiting");
  const escalation = assertOk(
    await callTool("escalate_to_human", {
      session_id: sessionId,
      severity: "handoff",
      reason: "api smoke test",
      summary: "automated check; no caller involved",
    }),
    "escalate_to_human",
  );
  check(typeof escalation?.delivery_status === "string", "escalation reports a real delivery_status", JSON.stringify(escalation));
  check(
    ["connected", "notified", "delivery_failed"].includes(escalation?.delivery_status),
    "delivery_status is one of connected/notified/delivery_failed",
  );
  check(!("contact" in (escalation ?? {})), "the staff contact details are stripped before reaching the model");
  if (escalation?.delivery_status === "delivery_failed") {
    console.log(`        (delivery_failed: ${escalation.delivery_error ?? "no reason given"})`);
  }

  let rateLimited = false;
  for (let i = 0; i < 40; i++) {
    const result = await callTool("get_clinic_info", { session_id: sessionId });
    if (result.body?.error?.code === "RATE_LIMITED") {
      rateLimited = true;
      assertError(result, "31st call in a minute", "RATE_LIMITED");
      break;
    }
  }
  check(rateLimited, "the 30 calls/minute limit is enforced");

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) {
    console.error("Failed checks:");
    for (const message of failures) console.error(`  - ${message}`);
    process.exit(1);
  }
  console.log("PASS: the Booking Service endpoint behaves as documented.");
}

main().catch((error) => {
  console.error(`\nSmoke test could not run: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`Is the dev server running at ${BASE}? (npm run dev)`);
  process.exit(2);
});
