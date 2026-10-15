#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const CLINIC_API_URL = process.env.CLINIC_API_URL?.replace(/\/$/, "");
const CLINIC_TOOLS_TOKEN = process.env.CLINIC_TOOLS_TOKEN;

if (!CLINIC_API_URL || !CLINIC_TOOLS_TOKEN) {
  console.error("Missing required environment variables: CLINIC_API_URL and CLINIC_TOOLS_TOKEN");
  process.exit(1);
}

const sessionId = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const shortRef = z.string().trim().min(1).max(120);

// NOTE: the MCP SDK's `server.tool()` takes a Zod RAW SHAPE (a plain object of
// zod types), not a z.object(...) schema. Passing a ZodObject makes registration
// throw "expected a Zod schema or ToolAnnotations".
const schemas = {
  get_clinic_info: { session_id: sessionId },
  select_branch: { session_id: sessionId, branch_ref: shortRef },
  find_doctor: { session_id: sessionId, query: z.string().trim().min(1).max(120) },
  identify_patient: {
    session_id: sessionId,
    full_name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(1).max(60),
  },
  check_availability: {
    session_id: sessionId,
    doctor_ref: shortRef.optional(),
    visit_type_code: shortRef.optional(),
    from: dateTime,
    to: dateTime,
    part_of_day: z.enum(["morning", "afternoon", "evening"]).optional(),
    limit: z.number().int().min(1).max(5).optional(),
  },
  hold_slot: {
    session_id: sessionId,
    doctor_ref: shortRef,
    visit_type_code: shortRef.optional(),
    starts_at: dateTime,
  },
  request_approval: {
    session_id: sessionId,
    action: z.enum(["confirm_booking", "reschedule_appointment", "cancel_appointment"]),
    appointment_ref: shortRef,
    new_starts_at: dateTime.optional(),
    reason: z.string().trim().max(500).optional(),
  },
  confirm_booking: { session_id: sessionId, approval_id: shortRef },
  reschedule_appointment: { session_id: sessionId, approval_id: shortRef },
  cancel_appointment: { session_id: sessionId, approval_id: shortRef },
  list_my_appointments: { session_id: sessionId },
  add_note: {
    session_id: sessionId,
    kind: z.enum(["note", "summary"]),
    body: z.string().trim().min(1).max(2000),
    appointment_ref: shortRef.optional(),
  },
  escalate_to_human: {
    session_id: sessionId,
    severity: z.enum(["emergency", "urgent", "handoff"]),
    reason: z.string().trim().min(1).max(500),
    summary: z.string().trim().min(1).max(2000),
    branch: shortRef.optional(),
    caller_name: z.string().trim().max(120).optional(),
    caller_phone: z.string().trim().max(60).optional(),
  },
};

const toolNames = Object.keys(schemas);

function timeoutSignal(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

function fail(code, message, details) {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: code === "UPSTREAM_TIMEOUT" || code === "INTERNAL",
      agent_action: "retry_once",
      ...(details ? { details } : {}),
    },
    meta: { request_id: "mcp", latency_ms: 0 },
  };
}

async function forwardTool(tool, args) {
  const timer = timeoutSignal(10_000);
  try {
    const response = await fetch(`${CLINIC_API_URL}/api/clinic/tools`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CLINIC_TOOLS_TOKEN}`,
      },
      body: JSON.stringify({ tool, args }),
      signal: timer.signal,
    });

    const text = await response.text();
    if (!response.ok) {
      return JSON.stringify(fail("INTERNAL", `Clinic API returned ${response.status}: ${text.slice(0, 300)}`));
    }
    return text;
  } catch (error) {
    if (timer.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return JSON.stringify(fail("UPSTREAM_TIMEOUT", "Clinic API request timed out"));
    }
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify(fail("INTERNAL", `Clinic API transport failed: ${message}`));
  } finally {
    timer.clear();
  }
}

const server = new McpServer({
  name: "clinic-mcp-proxy",
  version: "0.1.0",
});

for (const tool of toolNames) {
  server.tool(tool, `Clinic tool: ${tool}`, schemas[tool], async (input) => {
    const resultText = await forwardTool(tool, input);
    return {
      content: [
        {
          type: "text",
          text: resultText,
        },
      ],
    };
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
