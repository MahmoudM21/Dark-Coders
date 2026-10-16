import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { COMMAND_NAMES } from "@/lib/voice/screen";
import { JSON_INSTRUCTION, OUTPUT_FORMAT, SYSTEM_PROMPT, planContextMessage } from "@/lib/voice/prompt";

type Turn = { role: "user" | "assistant"; text: string };

const approvalRegex = {
  approved: /^Approved action \[(apr_[a-z0-9]{12})\] \(.*\)\. Proceed and report the result\.$/,
  denied: /^Denied action \[(apr_[a-z0-9]{12})\] \(.*\)\. Do not execute\.$/,
};

const navEnum = z.enum(["back", "cancel", "home"]);
const commandEnum = z.enum(COMMAND_NAMES);
const screenSchema = z
  .object({
    kind: z.literal("screen"),
    screen: z
      .object({
        text: z.string().trim().min(1).max(240),
        choices: z
          .array(
            z.object({
              id: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
              label: z.string().min(1).max(40),
              value: z.string().min(1).max(1000),
            }),
          )
          .max(4),
        navigation: z.array(navEnum).max(4),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.choices.length + value.navigation.length > 4) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "choices + navigation must be <= 4" });
        }
      }),
    action_proposal: z
      .union([
        z.null(),
        z
          .object({
            id: z.string().min(1).max(64),
            title: z.string().min(1).max(120),
            tool: z.string().min(1).max(80),
            summary: z.string().min(1).max(500),
            risk: z.enum(["low", "medium", "high"]).optional(),
          })
          .strict(),
      ])
      .nullable(),
    app_commands: z
      .array(
        z
          .object({
            name: commandEnum,
            value: z.string(),
          })
          .strict(),
      )
      .max(3),
  })
  .strict();

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function sse(data: unknown) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function extractJson(raw: string) {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

function safeScreenText(locale: string) {
  return locale.toLowerCase().startsWith("ar")
    ? "تعذر إكمال هذه الخطوة. آخر حالة مؤكدة لم تتغير."
    : "That step could not be completed. Your last confirmed state is unchanged.";
}

function parseSseLine(line: string) {
  if (!line.startsWith("data:")) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === "[DONE]") return null;
  try {
    return JSON.parse(payload) as { type?: string; delta?: string; text?: string };
  } catch {
    return null;
  }
}

async function collectModelOutput(response: Response, onReasoning: (delta: string) => void) {
  if (!response.ok || !response.body) {
    const detail = (await response.text()).slice(0, 300);
    throw new Error(`MODEL_HTTP_${response.status}:${detail}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let output = "";
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    buffer += next.value;
    const segments = buffer.split("\n");
    buffer = segments.pop() ?? "";
    for (const segment of segments) {
      const event = parseSseLine(segment);
      if (!event) continue;
      if (event.type === "response.reasoning_summary_text.delta" && event.delta) onReasoning(event.delta);
      if (event.type === "response.output_text.delta" && event.delta) output += event.delta;
      if (event.type === "response.output_text.done" && typeof event.text === "string") output = event.text;
    }
  }
  return output.trim();
}

function parseApprovalIntent(text: string) {
  const approved = text.match(approvalRegex.approved);
  if (approved) return { id: approved[1]!, decision: "approved" as const };
  const denied = text.match(approvalRegex.denied);
  if (denied) return { id: denied[1]!, decision: "denied" as const };
  return null;
}

async function auditBridgeEvent(entry: Record<string, unknown>) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const client = supabaseAdmin as unknown as {
      from: (table: string) => {
        insert: (value: Record<string, unknown>) => Promise<{ error: { message?: string | null } | null }>;
      };
    };
    const result = await client.from("audit_events").insert(entry);
    if (result.error) throw new Error(result.error.message ?? "audit insert failed");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[bridge.audit] ${message}\n`);
  }
}

