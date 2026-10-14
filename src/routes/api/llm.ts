import { createFileRoute } from "@tanstack/react-router";
import { JSON_INSTRUCTION, SYSTEM_PROMPT, planContextMessage } from "@/lib/voice/prompt";

type Turn = { role: "user" | "assistant"; text: string };

// Fixed hosts only: the browser never chooses where this server sends keys.
const CLOUD: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  openrouter: "https://openrouter.ai/api/v1",
  anthropic: "https://api.anthropic.com/v1",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function keyFromVault(path: string, field: string): Promise<string> {
  const addr = process.env["VAULT_ADDR"];
  const token = process.env["VAULT_TOKEN"];
  if (!addr || !token) throw new Error("HashiCorp Vault is not set up yet (missing Vault address or token).");
  if (!/^[\w\-./]+$/.test(path) || path.includes("..")) throw new Error("That Vault path is not valid.");
  const headers: Record<string, string> = { "X-Vault-Token": token };
  const ns = process.env["VAULT_NAMESPACE"];
  if (ns) headers["X-Vault-Namespace"] = ns;
  const res = await fetch(`${addr.replace(/\/$/, "")}/v1/${path.replace(/^\//, "")}`, { headers });
  if (!res.ok) throw new Error(`Vault refused the request [${res.status}]: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data?: { data?: Record<string, unknown> } & Record<string, unknown> };
  const value = body.data?.data?.[field] ?? body.data?.[field];
  if (typeof value !== "string" || !value) throw new Error(`Vault secret has no "${field}" field.`);
  return value;
}

export const Route = createFileRoute("/api/llm")({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        let body: { kind?: string; model?: string; apiKey?: string; vaultPath?: string; vaultField?: string; turns?: Turn[]; context?: string };
        try { body = await request.json(); } catch { return json({ error: "Invalid request" }, 400); }
        const kind = body.kind ?? "";
        const base = CLOUD[kind];
        const model = (body.model ?? "").trim();
        const turns = (Array.isArray(body.turns) ? body.turns : []).filter((t) => t && typeof t.text === "string").slice(-12);
        if (!base || !model || !turns.length) return json({ error: "Missing provider, model or message" }, 400);

        let key: string;
        try {
          key = body.vaultPath ? await keyFromVault(body.vaultPath, body.vaultField || "api_key") : (body.apiKey ?? "").trim();
        } catch (error) {
          return json({ error: error instanceof Error ? error.message : "Vault lookup failed" }, 502);
        }
        if (!key) return json({ error: "No API key provided for this provider" }, 400);

        const plan = planContextMessage(body.context);
        const system = [SYSTEM_PROMPT, JSON_INSTRUCTION, plan].filter(Boolean).join("\n\n");
        const messages = turns.map((t) => ({ role: t.role, content: t.text }));

        try {
          let res: Response;
          if (kind === "anthropic") {
            res = await fetch(`${base}/messages`, {
              method: "POST", signal: request.signal,
              headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
              body: JSON.stringify({ model, max_tokens: 1500, system, messages }),
            });
          } else {
            res = await fetch(`${base}/chat/completions`, {
              method: "POST", signal: request.signal,
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
              body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...messages] }),
            });
          }
          if (!res.ok) {
            const detail = (await res.text()).slice(0, 300);
            console.error(`Provider ${kind} failed [${res.status}]: ${detail}`);
            return json({ error: `${kind} returned ${res.status}: ${detail}` }, res.status);
          }
          const data = (await res.json()) as { content?: { type: string; text?: string }[]; choices?: { message?: { content?: string } }[] };
          const text = kind === "anthropic"
            ? (data.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("")
            : data.choices?.[0]?.message?.content ?? "";
          if (!text.trim()) return json({ error: "The provider returned an empty answer" }, 502);
          return json({ text });
        } catch (error) {
          if (request.signal.aborted) return new Response(null, { status: 499 });
          return json({ error: error instanceof Error ? error.message : "Provider request failed" }, 502);
        }
      },
    },
  },
});
