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

/**
 * Tool hygiene. The model repeats itself — up to 11 identical calls in one measured turn —
 * and each repeat costs a database round trip and latency the caller hears as silence.
 * Repeats are answered from the previous real result, never cached errors: an error that is
 * returned from cache would be a lie about what the system just did.
 */
const DEDUPE_WINDOW_MS = 15_000;
/** One note of a kind per session per minute; a second identical summary adds nothing. */
const NOTE_WINDOW_MS = 60_000;
/** One escalation per session per minute, whatever its arguments. */
const ESCALATION_WINDOW_MS = 60_000;

type RecentCall = { at: number; envelope: Envelope };
const recentCalls = new Map<string, RecentCall>();
const recentNotes = new Map<string, RecentCall>();
const recentEscalations = new Map<string, RecentCall>();

/** Deterministic JSON, so the same call with keys in another order still dedupes. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/** A repeat of a call that already succeeded: the real result, marked as deduped. */
function dedupedEnvelope<T>(previous: Envelope<T>, ctx: ToolContext, latency: number) {
  return { ...previous, meta: { request_id: ctx.request_id, latency_ms: latency, deduped: true } };
}

/** Names that are not a name: fragments of a sentence the model mistook for the caller's name. */
const NAME_STOPWORDS = new Set(
  ["مع", "اسمي", "انا", "اسم", "ده", "دي", "ايوه", "my", "name", "is", "i", "am", "the"].map(foldNameToken),
);

function foldNameToken(token: string): string {
  return token
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase();
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

/**
 * Why a name cannot be sent to identify_patient, or null when it can. The measured drift was
 * `identify_patient(full_name="مع")` in 7 of 8 runs — a fragment of "محمد علي" — which the
 * database accepted as a name. Rejecting it here makes the model ask again instead.
 */
export function fullNameProblem(raw: string): string | null {
  const collapsed = collapseWhitespace(raw);
  if (!collapsed) return "empty";
  const tokens = collapsed.split(" ").filter(Boolean);
  const letters = collapsed.match(/\p{L}/gu)?.length ?? 0;
  if (letters < 3) return "fewer than 3 letters";
  const single = tokens.length === 1 ? (tokens[0] ?? "").match(/\p{L}/gu)?.length ?? 0 : null;
  if (single !== null && single <= 2) return "one short token";
  if (tokens.every((token) => NAME_STOPWORDS.has(foldNameToken(token)))) return "every word is a stopword";
  return null;
}

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

/** Tools whose success carries the appointment_ref the caller may be told aloud. */
const BOOKING_TOOLS_WITH_REF = ["confirm_booking", "reschedule_appointment", "cancel_appointment"] as const;

/**
 * The appointment_ref of a SUCCESSFUL booking change, or null. It is a 6-character code, not
 * PII, and it is stored on the audit row so the bridge's confirmation guard can prove that a
 * code the caller was told really came from this turn's tool result.
 */
function resultRef(tool: string, envelope: Envelope): string | null {
  if (!(BOOKING_TOOLS_WITH_REF as readonly string[]).includes(tool) || !envelope.ok) return null;
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const ref = (data as Record<string, unknown>)["appointment_ref"];
  return typeof ref === "string" && ref.trim() ? ref.trim().toUpperCase() : null;
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

/** A tool envelope plus its meta, including the `deduped` flag a repeat carries. */
export type ToolResult<T = unknown> = Envelope<T> & {
  meta: { request_id: string; latency_ms: number; deduped?: boolean };
};

export async function runTool(tool: ToolName | string, args: unknown, ctx: ToolContext, deps: Deps = {}): Promise<ToolResult> {
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
  const nowMs = now();
  const argsKey = stableStringify(input as Record<string, unknown>);
  const noteKey = `${ctx.session_id}|${(input as { kind?: unknown }).kind ?? "-"}`;
  const dedupeKey = `${ctx.session_id}|${name}|${argsKey}`;
  // A deduped repeat is still evidence: it is audited under its own event so the model's
  // repetition stays measurable instead of disappearing from the audit trail.
  const auditDedupe = async (reason: string) => {
    try {
      await auditInsert({
        session_id: ctx.session_id,
        actor: "agent",
        event: "tool_deduped",
        tool: name,
        input: { ...redactInput(input as Record<string, unknown>), reason },
        outcome: "ok",
        error_code: null,
        latency_ms: Date.now() - started,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[clinic.audit] failed to write dedupe audit: ${message}\n`);
    }
  };

  // An escalation is once per minute per session whatever its arguments: the team already has
  // it, and a second delivery is noise rather than a different decision.
  if (name === "escalate_to_human") {
    const previous = recentEscalations.get(ctx.session_id);
    if (previous && previous.envelope.ok && nowMs - previous.at < ESCALATION_WINDOW_MS) {
      await auditDedupe("escalation_window");
      return dedupedEnvelope(previous.envelope, ctx, Date.now() - started);
    }
  }

  // A note of each kind is written once a minute: the second one words the same summary again.
  if (name === "add_note") {
    const previous = recentNotes.get(noteKey);
    if (previous && previous.envelope.ok && nowMs - previous.at < NOTE_WINDOW_MS) {
      await auditDedupe("note_window");
      return dedupedEnvelope(previous.envelope, ctx, Date.now() - started);
    }
  }

  // The same call with the same arguments inside 15 s is the model repeating itself; the
  // recorded result is returned instead of executing it again. Errors are never cached.
  const previousCall = recentCalls.get(dedupeKey);
  if (previousCall && previousCall.envelope.ok && nowMs - previousCall.at < DEDUPE_WINDOW_MS) {
    await auditDedupe("repeat_window");
    return dedupedEnvelope(previousCall.envelope, ctx, Date.now() - started);
  }

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
    case "find_doctor":
      result = await callToolRpc(
        callRpcFn,
        "clinic_find_doctor",
        { p_session: ctx.session_id, p_query: (input as ToolInputMap["find_doctor"]).query },
        ctx.request_id,
      );
      break;
    case "identify_patient": {
      const patient = input as ToolInputMap["identify_patient"];
      const fullName = collapseWhitespace(patient.full_name);
      const phone = normalizePhone(patient.phone);
      const nameProblem = fullNameProblem(fullName);
      if (nameProblem) {
        // VALIDATION_ERROR maps to agent_action ask_again, so the model asks for the full name
        // instead of booking against a fragment of a sentence.
        result = fail("VALIDATION_ERROR", "full_name must be the caller's full name", {
          field: "full_name",
          reason: nameProblem,
        });
      } else if (!phone) {
        result = fail("VALIDATION_ERROR", "Phone number must be a valid E.164 number", { field: "phone" });
      } else {
        result = await callToolRpc(
          callRpcFn,
          "clinic_identify_patient",
          { p_session: ctx.session_id, p_full_name: fullName, p_phone_e164: phone },
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
  const ref = resultRef(name, envelope);

  if (envelope.ok) {
    recentCalls.set(dedupeKey, { at: nowMs, envelope });
    if (name === "escalate_to_human") recentEscalations.set(ctx.session_id, { at: nowMs, envelope });
    if (name === "add_note") recentNotes.set(noteKey, { at: nowMs, envelope });
  }

  try {
    await auditInsert({
      session_id: ctx.session_id,
      actor: "agent",
      event: "tool_call",
      tool: name,
      input: {
        ...redactInput(input as Record<string, unknown>),
        ...(ref ? { result_ref: ref } : {}),
      },
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
