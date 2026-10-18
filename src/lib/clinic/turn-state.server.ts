/**
 * Compact server-built state for the `CLINIC_GATEWAY_SESSION=agent-scoped-delta`
 * experiment.
 *
 * In that mode the bridge sends only the caller's newest user turn and lets the
 * Gateway-owned session carry the conversation. Voice turns need the facts the
 * agent must not ask twice (who is calling, which branch, the live hold, existing
 * appointment references, the pending approval) even when the Gateway session is
 * new or trimmed, so they are read here from the database that decides them.
 *
 * Nothing here is generated or guessed: a field with no row is omitted, and the
 * whole message is omitted when the session is unknown. The phone number is never
 * included — the task only needs the display name, and less PII on the wire is
 * better.
 */

type Row = Record<string, unknown>;

type Query = {
  select: (fields: string) => Query;
  eq: (column: string, value: unknown) => Query;
  in: (column: string, values: unknown[]) => Query;
  gt: (column: string, value: unknown) => Query;
  order: (column: string, options: { ascending: boolean }) => Query;
  limit: (count: number) => Promise<{ data: Row[] | null; error: { message?: string | null } | null }>;
};

type Client = { from: (table: string) => Query };

export type TurnState = {
  patientName: string | null;
  branchRef: string | null;
  branchName: string | null;
  hold: { code: string; startsAt: string } | null;
  appointments: Array<{ code: string; startsAt: string; status: string }>;
  approval: { id: string; title: string } | null;
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function readTurnState(sessionId: string, now = new Date()): Promise<TurnState | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const db = supabaseAdmin as unknown as Client;

  const session = await db
    .from("call_sessions")
    .select("patient_id,branch_id")
    .eq("id", sessionId)
    .limit(1);
  if (session.error) throw new Error(session.error.message ?? "call_sessions read failed");
  const sessionRow = session.data?.[0];
  if (!sessionRow) return null;

  const patientId = text(sessionRow["patient_id"]);
  const branchId = text(sessionRow["branch_id"]);

  const [patient, branch, holds, booked, approvals] = await Promise.all([
    patientId
      ? db.from("patients").select("full_name").eq("id", patientId).limit(1)
      : Promise.resolve({ data: [], error: null }),
    branchId
      ? db.from("branches").select("slug,name_ar").eq("id", branchId).limit(1)
      : Promise.resolve({ data: [], error: null }),
    db
      .from("appointments")
      .select("confirmation_code,starts_at")
      .eq("session_id", sessionId)
      .eq("status", "held")
      .gt("hold_expires_at", now.toISOString())
      .order("starts_at", { ascending: true })
      .limit(1),
    patientId
      ? db
          .from("appointments")
          .select("confirmation_code,starts_at,status")
          .eq("patient_id", patientId)
          .in("status", ["booked"])
          .order("starts_at", { ascending: true })
          .limit(3)
      : Promise.resolve({ data: [], error: null }),
    db
      .from("approvals")
      .select("id,title")
      .eq("session_id", sessionId)
      .eq("status", "pending")
      .gt("expires_at", now.toISOString())
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const patientRow = patient.data?.[0];
  const branchRow = branch.data?.[0];
  const holdRow = holds.data?.[0];
  const approvalRow = approvals.data?.[0];

  return {
    patientName: patientRow ? text(patientRow["full_name"]) : null,
    branchRef: branchRow ? text(branchRow["slug"]) : null,
    branchName: branchRow ? text(branchRow["name_ar"]) : null,
    hold:
      holdRow && text(holdRow["confirmation_code"]) && text(holdRow["starts_at"])
        ? { code: text(holdRow["confirmation_code"]) as string, startsAt: text(holdRow["starts_at"]) as string }
        : null,
    appointments: (booked.data ?? [])
      .map((row) => ({
        code: text(row["confirmation_code"]),
        startsAt: text(row["starts_at"]),
        status: text(row["status"]),
      }))
      .filter((row): row is { code: string; startsAt: string; status: string } =>
        row.code !== null && row.startsAt !== null && row.status !== null,
      ),
    approval:
      approvalRow && text(approvalRow["id"])
        ? { id: text(approvalRow["id"]) as string, title: text(approvalRow["title"]) ?? "" }
        : null,
  };
}

/**
 * The model-facing message. It lists only facts that exist; every line is something the
 * caller already said or the database already decided, so re-asking it is a defect.
 */
export function turnStateMessage(state: TurnState): string | null {
  const lines: string[] = [];
  if (state.patientName) lines.push(`patient: ${state.patientName}`);
  if (state.branchRef) lines.push(`branch: ${state.branchName ?? state.branchRef} (${state.branchRef})`);
  if (state.hold) lines.push(`live hold: ${state.hold.code} at ${state.hold.startsAt} (not booked yet)`);
  if (state.appointments.length) {
    lines.push(
      `appointments: ${state.appointments.map((row) => `${row.code} at ${row.startsAt}`).join("; ")}`,
    );
  }
  if (state.approval) lines.push(`pending approval: ${state.approval.id} (${state.approval.title})`);
  if (!lines.length) return null;
  return [
    "SERVER STATE — authoritative, do not ask for anything already listed:",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
}
