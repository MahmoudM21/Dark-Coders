import { z } from "zod";
import {
  asErrorCode,
  fail,
  toolInputSchemas,
  toolNames,
  type Envelope,
  type ToolInputMap,
  type ToolName,
  withMeta,
} from "./contracts.ts";
import { callRpc } from "./db.server.ts";
import { escalate } from "./escalation.server.ts";
import { normalizePhone } from "./phone.server.ts";

type ToolContext = { session_id: string; request_id: string };

type Deps = {
  callRpcFn?: typeof callRpc;
  escalateFn?: typeof escalate;
  auditInsert?: (entry: Record<string, unknown>) => Promise<void>;
  now?: () => number;
};

const RATE_LIMIT_PER_MINUTE = 30;
const WINDOW_MS = 60_000;
const rateMap = new Map<string, number[]>();

function checkRateLimit(sessionId: string, nowMs: number): boolean {
  const list = rateMap.get(sessionId) ?? [];
  const next = list.filter((ts) => nowMs - ts < WINDOW_MS);
  if (next.length >= RATE_LIMIT_PER_MINUTE) {
    rateMap.set(sessionId, next);
    return false;
  }
  next.push(nowMs);
  rateMap.set(sessionId, next);
  return true;
}

function toInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase())
    .filter(Boolean);
  return parts.join("");
}

function redactInput(input: Record<string, unknown>) {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string") {
      redacted[key] = value;
      continue;
    }
    if (key.includes("name")) {
      redacted[key] = toInitials(value);
      continue;
    }
    if (key.includes("phone")) {
      const tail = value.slice(-3);
      redacted[key] = `***${tail}`;
      continue;
    }
    if (key === "reason" || key === "summary" || key === "body") {
      redacted[key] = { length: value.length };
      continue;
    }
    redacted[key] = value;
  }
  return redacted;
}

function errorFromEnvelope(value: unknown): Envelope {
  if (!value || typeof value !== "object") return fail("INTERNAL", "Malformed RPC error envelope");
  const envelope = value as { code?: unknown; message?: unknown; details?: unknown };
  const code = asErrorCode(envelope.code);
  if (!code) return fail("INTERNAL", typeof envelope.message === "string" ? envelope.message : "Unknown RPC error");
  const details = envelope.details && typeof envelope.details === "object"
    ? (envelope.details as Record<string, unknown>)
    : undefined;
  return fail(code, typeof envelope.message === "string" ? envelope.message : code, details);
}

function normalizeSqlResult(value: unknown): Envelope {
  if (!value || typeof value !== "object") return fail("INTERNAL", "Malformed RPC envelope");
  const envelope = value as { ok?: unknown; data?: unknown; error?: unknown };
  if (envelope.ok === true) return { ok: true, data: envelope.data };
  if (envelope.ok === false) return errorFromEnvelope(envelope.error);
  return fail("INTERNAL", "Malformed RPC envelope");
}

function fieldIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "input";
  return issue.path.join(".") || "input";
}

async function defaultAuditInsert(entry: Record<string, unknown>) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const client = supabaseAdmin as unknown as {
    from: (table: string) => {
      insert: (value: Record<string, unknown>) => Promise<{ error: { message?: string | null } | null }>;
    };
  };
  const result = await client.from("audit_events").insert(entry);
  if (result.error) throw new Error(result.error.message ?? "audit insert failed");
}

async function callToolRpc(
  callRpcFn: typeof callRpc,
  rpcName: string,
  args: Record<string, unknown>,
  requestId: string,
): Promise<Envelope> {
  const rpcResult = await callRpcFn(rpcName, args, { requestId });
  return normalizeSqlResult(rpcResult);
}

