import { GATEWAY_BASE_URL, MAX_AUDIO_BYTES, TRANSCRIBE_MODEL, getGatewayHeaders } from "./gateway.server";

export async function transcribe(file: File, signal?: AbortSignal) {
  if (!file.size || file.size > MAX_AUDIO_BYTES) throw new Error("Invalid audio file size");
  if (!file.type.startsWith("audio/")) throw new Error("Unexpected media MIME type");

  const form = new FormData();
  form.append("model", TRANSCRIBE_MODEL);
  form.append("file", file, file.name);
  form.append("response_format", "json");
  form.append("stream", "true");

  return fetch(`${GATEWAY_BASE_URL}/v1/audio/transcriptions`, {
    method: "POST",
    headers: getGatewayHeaders(),
    body: form,
    ...(signal ? { signal } : {}),
  });
}
