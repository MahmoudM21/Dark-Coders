import { z } from "zod";

export const AGENT_ACTIONS = [
  "ask_again",
  "offer_alternatives",
  "restart_hold",
  "wait_for_approval",
  "apologize_and_stop",
  "escalate_handoff",
  "explain_policy",
  "retry_once",
] as const;

export type AgentAction = (typeof AGENT_ACTIONS)[number];

export const ERROR_CODES = [
  "VALIDATION_ERROR",
  "NOT_VERIFIED",
  "BRANCH_REQUIRED",
  "NOT_FOUND",
  "SLOT_UNAVAILABLE",
  "PATIENT_CONFLICT",
  "HOLD_EXPIRED",
  "INVALID_STATE",
  "OUTSIDE_POLICY",
  "APPROVAL_PENDING",
  "APPROVAL_DENIED",
  "APPROVAL_EXPIRED",
  "APPROVAL_ALREADY_USED",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_MISMATCH",
  "FORBIDDEN",
  "UNAUTHORIZED",
  "RATE_LIMITED",
  "UPSTREAM_TIMEOUT",
  "DB_ERROR",
  "INTERNAL",
  "DELIVERY_FAILED",
  "NOTIFICATION_NOT_CONFIGURED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const AGENT_ACTION: Record<ErrorCode, AgentAction> = {
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

export const RETRYABLE: Record<ErrorCode, boolean> = {
  VALIDATION_ERROR: false,
  NOT_VERIFIED: false,
  BRANCH_REQUIRED: false,
  NOT_FOUND: false,
  SLOT_UNAVAILABLE: true,
  PATIENT_CONFLICT: false,
  HOLD_EXPIRED: true,
  INVALID_STATE: false,
  OUTSIDE_POLICY: false,
  APPROVAL_PENDING: false,
  APPROVAL_DENIED: false,
  APPROVAL_EXPIRED: true,
  APPROVAL_ALREADY_USED: false,
  APPROVAL_NOT_FOUND: false,
  APPROVAL_MISMATCH: false,
  FORBIDDEN: false,
  UNAUTHORIZED: false,
  RATE_LIMITED: true,
  UPSTREAM_TIMEOUT: true,
  DB_ERROR: true,
  INTERNAL: true,
  DELIVERY_FAILED: false,
  NOTIFICATION_NOT_CONFIGURED: false,
};

const trimmed = z.string().trim();
const nonEmpty = trimmed.min(1);
const dateTimeString = nonEmpty.refine((value) => Number.isFinite(Date.parse(value)), {
  message: "Invalid datetime",
});

export const toolNames = [
  "get_clinic_info",
  "select_branch",
  "identify_patient",
  "check_availability",
  "hold_slot",
  "request_approval",
  "confirm_booking",
  "reschedule_appointment",
  "cancel_appointment",
  "list_my_appointments",
  "add_note",
  "escalate_to_human",
] as const;
export type ToolName = (typeof toolNames)[number];

export const requestApprovalActionSchema = z.enum([
  "confirm_booking",
  "reschedule_appointment",
  "cancel_appointment",
]);

export const getClinicInfoInputSchema = z.object({}).strict();
export const selectBranchInputSchema = z.object({ branch_ref: nonEmpty.max(120) }).strict();
export const identifyPatientInputSchema = z
  .object({
    full_name: nonEmpty.max(120),
    phone: nonEmpty.max(60),
  })
  .strict();

export const checkAvailabilityInputSchema = z
  .object({
    doctor_ref: nonEmpty.max(120).optional(),
    visit_type_code: nonEmpty.max(120).optional(),
    from: dateTimeString,
    to: dateTimeString,
    part_of_day: z.enum(["morning", "afternoon", "evening"]).optional(),
    limit: z.number().int().min(1).max(5).optional(),
  })
  .strict();

export const holdSlotInputSchema = z
  .object({
    doctor_ref: nonEmpty.max(120),
    visit_type_code: nonEmpty.max(120).optional(),
    starts_at: dateTimeString,
  })
  .strict();

export const requestApprovalInputSchema = z
  .object({
    action: requestApprovalActionSchema,
    appointment_ref: nonEmpty.max(120),
    new_starts_at: dateTimeString.optional(),
    reason: trimmed.max(500).optional(),
  })
  .strict();

export const approvalIdInputSchema = z.object({ approval_id: nonEmpty.max(120) }).strict();
export const listAppointmentsInputSchema = z.object({}).strict();

export const addNoteInputSchema = z
  .object({
    kind: z.enum(["note", "summary"]),
    body: nonEmpty.max(2000),
    appointment_ref: nonEmpty.max(120).optional(),
  })
  .strict();

export const escalateToHumanInputSchema = z
  .object({
    severity: z.enum(["emergency", "urgent", "handoff"]),
    reason: nonEmpty.max(500),
    summary: nonEmpty.max(2000),
    branch: nonEmpty.max(120).optional(),
    caller_name: trimmed.max(120).optional(),
    caller_phone: trimmed.max(60).optional(),
  })
  .strict();

export const toolInputSchemas = {
  get_clinic_info: getClinicInfoInputSchema,
  select_branch: selectBranchInputSchema,
  identify_patient: identifyPatientInputSchema,
  check_availability: checkAvailabilityInputSchema,
  hold_slot: holdSlotInputSchema,
  request_approval: requestApprovalInputSchema,
  confirm_booking: approvalIdInputSchema,
  reschedule_appointment: approvalIdInputSchema,
  cancel_appointment: approvalIdInputSchema,
  list_my_appointments: listAppointmentsInputSchema,
  add_note: addNoteInputSchema,
  escalate_to_human: escalateToHumanInputSchema,
} satisfies Record<ToolName, z.ZodTypeAny>;

export type ToolInputMap = {
  get_clinic_info: z.infer<typeof getClinicInfoInputSchema>;
  select_branch: z.infer<typeof selectBranchInputSchema>;
  identify_patient: z.infer<typeof identifyPatientInputSchema>;
  check_availability: z.infer<typeof checkAvailabilityInputSchema>;
  hold_slot: z.infer<typeof holdSlotInputSchema>;
  request_approval: z.infer<typeof requestApprovalInputSchema>;
  confirm_booking: z.infer<typeof approvalIdInputSchema>;
  reschedule_appointment: z.infer<typeof approvalIdInputSchema>;
  cancel_appointment: z.infer<typeof approvalIdInputSchema>;
  list_my_appointments: z.infer<typeof listAppointmentsInputSchema>;
  add_note: z.infer<typeof addNoteInputSchema>;
  escalate_to_human: z.infer<typeof escalateToHumanInputSchema>;
};

export type ToolError = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  agent_action: AgentAction;
  details?: Record<string, unknown>;
};

