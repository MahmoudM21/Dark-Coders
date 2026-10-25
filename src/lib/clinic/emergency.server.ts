import { escalate } from "./escalation.server.ts";
import { classifyEmergency, emergencySummary, type EmergencyCategory } from "./emergency.ts";

/**
 * The emergency escalation is performed by the server, before the model is asked anything.
 *
 * The prompt already says "safety first", and the measured runs escalated in only 3 of 8
 * turns that described urgent pain — so the decision cannot live in the model. This module
 * classifies the caller's own words, calls the existing {@link escalate} delivery path (no
 * second implementation of the webhook/route logic), and hands the model a system note
 * containing what actually happened, so it can neither invent nor re-do the escalation.
 *
 * The session is opened by the bridge earlier in the same request, before this runs, so no
 * session setup is repeated here.
 */

export type EmergencyPrecheckResult =
  | { matched: false }
  | {
      matched: true;
      category: EmergencyCategory;
      delivery_status: string;
      emergency_services_number: string;
      /** The system note injected into the gateway request. */
      note: string;
    };

export type EmergencyPrecheckDeps = {
  escalateFn?: typeof escalate;
  /** Required, not defaulted: an escalation that is not audited is not acceptable. */
  audit: (entry: Record<string, unknown>) => Promise<void>;
};

export const EMERGENCY_NOTE_PREFIX = "ESCALATION ALREADY PERFORMED";

/**
 * The exact instruction the model receives. It only ever repeats the real delivery status,
 * and the emergency number comes from the clinic's own branch row.
 */
export function emergencyNote(deliveryStatus: string, emergencyNumber: string): string {
  return [
    `${EMERGENCY_NOTE_PREFIX}: delivery_status=${deliveryStatus}, emergency_services_number=${emergencyNumber || "not configured"}.`,
    "Do not claim anything beyond delivery_status. Do not offer booking this turn.",
  ].join(" ");
}

function deliveryOf(result: unknown): { status: string; number: string } {
  if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true) {
    return { status: "delivery_failed", number: "" };
  }
  const data = (result as { data?: unknown }).data;
  if (!data || typeof data !== "object") return { status: "delivery_failed", number: "" };
  const record = data as Record<string, unknown>;
  const status = typeof record["delivery_status"] === "string" && record["delivery_status"]
    ? record["delivery_status"]
    : "delivery_failed";
  const number = typeof record["emergency_services_number"] === "string" ? record["emergency_services_number"] : "";
  return { status, number };
}

/** Classifies one caller turn and, on a match, escalates and audits it. Pure of prompt text. */
export async function emergencyPrecheck(
  input: { text: string; sessionId: string },
  deps: EmergencyPrecheckDeps,
): Promise<EmergencyPrecheckResult> {
  const verdict = classifyEmergency(input.text);
  if (!verdict.match) return { matched: false };

  const escalateFn = deps.escalateFn ?? escalate;
  let delivery = { status: "delivery_failed", number: "" };
  try {
    const result = await escalateFn(input.sessionId, {
      severity: "emergency",
      reason: verdict.category,
      summary: emergencySummary(input.text),
    });
    delivery = deliveryOf(result);
  } catch {
    // A thrown delivery is still a real, recorded failure — never an unhandled rejection that
    // would skip the audit row and the caller's safety screen.
    delivery = { status: "delivery_failed", number: "" };
  }

  await deps.audit({
    session_id: input.sessionId,
    actor: "bridge",
    event: "emergency_precheck",
    outcome: delivery.status === "delivery_failed" ? "error" : "ok",
    input: { category: verdict.category, delivery_status: delivery.status },
  });

  return {
    matched: true,
    category: verdict.category,
    delivery_status: delivery.status,
    emergency_services_number: delivery.number,
    note: emergencyNote(delivery.status, delivery.number),
  };
}

/**
 * The one seam the bridge uses: classify + escalate first, then call the gateway with the
 * note (or with nothing at all). Keeping the order inside one function is what makes
 * "escalated before the model was asked" testable with a fake escalate and a fake gateway.
 */
export async function precheckBeforeGateway<T>(
  input: { text: string; sessionId: string },
  callGateway: (note: string | null) => Promise<T>,
  deps: EmergencyPrecheckDeps,
): Promise<T> {
  const precheck = await emergencyPrecheck(input, deps);
  return callGateway(precheck.matched ? precheck.note : null);
}
