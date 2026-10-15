#!/usr/bin/env node
// Smoke-test the clinic MCP proxy without an OpenClaw gateway or a database.
//
//   npm run clinic:mcp-smoke
//
// Phase 1 spawns openclaw/mcp/clinic/server.mjs over stdio, performs the MCP
// handshake and asserts the tool set. This catches proxy-level breakage (bad
// imports, MCP SDK API drift, a tool that fails to register) which a syntax
// check cannot.
// Phase 2 points the proxy at a local echo server and calls a tool, so it also
// proves the bearer token is sent and the forwarded body is {tool, args}.
//
// It does NOT reach the Booking Service, so it does not prove the tools work
// end to end — use docs/TESTING.md for that.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const proxyDir = join(repoRoot, "openclaw", "mcp", "clinic");
const TOKEN = "mcp-smoke-token";

const EXPECTED_TOOLS = [
  "get_clinic_info",
  "select_branch",
  "find_doctor",
  "identify_patient",
  "check_availability",
  "hold_slot",
  "request_approval",
  "confirm_booking",
  "reschedule_appointment",
  "cancel_appointment",
  "list_my_appointments",
  "add_note",
  "escalate_to_human",
].sort();

const failures = [];

function check(condition, message) {
  if (condition) {
    console.log(`  PASS  ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

function startEchoServer() {
  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ url: req.url, method: req.method, authorization: req.headers["authorization"], body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, data: { clinic_name: "echo" }, meta: { request_id: "echo", latency_ms: 0 } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, received, port: server.address().port }));
  });
}

function startProxy(apiUrl) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: proxyDir,
    env: { ...process.env, CLINIC_API_URL: apiUrl, CLINIC_TOOLS_TOKEN: TOKEN },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = [];
  let buffer = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        replies.push(JSON.parse(line));
      } catch {
        // ignore partial output
      }
    }
  });
  child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
  const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
  const waitFor = async (id, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = replies.find((message) => message.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
  };
  return { child, send, waitFor, getStderr: () => stderr };
}

async function main() {
  const echo = await startEchoServer();
  const proxy = startProxy(`http://127.0.0.1:${echo.port}`);

  try {
    proxy.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "clinic-mcp-smoke", version: "1" } },
    });
    proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    proxy.send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

    const init = await proxy.waitFor(1);
    console.log("Phase 1: MCP handshake and tool registration");
    check(Boolean(init), "the proxy answers initialize");
    const list = await proxy.waitFor(2);
    if (!list) {
      console.log(`  FAIL  the proxy never answered tools/list`);
      failures.push("tools/list");
      if (proxy.getStderr().trim()) console.error(`\nproxy stderr:\n${proxy.getStderr().trim()}`);
    } else {
      const names = (list.result?.tools ?? []).map((tool) => tool.name).sort();
      check(
        names.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((n) => names.includes(n)),
        `${EXPECTED_TOOLS.length} tools registered (got ${names.length}: ${names.join(", ")})`,
      );
      check(names.includes("select_branch"), "select_branch is present");
      check(names.includes("find_doctor"), "find_doctor is present");
    }

    console.log("\nPhase 2: tool forwarding");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    proxy.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "find_doctor", arguments: { session_id: sessionId, query: "يوسف" } },
    });
    const call = await proxy.waitFor(3);
    check(Boolean(call), "the proxy answers tools/call");
    check(Boolean(call?.result?.content?.[0]?.text), "the tool result carries text content");

    const forwarded = echo.received.at(-1);
    check(Boolean(forwarded), "the proxy forwarded a request to the Booking Service");
    if (forwarded) {
      check(forwarded.url === "/api/clinic/tools", `it posted to /api/clinic/tools (got ${forwarded.url})`);
      check(forwarded.method === "POST", "it used POST");
      check(forwarded.authorization === `Bearer ${TOKEN}`, `it sent the bearer token (got ${forwarded.authorization ?? "none"})`);
      let body;
      try {
        body = JSON.parse(forwarded.body);
      } catch {
        body = undefined;
      }
      check(body?.tool === "find_doctor", "the body names the tool");
      check(body?.args?.session_id === sessionId && body?.args?.query === "يوسف", "the body forwards the args verbatim");
    }
  } finally {
    proxy.child.kill();
    echo.server.close();
  }

  console.log("");
  if (failures.length) {
    console.error(`FAILED: ${failures.length} check(s): ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("PASS: the MCP proxy registers 13 tools and forwards calls with the bearer token.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
