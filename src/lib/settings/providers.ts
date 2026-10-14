export type ProviderKind = "builtin" | "openclaw" | "ollama" | "lmstudio" | "custom" | "openai" | "anthropic" | "gemini" | "openrouter";
export type KeySource = "none" | "browser" | "vault";

export type Provider = {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  keySource: KeySource;
  apiKey?: string;
  vaultPath?: string;
  vaultField?: string;
};

export type ProviderSettings = { providers: Provider[]; activeId: string; fallbackId: string | null };

export const KIND_INFO: Record<ProviderKind, { label: string; where: "built-in" | "local" | "cloud"; baseUrl: string; model: string }> = {
  builtin: { label: "OpenClaw Gateway (/api/agent)", where: "built-in", baseUrl: "", model: "openclaw/default" },
  openclaw: { label: "OpenClaw Gateway (Direct HTTP)", where: "local", baseUrl: "http://localhost:18789/v1", model: "openclaw/default" },
  ollama: { label: "Ollama", where: "local", baseUrl: "http://localhost:11434/v1", model: "llama3.2" },
  lmstudio: { label: "LM Studio", where: "local", baseUrl: "http://localhost:1234/v1", model: "local-model" },
  custom: { label: "Other OpenAI-compatible", where: "local", baseUrl: "http://localhost:8000/v1", model: "model-name" },
  openai: { label: "OpenAI", where: "cloud", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  anthropic: { label: "Anthropic", where: "cloud", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" },
  gemini: { label: "Google Gemini", where: "cloud", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.5-flash" },
  openrouter: { label: "OpenRouter", where: "cloud", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
};

export const BUILTIN: Provider = { id: "builtin", name: "OpenClaw Gateway (/api/agent)", kind: "builtin", baseUrl: "", model: "openclaw/default", keySource: "none" };

export const PROVIDERS_KEY = "openclaw.providers";
export const DEFAULT_PROVIDERS: ProviderSettings = { providers: [BUILTIN], activeId: "builtin", fallbackId: null };

export function findProvider(settings: ProviderSettings, id: string | null): Provider | undefined {
  if (!id) return undefined;
  return settings.providers.find((p) => p.id === id) ?? (id === "builtin" ? BUILTIN : undefined);
}

/** The V3 portfolio as ready-made providers: cloud ones run on the built-in service, local ones on this computer's Ollama. */
export const PORTFOLIO_PROVIDERS: Provider[] = [
  ...["gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gemini-3.1-pro"].map((model) => ({ id: `pf-${model}`, name: `Portfolio · ${model}`, kind: "builtin" as const, baseUrl: "", model, keySource: "none" as const })),
  ...["qwen3-coder:30b", "gpt-oss:120b"].map((model) => ({ id: `pf-${model}`, name: `Portfolio · ${model}`, kind: "ollama" as const, baseUrl: KIND_INFO.ollama.baseUrl, model, keySource: "none" as const })),
];

/** Adds any missing portfolio providers, keeping the user's own entries untouched. */
export function withPortfolio(s: ProviderSettings): ProviderSettings {
  const missing = PORTFOLIO_PROVIDERS.filter((p) => !s.providers.some((x) => x.model === p.model));
  return missing.length ? { ...s, providers: [...s.providers, ...missing] } : s;
}
