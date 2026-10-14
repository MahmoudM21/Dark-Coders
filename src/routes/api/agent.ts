import { createFileRoute } from "@tanstack/react-router";
import { OUTPUT_FORMAT, SYSTEM_PROMPT, planContextMessage } from "@/lib/voice/prompt";

type Turn = { role: "user" | "assistant"; text: string };

export const Route = createFileRoute("/api/agent")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { streamResponses } = await import("@/lib/ai/responses.server");

        let turns: Turn[] = [];
        let context: string | undefined;
        let modelName: string | undefined;
        try {
          const body = (await request.json()) as { turns?: Turn[]; context?: unknown; model?: unknown };
          if (Array.isArray(body.turns)) turns = body.turns.filter((t) => t && typeof t.text === "string");
          if (typeof body.context === "string") context = body.context;
          if (typeof body.model === "string") modelName = body.model;
        } catch {
          turns = [];
        }
        if (!turns.length) {
          return new Response(JSON.stringify({ error: "Nothing to answer" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const { resolveGatewayModel } = await import("@/lib/ai/models");
        const model = resolveGatewayModel(modelName);
        if (!model) {
          return new Response(JSON.stringify({ error: `${modelName} isn't offered by the built-in AI service` }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const plan = planContextMessage(context);
        const input: Record<string, unknown>[] = [
          { role: "system", content: [{ type: "input_text", text: SYSTEM_PROMPT }] },
          ...(plan ? [{ role: "system", content: [{ type: "input_text", text: plan }] }] : []),
          ...turns.slice(-12).map((turn) => ({
            role: turn.role,
            content: [
              turn.role === "assistant"
                ? { type: "output_text", text: turn.text }
                : { type: "input_text", text: turn.text },
            ],
          })),
        ];

        return streamResponses(request, input, { text: { format: OUTPUT_FORMAT } }, model);
      },
    },
  },
});
