import { createFileRoute } from "@tanstack/react-router";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { fail, withMeta } from "@/lib/clinic/contracts";

const bodySchema = z
  .object({
    tool: z.string().trim().min(1),
    args: z.record(z.unknown()).default({}),
  })
  .strict();

const uuidSchema = z.string().uuid();

function secureEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const Route = createFileRoute("/api/clinic/tools")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const requestId = randomUUID();
        const token = process.env["CLINIC_TOOLS_TOKEN"];
        const auth = request.headers.get("authorization") ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";

        if (!token || !bearer || !secureEqual(bearer, token)) {
          return json(withMeta(fail("UNAUTHORIZED", "Missing or invalid clinic tools token"), requestId, 0), 401);
        }

        let bodyRaw: unknown;
        try {
          bodyRaw = await request.json();
        } catch {
          return json({ error: "Invalid JSON body" }, 400);
        }

        const parsed = bodySchema.safeParse(bodyRaw);
        if (!parsed.success) {
          const field = parsed.error.issues[0]?.path.join(".") || "body";
          return json(withMeta(fail("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid request body", { field }), requestId, 0));
        }

        const sessionId = parsed.data.args["session_id"];
        if (typeof sessionId !== "string" || !uuidSchema.safeParse(sessionId).success) {
          return json(
            withMeta(fail("VALIDATION_ERROR", "args.session_id must be a UUID", { field: "args.session_id" }), requestId, 0),
          );
        }

        const args = { ...parsed.data.args };
        delete args["session_id"];

        const { runTool } = await import("@/lib/clinic/tools.server");
        const result = await runTool(parsed.data.tool, args, { session_id: sessionId, request_id: requestId });
        return json(result, 200);
      },
    },
  },
});
