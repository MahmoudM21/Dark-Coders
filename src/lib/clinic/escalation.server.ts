import { fail } from "./contracts.ts";
import { callRpc } from "./db.server.ts";

type EscalationArgs = {
  severity: "emergency" | "urgent" | "handoff";
  reason: string;
  summary: string;
  branch?: string | undefined;
  caller_name?: string | undefined;
  caller_phone?: string | undefined;
};

type RpcFn = typeof callRpc;

type Deps = {
  callRpcFn?: RpcFn;
  fetchImpl?: typeof fetch;
};

function mapDeliveryError(status: number, body: string): string {
  const detail = body.trim().slice(0, 200);
  return detail ? `${status} ${detail}` : `HTTP ${status}`;
}

async function postWebhook(url: string, payload: Record<string, unknown>, signal: AbortSignal, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal,
  });
  if (!response.ok) {
    const body = await response.text();
    return fail("DELIVERY_FAILED", "Escalation delivery failed", { status: mapDeliveryError(response.status, body) });
  }
  return { ok: true as const };
}

export async function escalate(sessionId: string, args: EscalationArgs, deps: Deps = {}) {
  const rpc = deps.callRpcFn ?? callRpc;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const opened = await rpc(
    "clinic_escalate",
    {
      p_session: sessionId,
      p_severity: args.severity,
      p_reason: args.reason,
      p_summary: args.summary,
    },
    { requestId: sessionId },
  );

  if (!opened.ok) return opened;

  const row = opened.data as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== "object") return fail("INTERNAL", "Escalation record is malformed");

  const escalationId = row["escalation_id"];
  const route = row["route"];
  const withinHours = row["within_hours"];
  const publicInfo = row["public"] as Record<string, unknown> | undefined;

  if (typeof escalationId !== "string" || (route !== "live_transfer" && route !== "notify_contact") || typeof withinHours !== "boolean") {
    return fail("INTERNAL", "Escalation record is missing required fields");
  }

  const emergencyServicesNumber = typeof publicInfo?.["emergency_services_number"] === "string"
    ? publicInfo["emergency_services_number"]
    : "";
  const clinicPhone = typeof publicInfo?.["clinic_phone"] === "string" ? publicInfo["clinic_phone"] : "";

  let deliveryStatus: "notified" | "delivery_failed" | "connected" = "delivery_failed";
  let deliveryError: string | undefined;
  let updateChannel: "webhook" | "none" = "none";

  if (route === "live_transfer") {
    deliveryError = "live transfer not available in this build";
  }

  const webhookUrl = process.env["ESCALATION_WEBHOOK_URL"]?.trim();
  if (!webhookUrl) {
    deliveryError = deliveryError ?? "ESCALATION_WEBHOOK_URL is not configured";
  } else {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const payload: Record<string, unknown> = {
        severity: args.severity,
        reason: args.reason,
        summary: args.summary,
        branch: args.branch ?? null,
        caller_name: args.caller_name ?? null,
        caller_phone: args.caller_phone ?? null,
        within_hours: withinHours,
        escalation_id: escalationId,
      };
      const sent = await postWebhook(webhookUrl, payload, controller.signal, fetchImpl);
      if (sent.ok) {
        deliveryStatus = "notified";
        updateChannel = "webhook";
        deliveryError = undefined;
      } else {
        deliveryError = sent.error.details?.["status"]
          ? String(sent.error.details["status"])
          : sent.error.message;
      }
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        deliveryError = "Webhook request timed out after 5000ms";
      } else {
        deliveryError = error instanceof Error ? error.message : "Webhook delivery failed";
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  const update = await rpc(
    "clinic_escalation_update",
    {
      p_id: escalationId,
      p_status: deliveryStatus,
      p_channel: updateChannel,
      p_error: deliveryError ?? null,
    },
    { requestId: sessionId },
  );

  if (!update.ok) return update;

  return {
    ok: true,
    data: {
      escalation_id: escalationId,
      route,
      within_hours: withinHours,
      delivery_status: deliveryStatus,
      ...(deliveryError ? { delivery_error: deliveryError } : {}),
      emergency_services_number: emergencyServicesNumber,
      clinic_phone: clinicPhone,
    },
  } as const;
}