function toModelInput(turns: Turn[], context: string | undefined) {
  const plan = planContextMessage(context);
  return [
    { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
    ...(plan ? [{ role: "system", content: [{ type: "input_text", text: plan }] }] : []),
    ...turns.map((turn) => ({
      role: turn.role,
      content: [
        turn.role === "assistant"
          ? { type: "output_text", text: turn.text }
          : { type: "input_text", text: turn.text },
      ],
    })),
  ] as Record<string, unknown>[];
}

export const Route = createFileRoute("/api/agent")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { streamResponses } = await import("@/lib/ai/responses.server");

        let turns: Turn[] = [];
        let context: string | undefined;
        let modelName: string | undefined;
        let sessionId: string | undefined;
        try {
          const body = (await request.json()) as {
            turns?: Turn[];
            context?: unknown;
            model?: unknown;
            session_id?: unknown;
          };
          if (Array.isArray(body.turns)) turns = body.turns.filter((t) => t && typeof t.text === "string");
          if (typeof body.context === "string") context = body.context;
          if (typeof body.model === "string") modelName = body.model;
          if (typeof body.session_id === "string") sessionId = body.session_id;
        } catch {
          turns = [];
        }

        if (!turns.length) {
          return json({ error: "Nothing to answer" }, 400);
        }

        const { resolveGatewayModel } = await import("@/lib/ai/models");
        const model = resolveGatewayModel(modelName);
        if (!model) {
          return json({ error: `${modelName} isn't offered by the built-in AI service` }, 400);
        }

        const isClinicModel = model.startsWith("openclaw/clinic-");
        if (!isClinicModel) {
          const input = toModelInput(turns.slice(-12), context);
          return streamResponses(request, input, { text: { format: OUTPUT_FORMAT } }, model);
        }

        const parsedSession = z.string().uuid().safeParse(sessionId);
        if (!parsedSession.success) return json({ error: "session_id must be a UUID" }, 400);
        const clinicSessionId = parsedSession.data;

        const locale = request.headers.get("accept-language")?.split(",")[0]?.trim() || "ar-EG";
        const tenantSlug = process.env["CLINIC_TENANT_SLUG"] || "demo-dental";

        const { callRpc } = await import("@/lib/clinic/db.server");
        const { isErrorEnvelope } = await import("@/lib/clinic/contracts");
        const { clinicInfoCache, parseAvailabilitySnapshot, snapshotCache, snapshotNeedsRefresh } = await import(
          "@/lib/clinic/snapshot.server"
        );

        // A clinic tool call costs two extra model round trips, so the bridge prefetches
        // the next free slots for every branch and injects them as data-only context. The
        // snapshot is advisory: it reserves nothing and a stale one is never injected.
        const cachedSnapshot = snapshotCache.get(clinicSessionId);
        const refreshSnapshot = snapshotNeedsRefresh(cachedSnapshot, Date.now());
        const prefetchArgs = { p_session: clinicSessionId, p_days: 2, p_limit: 5 };

        // Both RPCs are independent, so they run together rather than one after the other.
        const [openSession, firstPrefetch] = await Promise.all([
          callRpc(
            "clinic_open_session",
            {
              p_session: clinicSessionId,
              p_tenant_slug: tenantSlug,
              p_channel: "console_voice",
              p_locale: locale,
            },
            { requestId: clinicSessionId },
          ),
          refreshSnapshot
            ? callRpc("clinic_prefetch_availability", prefetchArgs, { requestId: clinicSessionId })
            : Promise.resolve(null),
        ]);
        if (isErrorEnvelope(openSession)) {
          return json({ error: openSession.error.message }, 502);
        }

        // On the first turn the session row may still be committing while the prefetch is
        // in flight, so NOT_FOUND there is a race rather than a failure: retry it once now
        // that the session is open.
        let prefetch = firstPrefetch;
        if (prefetch && isErrorEnvelope(prefetch) && prefetch.error.code === "NOT_FOUND") {
          prefetch = await callRpc("clinic_prefetch_availability", prefetchArgs, { requestId: clinicSessionId });
        }
        const freshSnapshot = prefetch ? parseAvailabilitySnapshot(prefetch, Date.now()) : null;
        if (freshSnapshot) snapshotCache.set(clinicSessionId, freshSnapshot);
        if (prefetch && isErrorEnvelope(prefetch)) {
          // Carry on without a snapshot instead of inventing one. An ok envelope that simply
          // has nothing to advertise is not a failure, so it only reaches stderr.
          await auditBridgeEvent({
            session_id: clinicSessionId,
            actor: "bridge",
            event: "prefetch_failed",
            outcome: "error",
            error_code: prefetch.error.code,
          });
        } else if (refreshSnapshot && !freshSnapshot) {
          process.stderr.write("[bridge.prefetch] envelope carried no injectable slots\n");
        }
        const activeSnapshot = freshSnapshot ?? (refreshSnapshot ? null : cachedSnapshot);

        const lastUser = [...turns].reverse().find((turn) => turn.role === "user")?.text ?? "";
        const approvalIntent = parseApprovalIntent(lastUser);

        if (approvalIntent) {
          const decision = await callRpc(
            "clinic_decide_approval",
            {
              p_approval_id: approvalIntent.id,
              p_session: clinicSessionId,
              p_decision: approvalIntent.decision,
              p_operator: "operator:console",
            },
            { requestId: clinicSessionId },
          );

          if (isErrorEnvelope(decision)) {
            const code = decision.error.code;
            if (code === "APPROVAL_EXPIRED" || code === "NOT_FOUND" || code === "INVALID_STATE") {
              const screen = {
                kind: "screen",
                screen: {
                  text: locale.toLowerCase().startsWith("ar") ? `تعذر اعتماد الإجراء: ${decision.error.message}` : `Approval failed: ${decision.error.message}`,
                  choices: [],
                  navigation: ["home"],
                },
                action_proposal: null,
                app_commands: [],
              };
              await auditBridgeEvent({
                session_id: clinicSessionId,
                actor: "bridge",
                event: "approval_decided",
                outcome: "error",
                error_code: code,
              });
              return new Response(sse({ type: "response.output_text.done", text: JSON.stringify(screen) }), {
                status: 200,
                headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
              });
            }
          }

          await auditBridgeEvent({
            session_id: clinicSessionId,
            actor: "bridge",
            event: "approval_decided",
            outcome: approvalIntent.decision === "approved" ? "ok" : "denied",
          });
        }

        // clinic_get_info only differs per tenant and per selected branch, so it is cached
        // for five minutes under both. Without a snapshot the branch is unknown, so the
        // cache is skipped and the fresh payload is filed under the branch it names itself —
        // that way one session's branch state can never be served to another.
        const infoKeyPrefix = `${tenantSlug}#`;
        const cachedInfo = activeSnapshot ? clinicInfoCache.get(`${infoKeyPrefix}${activeSnapshot.branchRef ?? "-"}`) : null;
        let infoPayload: Record<string, unknown>;
        if (cachedInfo) {
          infoPayload = cachedInfo;
        } else {
          const clinicInfo = await callRpc("clinic_get_info", { p_session: clinicSessionId }, { requestId: clinicSessionId });
          if (isErrorEnvelope(clinicInfo)) {
            return json({ error: clinicInfo.error.message }, 502);
          }
          infoPayload = (clinicInfo.data ?? {}) as Record<string, unknown>;
          const payloadBranch = infoPayload["selected_branch_ref"];
          clinicInfoCache.set(`${infoKeyPrefix}${typeof payloadBranch === "string" ? payloadBranch : "-"}`, infoPayload);
        }
        const contextMessages = [
          {
            role: "system",
            content: [
              {
                type: "input_text",
                text: [
                  `session_id: ${clinicSessionId}`,
                  `locale: ${locale}`,
                  "Pass session_id to every tool call.",
                  `clinic_context: ${JSON.stringify(infoPayload)}`,
                ].join("\n"),
              },
            ],
          },
          ...(activeSnapshot
            ? [
                {
                  role: "system",
                  content: [{ type: "input_text", text: activeSnapshot.text }],
                },
              ]
            : []),
          ...(approvalIntent
            ? [
                {
                  role: "system",
                  content: [
                    {
                      type: "input_text",
                      text: `Server verified: approval ${approvalIntent.id} is ${approvalIntent.decision.toUpperCase()}.`,
                    },
                  ],
                },
              ]
            : []),
        ];

        const mergesHistory = process.env["OPENCLAW_GATEWAY_MERGES_HISTORY"] === "1";
        const selectedTurns = mergesHistory
          ? turns.slice().reverse().find((turn) => turn.role === "user")
            ? [turns.slice().reverse().find((turn) => turn.role === "user") as Turn]
            : turns.slice(-1)
          : turns.slice(-12);

        const baseInput = [
          ...contextMessages,
          ...toModelInput(selectedTurns, context),
        ];

        const stream = new ReadableStream<Uint8Array>({
          start: async (controller) => {
            const enc = new TextEncoder();
            const send = (event: unknown) => controller.enqueue(enc.encode(sse(event)));

            try {
              const response = await streamResponses(
                request,
                baseInput,
                {},
                model,
                { headers: { "x-openclaw-session-key": `clinic:${clinicSessionId}` }, appendJsonInstruction: true },
              );

              let raw = await collectModelOutput(response, (delta) => {
                send({ type: "response.reasoning_summary_text.delta", delta });
              });

              let parsed = screenSchema.safeParse(JSON.parse(extractJson(raw)));
              if (!parsed.success) {
                await auditBridgeEvent({
                  session_id: clinicSessionId,
                  actor: "bridge",
                  event: "repair_attempt",
                  outcome: "error",
                  error_code: "VALIDATION_ERROR",
                });

                const violations = parsed.error.issues.map((issue) => `${issue.path.join(".") || "screen"}: ${issue.message}`).join("; ");
                const repairInput = [
                  ...baseInput,
                  {
                    role: "system",
                    content: [{ type: "input_text", text: `Violations: ${violations}. Return only the corrected JSON.` }],
                  },
                  {
                    role: "system",
                    content: [{ type: "input_text", text: `Original output: ${extractJson(raw)}` }],
                  },
                ];

                const repairResponse = await streamResponses(
                  request,
                  repairInput,
                  {},
                  model,
                  { headers: { "x-openclaw-session-key": `clinic:${clinicSessionId}` }, appendJsonInstruction: true },
                );
                raw = await collectModelOutput(repairResponse, () => {});
                parsed = screenSchema.safeParse(JSON.parse(extractJson(raw)));
              }

              const safe = parsed.success
                ? parsed.data
                : {
                    kind: "screen" as const,
                    screen: { text: safeScreenText(locale), choices: [], navigation: ["home"] as const },
                    action_proposal: null,
                    app_commands: [],
                  };

              const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
              const db = supabaseAdmin as unknown as {
                from: (table: string) => {
                  select: (fields: string) => {
                    eq: (col: string, value: unknown) => {
                      eq: (col2: string, value2: unknown) => {
                        gt: (col3: string, value3: unknown) => {
                          order: (col4: string, opts: { ascending: boolean }) => {
                            limit: (value4: number) => Promise<{ data: Array<Record<string, unknown>> | null }>;
                          };
                        };
                      };
                    };
                  };
                };
              };

              const pending = await db
                .from("approvals")
                .select("id,title,tool,summary,risk")
                .eq("session_id", clinicSessionId)
                .eq("status", "pending")
                .gt("expires_at", new Date().toISOString())
                .order("created_at", { ascending: false })
                .limit(1);

              const fromDb = pending.data?.[0] ?? null;
              const hadModelProposal = safe.action_proposal !== null;
              if (fromDb) {
                safe.action_proposal = {
                  id: String(fromDb["id"]),
                  title: String(fromDb["title"]),
                  tool: String(fromDb["tool"]),
                  summary: String(fromDb["summary"]),
                  ...(fromDb["risk"] ? { risk: fromDb["risk"] as "low" | "medium" | "high" } : {}),
                };
              } else {
                safe.action_proposal = null;
                if (hadModelProposal) {
                  await auditBridgeEvent({
                    session_id: clinicSessionId,
                    actor: "bridge",
                    event: "proposal_dropped",
                    outcome: "error",
                    error_code: "APPROVAL_NOT_FOUND",
                  });
                }
              }

              send({ type: "response.output_text.done", text: JSON.stringify(safe) });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              send({
                type: "response.output_text.done",
                text: JSON.stringify({
                  kind: "screen",
                  screen: { text: safeScreenText(locale), choices: [], navigation: ["home"] },
                  action_proposal: null,
                  app_commands: [],
                }),
              });
              await auditBridgeEvent({
                session_id: clinicSessionId,
                actor: "bridge",
                event: "bridge_error",
                outcome: "error",
                error_code: "INTERNAL",
                input: { message },
              });
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
        });
      },
    },
  },
});

export const __clinicBridgeInternals = {
  approvalRegex,
  screenSchema,
  parseApprovalIntent,
};
