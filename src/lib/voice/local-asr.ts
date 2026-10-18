import { readError } from './agent.ts';
export function transcriptionUrl(base: string) {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS transcription server without embedded credentials.');
  return `${url.href.replace(/\/$/, '')}/audio/transcriptions`;
}

/** A network-level fetch failure is not an HTTP error: report the service, the URL and the likely causes. */
function describeFetchFailure(service: string, url: string, error: unknown, extra: string) {
  return new Error(`${service} could not be reached at ${url} (${error instanceof Error ? error.message : String(error)}). ${extra}`, { cause: error });
}

export async function transcribeLocal(file: File, base: string, model: string, onPartial: (text: string) => void, signal: AbortSignal) {
  const form = new FormData(); form.append('file', file); form.append('model', model); form.append('response_format', 'json');
  const url = transcriptionUrl(base);
  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', body: form, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw describeFetchFailure('Local ASR', url, error, 'Check that the server is running and that it allows this origin (Access-Control-Allow-Origin); a first request can also be slow while the model loads.');
  }
  if (!response.ok) throw new Error(`Local ASR at ${url} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data: unknown = await response.json();
  const text = data && typeof data === 'object' && 'text' in data && typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) return '';
  onPartial(text); return text;
}

type ProxyError = { code?: unknown; message?: unknown; detail?: unknown };

export async function transcribeLocalViaApp(file: File, language: string, onPartial: (text: string) => void, signal: AbortSignal) {
  const form = new FormData();
  form.append("file", file, file.name || "recording.wav");
  if (language.trim()) form.append("language", language.trim());
  let response: Response;
  try {
    response = await fetch("/api/asr", { method: "POST", body: form, signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw describeFetchFailure(
      "Local via app ASR",
      "/api/asr",
      error,
      "The app server is probably not running (npm run dev). This mode does not depend on the ASR service's CORS headers.",
    );
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    let parsed: ProxyError = {};
    try { parsed = JSON.parse(body) as ProxyError; } catch { /* keep the raw body */ }
    const code = typeof parsed.code === "string" ? `${parsed.code}: ` : "";
    const message = typeof parsed.message === "string" ? parsed.message : body;
    const detail = typeof parsed.detail === "string" && parsed.detail ? ` (${parsed.detail})` : "";
    throw new Error(`Local via app ASR returned HTTP ${response.status} — ${code}${message}${detail}`);
  }
  const data = (await response.json()) as { text?: unknown };
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (text) onPartial(text);
  return text;
}
