#!/usr/bin/env node
// Local escalation receiver for manual testing.
//
// Point the server at it:  ESCALATION_WEBHOOK_URL=http://localhost:3333/escalation
// Then run:                node scripts/webhook-echo.mjs
//
// It prints every escalation the Booking Service posts and answers 200, which is
// what makes escalate_to_human report delivery_status "notified". It stores
// nothing and sends nothing; it is a development aid only.

import { createServer } from "node:http";

const port = Number.parseInt(process.env.PORT ?? "", 10) || 3333;
const host = process.env.HOST || "127.0.0.1";

function printEscalation(payload, receivedAt) {
  const line = "-".repeat(60);
  console.log(line);
  console.log(`escalation received at ${receivedAt}`);
  console.log(line);
  console.log(`  id            ${payload.escalation_id ?? "(missing)"}`);
  console.log(`  severity      ${payload.severity ?? "(missing)"}`);
  console.log(`  within_hours  ${payload.within_hours ?? "(missing)"}`);
  console.log(`  branch        ${payload.branch ?? "-"}`);
  console.log(`  caller_name   ${payload.caller_name ?? "-"}`);
  console.log(`  caller_phone  ${payload.caller_phone ?? "-"}`);
  console.log(`  reason        ${payload.reason ?? "(missing)"}`);
  const summary = typeof payload.summary === "string" ? payload.summary : JSON.stringify(payload.summary ?? null);
  console.log(`  summary       ${summary}`);
  if (payload.severity === "emergency") {
    console.log("  >> EMERGENCY: a real deployment would page the duty manager here.");
  }
  console.log("");
}

const server = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on("end", () => {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("escalation echo is listening; POST an escalation payload here\n");
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("only GET and POST are supported\n");
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      console.log(`rejected a non-JSON body (${body.length} bytes)`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "body must be JSON" }));
      return;
    }
    const receivedAt = new Date().toISOString();
    printEscalation(payload, receivedAt);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, received_at: receivedAt }));
  });
});

server.listen(port, host, () => {
  console.log(`escalation echo listening on http://${host}:${port}`);
  console.log(`set ESCALATION_WEBHOOK_URL=http://${host}:${port}/escalation and restart the dev server`);
});
