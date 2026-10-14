import { GATEWAY_BASE_URL, SPEECH_MODEL, SPEECH_VOICE, getGatewayHeaders } from "./gateway.server";

export async function requestSpeech(text: string, signal?: AbortSignal) {
  return fetch(`${GATEWAY_BASE_URL}/v1/audio/speech`, {
    method: "POST",
    headers: getGatewayHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      model: SPEECH_MODEL,
      contents: [{ role: "user", parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: SPEECH_VOICE } } },
      },
      stream_format: "sse",
    }),
    ...(signal ? { signal } : {}),
  });
}
