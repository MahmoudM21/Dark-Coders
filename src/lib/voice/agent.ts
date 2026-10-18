import { createParser } from "eventsource-parser";

export type Turn = { role: "user" | "assistant"; text: string };
const SESSION_KEY = "clinic.session_id";
let previousTurnCount = 0;

function currentSessionId() {
  if (typeof window === "undefined") return "";
  const existing = sessionStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const created = crypto.randomUUID();
  sessionStorage.setItem(SESSION_KEY, created);
  return created;
}

function refreshSessionId() {
  if (typeof window === "undefined") return "";
  const created = crypto.randomUUID();
  sessionStorage.setItem(SESSION_KEY, created);
  return created;
}

function resolveSessionId(turns: Turn[]) {
  const looksLikeNewConversation = previousTurnCount > 0 && turns.length === 1 && turns[0]?.role === "user";
  const id = looksLikeNewConversation ? refreshSessionId() : currentSessionId();
  previousTurnCount = turns.length;
  return id;
}

export async function readSse(response: Response, onEvent: (data: string) => void) {
  if (!response.body) throw new Error("Empty response stream");
  const parser = createParser({ onEvent: (event) => onEvent(event.data) });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      parser.feed(next.value);
    }
    parser.reset({ consume: true });
  } finally {
    reader.releaseLock();
  }
}

export async function readError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    /* ignore */
  }
  return fallback;
}

/** Uploads the recording and streams the transcript back. */
export async function transcribeRecording(
  file: File,
  onPartial: (text: string) => void,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  form.append("file", file, file.name);
  const response = await fetch("/api/transcribe", { method: "POST", body: form, ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(await readError(response, "Could not understand that recording"));

  let text = "";
  await readSse(response, (data) => {
    const payload = JSON.parse(data) as { type?: string; delta?: string; text?: string; error?: unknown };
    if (payload.error) throw new Error("Transcription failed");
    if (payload.type === "transcript.text.delta" && payload.delta) {
      text += payload.delta;
      onPartial(text);
    }
    if (payload.type === "transcript.text.done" && typeof payload.text === "string") {
      text = payload.text;
      onPartial(text);
    }
  });
  const final = text.trim();
  if (!final) throw new Error("I didn't hear any speech in that recording");
  return final;
}

/** Streams the agent answer, reporting reasoning summary text and answer deltas separately. */
export type TurnTiming = Record<string, number | boolean | null>;

export async function streamAgentAnswer(
  turns: Turn[],
  handlers: { onThinking: (text: string) => void; onAnswer: (text: string) => void; onTiming?: (timing: TurnTiming) => void },
  signal?: AbortSignal,
  context?: string,
  model?: string,
): Promise<string> {
  const session_id = resolveSessionId(turns);
  let response: Response;
  try {
    response = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ turns, context, model, session_id }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(
      `The agent bridge at /api/agent could not be reached (${error instanceof Error ? error.message : String(error)}).` +
        " The app server is probably not running, or the request never left the browser — check `npm run dev` and the Network tab.",
      { cause: error },
    );
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new Error(`The agent bridge returned HTTP ${response.status}: ${body || "(empty response)"}`);
  }

  let answer = "";
  let thinking = "";
  await readSse(response, (data) => {
    const payload = JSON.parse(data) as { type?: string; delta?: string; text?: string; error?: unknown; timing?: TurnTiming };
    if (payload.error || payload.type === "error") throw new Error("The agent stream failed");
    if (payload.type === "bridge.timing" && payload.timing) handlers.onTiming?.(payload.timing);
    if (payload.type === "response.reasoning_summary_text.delta" && payload.delta) {
      thinking += payload.delta;
      handlers.onThinking(thinking);
    }
    if (payload.type === "response.output_text.delta" && payload.delta) {
      answer += payload.delta;
      handlers.onAnswer(answer);
    }
    if (payload.type === "response.output_text.done" && typeof payload.text === "string") {
      answer = payload.text;
      handlers.onAnswer(answer);
    }
  });
  const final = answer.trim();
  if (!final) throw new Error("The agent returned an empty answer");
  return final;
}