export async function runTool(tool: ToolName | string, args: unknown, ctx: ToolContext, deps: Deps = {}) {
  const started = Date.now();
  const now = deps.now ?? Date.now;
  const callRpcFn = deps.callRpcFn ?? callRpc;
  const escalateFn = deps.escalateFn ?? escalate;
  const auditInsert = deps.auditInsert ?? defaultAuditInsert;

  if (!(toolNames as readonly string[]).includes(tool)) {
    const latency = Date.now() - started;
    const result = withMeta(fail("VALIDATION_ERROR", "Unknown tool", { field: "tool" }), ctx.request_id, latency);
    return result;
  }

  if (!checkRateLimit(ctx.session_id, now())) {
    const latency = Date.now() - started;
    return withMeta(fail("RATE_LIMITED", "Too many tool calls. Please retry shortly."), ctx.request_id, latency);
  }

  const name = tool as ToolName;
  const schema = toolInputSchemas[name];
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const latency = Date.now() - started;
    return withMeta(
      fail("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid tool arguments", {
        field: fieldIssue(parsed.error),
      }),
      ctx.request_id,
      latency,
    );
  }

  const input = parsed.data as ToolInputMap[ToolName];
  let result: Envelope;

  switch (name) {
    case "get_clinic_info":
      result = await callToolRpc(callRpcFn, "clinic_get_info", { p_session: ctx.session_id }, ctx.request_id);
      break;
    case "select_branch":
      result = await callToolRpc(
        callRpcFn,
        "clinic_select_branch",
        { p_session: ctx.session_id, p_branch_slug: (input as ToolInputMap["select_branch"]).branch_ref },
        ctx.request_id,
      );
      break;
    case "identify_patient": {
      const patient = input as ToolInputMap["identify_patient"];
      const phone = normalizePhone(patient.phone);
      if (!phone) {
        result = fail("VALIDATION_ERROR", "Phone number must be a valid E.164 number", { field: "phone" });
      } else {
        result = await callToolRpc(
          callRpcFn,
          "clinic_identify_patient",
          { p_session: ctx.session_id, p_full_name: patient.full_name, p_phone_e164: phone },
          ctx.request_id,
        );
      }
      break;
    }
    case "check_availability": {
      const availability = input as ToolInputMap["check_availability"];
      const nowDate = new Date();
      const fromDate = new Date(availability.from);
      const toDate = new Date(availability.to);
      const clampedFrom = fromDate < nowDate ? nowDate : fromDate;
      const maxTo = new Date(clampedFrom.getTime() + 31 * 24 * 60 * 60 * 1000);
      const finalTo = toDate > maxTo ? maxTo : toDate;
      result = await callToolRpc(
        callRpcFn,
        "clinic_check_availability",
        {
          p_session: ctx.session_id,
          p_doctor_slug: availability.doctor_ref ?? null,
          p_visit_type_code: availability.visit_type_code ?? null,
          p_from: clampedFrom.toISOString(),
          p_to: finalTo.toISOString(),
          p_part_of_day: availability.part_of_day ?? null,
          p_limit: Math.min(availability.limit ?? 5, 5),
        },
        ctx.request_id,
      );
      break;
    }
    case "hold_slot": {
      const hold = input as ToolInputMap["hold_slot"];
      result = await callToolRpc(
        callRpcFn,
        "clinic_hold_slot",
        {
          p_session: ctx.session_id,
          p_doctor_slug: hold.doctor_ref,
          p_visit_type_code: hold.visit_type_code ?? null,
          p_starts_at: new Date(hold.starts_at).toISOString(),
        },
        ctx.request_id,
      );
      break;
    }
    case "request_approval": {
      const approval = input as ToolInputMap["request_approval"];
      result = await callToolRpc(
        callRpcFn,
        "clinic_create_approval",
        {
          p_session: ctx.session_id,
          p_action: approval.action,
          p_appointment_ref: approval.appointment_ref,
          p_new_starts_at: approval.new_starts_at ? new Date(approval.new_starts_at).toISOString() : null,
          p_reason: approval.reason ?? null,
        },
        ctx.request_id,
      );
      break;
    }
    case "confirm_booking":
      result = await callToolRpc(
        callRpcFn,
        "clinic_confirm_booking",
        { p_session: ctx.session_id, p_approval_id: (input as ToolInputMap["confirm_booking"]).approval_id },
        ctx.request_id,
      );
      break;
    case "reschedule_appointment":
      result = await callToolRpc(
        callRpcFn,
        "clinic_reschedule_appointment",
        { p_session: ctx.session_id, p_approval_id: (input as ToolInputMap["reschedule_appointment"]).approval_id },
        ctx.request_id,
      );
      break;
    case "cancel_appointment":
      result = await callToolRpc(
        callRpcFn,
        "clinic_cancel_appointment",
        { p_session: ctx.session_id, p_approval_id: (input as ToolInputMap["cancel_appointment"]).approval_id },
        ctx.request_id,
      );
      break;
    case "list_my_appointments":
      result = await callToolRpc(callRpcFn, "clinic_list_my_appointments", { p_session: ctx.session_id }, ctx.request_id);
      break;
    case "add_note": {
      const note = input as ToolInputMap["add_note"];
      result = await callToolRpc(
        callRpcFn,
        "clinic_add_note",
        {
          p_session: ctx.session_id,
          p_kind: note.kind,
          p_body: note.body,
          p_appointment_ref: note.appointment_ref ?? null,
        },
        ctx.request_id,
      );
      break;
    }
    case "escalate_to_human":
      result = normalizeSqlResult(await escalateFn(ctx.session_id, input as ToolInputMap["escalate_to_human"]));
      break;
    default:
      result = fail("VALIDATION_ERROR", "Unknown tool", { field: "tool" });
  }

  const latency = Date.now() - started;
  const envelope = withMeta(result, ctx.request_id, latency);

  try {
    await auditInsert({
      session_id: ctx.session_id,
      actor: "agent",
      event: "tool_call",
      tool: name,
      input: redactInput(input as Record<string, unknown>),
      outcome: envelope.ok ? "ok" : "error",
      error_code: envelope.ok ? null : envelope.error.code,
      latency_ms: latency,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[clinic.audit] failed to write audit event: ${message}\n`);
  }

  return envelope;
}
