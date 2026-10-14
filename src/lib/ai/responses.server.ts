import { CHAT_MODEL, GATEWAY_BASE_URL, getGatewayHeaders } from "./gateway.server";
import {
  createLovableAiGatewayRunIdFetch,
  getLovableAiGatewayResponseHeaders,
  getLovableAiGatewayRunId,
} from "./run-id.server";

export async function streamResponses(
  request: Request,
  input: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
  model: string = CHAT_MODEL,
) {
  // Default to OpenClaw's OpenAI-compatible /v1/chat/completions stream unless explicitly targeting /v1/responses
  if (!model.startsWith("openai/")) return streamChatAsResponses(request, input, model);
  const gateway = createLovableAiGatewayRunIdFetch(getLovableAiGatewayRunId(request));
  try {
    const response = await gateway.fetch(`${GATEWAY_BASE_URL}/v1/responses`, {
      method: "POST",
      signal: request.signal,
      headers: getGatewayHeaders({
        "Content-Type": "application/json",
        "X-Lovable-AIG-SDK": "fetch",
      }),
      body: JSON.stringify({
        model,
        input,
        stream: true,
        store: false,
        reasoning: { effort: "medium", summary: "auto" },
        include: ["reasoning.encrypted_content"],
        ...extra,
      }),
    });
    const headers = getLovableAiGatewayResponseHeaders(response.headers);
    headers.set("Content-Type", response.headers.get("Content-Type") ?? "text/event-stream");
    headers.set("Cache-Control", "no-cache");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    if (request.signal.aborted && error instanceof Error && error.name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    return new Response(
      JSON.stringify({
        error: `Could not reach OpenClaw Gateway at ${GATEWAY_BASE_URL}. Start your OpenClaw gateway or configure OPENCLAW_GATEWAY_URL in .env.`,
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

/** Streams from OpenClaw Gateway (/v1/chat/completions) and re-emits deltas as Responses-style SSE events. */
async function streamChatAsResponses(request: Request, input: Record<string, unknown>[], model: string) {
  const gateway = createLovableAiGatewayRunIdFetch(getLovableAiGatewayRunId(request));
  const messages = input.map((m) => ({
    role: m["role"],
    content: ((m["content"] as { text: string }[]) ?? []).map((c) => c.text).join("\n"),
  }));
  messages.push({ role: "system", content: "Reply with only the JSON object described above, no code fences." });
  try {
    const response = await gateway.fetch(`${GATEWAY_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      signal: request.signal,
      headers: getGatewayHeaders({ "Content-Type": "application/json", "X-Lovable-AIG-SDK": "fetch" }),
      body: JSON.stringify({ model, messages, stream: true }),
    });
    const headers = getLovableAiGatewayResponseHeaders(response.headers);
    if (!response.ok || !response.body) {
      headers.set("Content-Type", "application/json");
      const detail = (await response.text()).slice(0, 300);
      return new Response(JSON.stringify({ error: `${model} returned ${response.status}: ${detail}` }), { status: response.status, headers });
    }
    headers.set("Content-Type", "text/event-stream");
    headers.set("Cache-Control", "no-cache");
    const enc = new TextEncoder();
    let buf = "";
    const out = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, Uint8Array>({
      transform(chunk, ctrl) {
        buf += chunk;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const data = line.startsWith("data:") ? line.slice(5).trim() : "";
          if (!data || data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data) as {
              choices?: { delta?: { content?: string; reasoning_content?: string } }[];
            };
            const reasoning = parsed.choices?.[0]?.delta?.reasoning_content;
            if (reasoning) {
              ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: reasoning })}\n\n`));
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`));
          } catch { /* partial line */ }
        }
      },
    }));
    return new Response(out, { status: 200, headers });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return new Response(
      JSON.stringify({
        error: `Could not reach OpenClaw Gateway at ${GATEWAY_BASE_URL}. Start your OpenClaw gateway or configure OPENCLAW_GATEWAY_URL in .env.`,
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}
