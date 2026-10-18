import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/asr")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const { AsrError, transcribeWithLocalProxy } = await import("@/lib/ai/local-asr.server");
        let file: File | null = null;
        let language: string | null = null;
        try {
          const form = await request.formData();
          const value = form.get("file");
          if (value instanceof File) file = value;
          const requested = form.get("language");
          if (typeof requested === "string" && requested.trim()) language = requested.trim();
        } catch {
          return Response.json(
            { code: "INVALID_MULTIPART", message: "Audio form data could not be read." },
            { status: 400 },
          );
        }
        if (!file || !file.size) {
          return Response.json({ code: "NO_AUDIO", message: "No audio received." }, { status: 400 });
        }
        try {
          const result = await transcribeWithLocalProxy(file, language, request.signal);
          return Response.json({ text: result.text }, { headers: { "Cache-Control": "no-store" } });
        } catch (error) {
          if (request.signal.aborted) {
            return Response.json({ code: "ABORTED", message: "ASR request was cancelled." }, { status: 499 });
          }
          if (error instanceof AsrError) {
            return Response.json(
              { code: error.code, message: error.message, detail: error.detail },
              { status: error.code === "ASR_TIMEOUT" ? 504 : error.code === "NO_AUDIO" ? 400 : 502 },
            );
          }
          return Response.json(
            { code: "ASR_FAILED", message: error instanceof Error ? error.message : "ASR failed." },
            { status: 502 },
          );
        }
      },
    },
  },
});
