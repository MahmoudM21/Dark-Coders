import { MAX_AUDIO_BYTES } from "./gateway.server.ts";

const DEFAULT_ASR_BASE_URL = "http://localhost:8000/v1";
const DEFAULT_ASR_MODEL = "Systran/faster-whisper-small";
const DEFAULT_ASR_LANGUAGE = "ar";
/** The first call loads the whisper model on a CPU container, which can take minutes. */
const DEFAULT_ASR_TIMEOUT_MS = 300000;

/** A transcription failure that the route can turn into a structured {code, message, detail}. */
export class AsrError extends Error {
  readonly code: string;
  readonly detail: string | undefined;

  constructor(code: string, message: string, detail?: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AsrError";
    this.code = code;
    this.detail = detail;
  }
}

export function asrConfig() {
  const rawTimeout = Number(process.env["ASR_TIMEOUT_MS"]);
  return {
    baseUrl: (process.env["ASR_BASE_URL"] || DEFAULT_ASR_BASE_URL).replace(/\/$/, ""),
    model: process.env["ASR_MODEL"] || DEFAULT_ASR_MODEL,
    language: process.env["ASR_LANGUAGE"] || DEFAULT_ASR_LANGUAGE,
    timeoutMs: Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : DEFAULT_ASR_TIMEOUT_MS,
  };
}

/**
 * Forwards one recording to the local Whisper-compatible service from the server, so the
 * browser never has to satisfy that service's CORS policy. Returns {text}; an empty
 * transcript is a successful result, not an error — the console decides what to say.
 */
export async function transcribeWithLocalProxy(file: File, language: string | null, signal?: AbortSignal) {
  if (!file.size) throw new AsrError("NO_AUDIO", "The recording was empty.");
  if (file.size > MAX_AUDIO_BYTES) {
    throw new AsrError("AUDIO_TOO_LARGE", `The recording is larger than the ${MAX_AUDIO_BYTES} byte limit.`);
  }
  if (file.type && !file.type.startsWith("audio/")) {
    throw new AsrError("UNSUPPORTED_MEDIA_TYPE", `Expected an audio upload, received ${file.type}.`);
  }

  const config = asrConfig();
  const languageToSend = language?.trim() || config.language;
  const form = new FormData();
  form.append("file", file, file.name || "recording.wav");
  form.append("model", config.model);
  form.append("response_format", "json");
  if (languageToSend) form.append("language", languageToSend);

  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/audio/transcriptions`, { method: "POST", body: form, signal: combined });
  } catch (error) {
    if (signal?.aborted) throw error;
    if (timeout.aborted) {
      throw new AsrError(
        "ASR_TIMEOUT",
        `ASR at ${config.baseUrl} did not answer within ${config.timeoutMs} ms (ASR_TIMEOUT_MS).`,
        "A cold container loads the model on the first request. Retry, or run `npm run clinic:warmup` once.",
        error,
      );
    }
    throw new AsrError(
      "ASR_UNREACHABLE",
      `ASR at ${config.baseUrl} refused the connection.`,
      "Is the container running? Check: curl -s -o /dev/null -w '%{http_code}' " + config.baseUrl + "/models",
      error,
    );
  }

  const detail = (await response.text()).slice(0, 300);
  if (!response.ok) {
    throw new AsrError(`ASR_HTTP_${response.status}`, `ASR returned HTTP ${response.status}.`, detail);
  }

  let data: unknown;
  try {
    data = JSON.parse(detail);
  } catch {
    throw new AsrError("ASR_BAD_JSON", "ASR answered with something that is not JSON.", detail);
  }
  const text =
    data && typeof data === "object" && "text" in data && typeof (data as { text: unknown }).text === "string"
      ? (data as { text: string }).text.trim()
      : "";
  return { text };
}
