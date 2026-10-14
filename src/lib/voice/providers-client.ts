import { JSON_INSTRUCTION, SYSTEM_PROMPT, planContextMessage } from "@/lib/voice/prompt";
import { readError, readSse, streamAgentAnswer, type Turn } from "@/lib/voice/agent";
import { KIND_INFO, type Provider } from "@/lib/settings/providers";

type Handlers = { onThinking: (text: string) => void; onAnswer: (text: string) => void };

/** Removes ```json fences some local models add. */
export function cleanRaw(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
}

/** Runs one turn on the chosen provider. Local models are called straight from this browser. */
export async function runProvider(provider: Provider, turns: Turn[], context: string, handlers: Handlers, signal: AbortSignal): Promise<string> {
  const where = KIND_INFO[provider.kind].where;
  if (where === "built-in") return streamAgentAnswer(turns, handlers, signal, context || undefined, provider.model);

  if (where === "local") {
    const system = [SYSTEM_PROMPT, JSON_INSTRUCTION, planContextMessage(context)].filter(Boolean).join("\n\n");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
    let response: Response;
    try {
      response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST", headers, signal,
        body: JSON.stringify({
          model: provider.model, stream: true,
          messages: [{ role: "system", content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))],
        }),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(`Couldn't reach ${provider.name} at ${provider.baseUrl}. Make sure it's running on this computer and allows this site.`);
    }
    if (!response.ok) throw new Error(`${provider.name} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    let answer = "";
    await readSse(response, (data) => {
      if (data === "[DONE]") return;
      const delta = (JSON.parse(data) as { choices?: { delta?: { content?: string } }[] }).choices?.[0]?.delta?.content;
      if (delta) { answer += delta; handlers.onAnswer(answer); }
    });
    if (!answer.trim()) throw new Error(`${provider.name} returned an empty answer`);
    return answer;
  }

  const response = await fetch("/api/llm", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: provider.kind, model: provider.model, turns, context,
      ...(provider.keySource === "vault" ? { vaultPath: provider.vaultPath, vaultField: provider.vaultField } : { apiKey: provider.apiKey }),
    }),
  });
  if (!response.ok) throw new Error(await readError(response, `${provider.name} could not answer`));
  const { text } = (await response.json()) as { text: string };
  handlers.onAnswer(text);
  return text;
}
