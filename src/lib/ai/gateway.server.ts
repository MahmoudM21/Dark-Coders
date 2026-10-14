export const GATEWAY_BASE_URL = (
  process.env["OPENCLAW_GATEWAY_URL"] ||
  process.env["LOVABLE_GATEWAY_URL"] ||
  "http://localhost:18789"
).replace(/\/$/, "");

export const CHAT_MODEL = process.env["OPENCLAW_DEFAULT_MODEL"] || "openclaw/default";
export const TRANSCRIBE_MODEL = process.env["OPENCLAW_TRANSCRIBE_MODEL"] || "whisper-1";
export const SPEECH_MODEL = process.env["OPENCLAW_SPEECH_MODEL"] || "tts-1";
export const SPEECH_VOICE = process.env["OPENCLAW_SPEECH_VOICE"] || "alloy";

/** Maximum audio upload size (13 MB). */
export const MAX_AUDIO_BYTES = 13 * 1024 * 1024;

export function getApiKey(): string {
  return process.env["OPENCLAW_API_KEY"] || process.env["LOVABLE_API_KEY"] || "";
}

export function getGatewayHeaders(extra?: Record<string, string>): Record<string, string> {
  const key = getApiKey();
  return {
    ...(key ? { Authorization: `Bearer ${key}`, "Lovable-API-Key": key } : {}),
    ...extra,
  };
}
