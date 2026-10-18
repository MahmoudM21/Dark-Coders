import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { AsrError, asrConfig, transcribeWithLocalProxy } from "./local-asr.server.ts";

type Mode = "ok" | "empty" | "error" | "slow" | "no-cors";

let server: Server;
let baseUrl = "";
let mode: Mode = "ok";
let lastRequest: { model?: string; language?: string } = {};

function readForm(req: IncomingMessage): Promise<FormData> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void new Response(Buffer.concat(chunks), {
        headers: { "content-type": req.headers["content-type"] ?? "" },
      })
        .formData()
        .then(resolve, reject);
    });
    req.on("error", reject);
  });
}

before(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "POST" || !url.pathname.endsWith("/audio/transcriptions")) {
        res.writeHead(404).end();
        return;
      }
      const form = await readForm(req);
      const model = form.get("model");
      const language = form.get("language");
      lastRequest = {
        ...(typeof model === "string" ? { model } : {}),
        ...(typeof language === "string" ? { language } : {}),
      };
      const cors =
        mode === "no-cors"
          ? {}
          : { "Access-Control-Allow-Origin": "http://localhost:8080", "Access-Control-Allow-Headers": "content-type" };
      if (mode === "slow") {
        setTimeout(() => res.writeHead(200, { "Content-Type": "application/json", ...cors }).end('{"text":"late"}'), 400);
        return;
      }
      if (mode === "error") {
        res.writeHead(503, { "Content-Type": "application/json", ...cors }).end('{"detail":"model is loading"}');
        return;
      }
      const text = mode === "empty" ? "" : "أهلاً";
      res.writeHead(200, { "Content-Type": "application/json", ...cors }).end(JSON.stringify({ text }));
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

beforeEach(() => {
  mode = "ok";
  lastRequest = {};
  process.env["ASR_BASE_URL"] = baseUrl;
  process.env["ASR_MODEL"] = "test-whisper";
  process.env["ASR_LANGUAGE"] = "ar";
  delete process.env["ASR_TIMEOUT_MS"];
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function audio() {
  return new File([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0])], "turn.wav", { type: "audio/wav" });
}

describe("transcribeWithLocalProxy", () => {
  it("returns the transcript from the configured model and language", async () => {
    const result = await transcribeWithLocalProxy(audio(), null);
    assert.equal(result.text, "أهلاً");
    assert.equal(lastRequest.model, "test-whisper");
    assert.equal(lastRequest.language, "ar");
  });

  it("lets the caller override the language", async () => {
    const result = await transcribeWithLocalProxy(audio(), "en");
    assert.equal(result.text, "أهلاً");
    assert.equal(lastRequest.language, "en");
  });

  it("returns an empty string for an empty transcript instead of throwing", async () => {
    mode = "empty";
    const result = await transcribeWithLocalProxy(audio(), null);
    assert.equal(result.text, "");
  });

  it("reports the real upstream status and body on HTTP errors", async () => {
    mode = "error";
    await assert.rejects(
      () => transcribeWithLocalProxy(audio(), null),
      (error: unknown) => {
        assert.ok(error instanceof AsrError);
        assert.equal(error.code, "ASR_HTTP_503");
        assert.match(error.detail ?? "", /model is loading/);
        return true;
      },
    );
  });

  it("turns a slow upstream into an ASR_TIMEOUT, not a hang", async () => {
    mode = "slow";
    process.env["ASR_TIMEOUT_MS"] = "50";
    await assert.rejects(
      () => transcribeWithLocalProxy(audio(), null),
      (error: unknown) => {
        assert.ok(error instanceof AsrError);
        assert.equal(error.code, "ASR_TIMEOUT");
        return true;
      },
    );
  });

  it("works even when the ASR response carries no CORS headers", async () => {
    // This is the browser failure mode the proxy exists to remove: the fake server sends
    // no Access-Control-Allow-Origin at all, and the server-side call still succeeds.
    mode = "no-cors";
    const result = await transcribeWithLocalProxy(audio(), null);
    assert.equal(result.text, "أهلاً");
  });
});

describe("asrConfig", () => {
  it("falls back to the documented defaults and rejects a nonsense timeout", () => {
    delete process.env["ASR_BASE_URL"];
    delete process.env["ASR_MODEL"];
    delete process.env["ASR_LANGUAGE"];
    delete process.env["ASR_TIMEOUT_MS"];
    assert.deepEqual(asrConfig(), {
      baseUrl: "http://localhost:8000/v1",
      model: "Systran/faster-whisper-small",
      language: "ar",
      timeoutMs: 300000,
    });
    process.env["ASR_TIMEOUT_MS"] = "not-a-number";
    assert.equal(asrConfig().timeoutMs, 300000);
  });
});
