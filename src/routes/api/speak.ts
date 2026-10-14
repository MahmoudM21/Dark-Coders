import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/speak")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { requestSpeech } = await import("@/lib/ai/speech.server");

        let text = "";
        try {
          const body = (await request.json()) as { text?: unknown };
          if (typeof body.text === "string") text = body.text.trim();
        } catch {
          text = "";
        }
        if (!text) {
          return new Response(JSON.stringify({ error: "No text to speak" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        try {
          const upstream = await requestSpeech(text.slice(0, 5000), request.signal);
          const headers = new Headers({ "Cache-Control": "no-cache" });
          headers.set("Content-Type", upstream.headers.get("Content-Type") ?? "text/event-stream");
          return new Response(upstream.body, { status: upstream.status, headers });
        } catch (error) {
          if (request.signal.aborted) return new Response(null, { status: 499 });
          const message = error instanceof Error ? error.message : "Speech failed";
          return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});