export type ToolOk<T> = {
  ok: true;
  data: T;
  meta: { request_id: string; latency_ms: number };
};

export type ToolErr = {
  ok: false;
  error: ToolError;
  meta: { request_id: string; latency_ms: number };
};

/** The shape returned by the SQL functions (and by a failed RPC) before `meta` is added. */
export type OkEnvelope<T = unknown> = { ok: true; data: T };
export type ErrorEnvelope = { ok: false; error: ToolError };
export type Envelope<T = unknown> = OkEnvelope<T> | ErrorEnvelope;

/** Narrows an untyped RPC result to the failure envelope. */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === false &&
    typeof (value as { error?: unknown }).error === "object" &&
    (value as { error?: unknown }).error !== null
  );
}

export function fail(code: ErrorCode, message: string, details?: Record<string, unknown>) {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: RETRYABLE[code],
      agent_action: AGENT_ACTION[code],
      ...(details ? { details } : {}),
    },
  } as const;
}

export function withMeta<T extends { ok: boolean }>(result: T, requestId: string, latencyMs: number): T & { meta: { request_id: string; latency_ms: number } } {
  return {
    ...result,
    meta: { request_id: requestId, latency_ms: latencyMs },
  };
}

export function asErrorCode(value: unknown): ErrorCode | null {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value)
    ? (value as ErrorCode)
    : null;
}
