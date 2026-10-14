export function encodeWav(chunks: readonly Float32Array[], sampleRate: number): Blob {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new ArrayBuffer(44 + length * 2);
  const view = new DataView(bytes);
  const tag = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const chunk of chunks)
    for (const value of chunk) {
      const sample = Math.max(-1, Math.min(1, value));
      view.setInt16(offset, sample * (sample < 0 ? 32768 : 32767), true);
      offset += 2;
    }
  return new Blob([bytes], { type: "audio/wav" });
}

export type Recording = {
  stop: () => Promise<File>;
  cancel: () => void;
  level: () => number;
};

export async function recordWav(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    await context.resume();
    const audioContext = context;
    const source = audioContext.createMediaStreamSource(stream);
    const node = audioContext.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    let level = 0;
    node.onaudioprocess = (event) => {
      const data = new Float32Array(event.inputBuffer.getChannelData(0));
      chunks.push(data);
      let peak = 0;
      for (let i = 0; i < data.length; i += 16) peak = Math.max(peak, Math.abs(data[i] ?? 0));
      level = peak;
    };
    source.connect(node);
    node.connect(audioContext.destination);
    let stopped = false;
    const teardown = () => {
      stream.getTracks().forEach((track) => track.stop());
      node.disconnect();
      source.disconnect();
      node.onaudioprocess = null;
    };
    return {
      level: () => level,
      cancel() {
        if (stopped) return;
        stopped = true;
        teardown();
        void audioContext.close();
      },
      async stop() {
        if (stopped) throw new Error("Recording already stopped");
        stopped = true;
        teardown();
        const blob = encodeWav(chunks, audioContext.sampleRate);
        await audioContext.close();
        if (blob.size < 4096) throw new Error("That recording was too short — hold the button and speak.");
        return new File([blob], "recording.wav", { type: "audio/wav" });
      },
    };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context?.close();
    throw error;
  }
}
