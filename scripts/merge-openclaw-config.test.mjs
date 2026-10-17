import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

const SCRIPT = fileURLToPath(new URL("./merge-openclaw-config.mjs", import.meta.url));
const isWindows = process.platform === "win32";

const TOKEN = "c8760f84754f3f5144d0d5dcfc597538f1bb93b9cdb21028";
const MENU = { profile: "full" };

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-merge-test-"));
  roots.push(root);
  return root;
}

/**
 * A config shaped like the live one: an existing `main` agent, a gateway token,
 * and JSON5-only syntax (trailing comma + unquoted key) so the parser is exercised.
 */
function writeConfig(dir, overrides = {}) {
  const config = {
    wizard: { accessMode: "full" },
    plugins: { entries: { nvidia: { enabled: true } } },
    agents: {
      entries: {
        main: {
          name: "main",
          workspace: "C:\\Users\\tester\\.openclaw\\workspace",
          agentDir: "C:\\Users\\tester\\.openclaw\\agents\\main\\agent",
          identity: { name: "main" },
        },
      },
      defaults: { model: { primary: "nvidia/nvidia/nemotron-3-super-120b-a12b" } },
    },
    gateway: { mode: "local", port: 18789, auth: { mode: "token", token: TOKEN } },
    tools: MENU,
  };
  const merged = { ...config, ...overrides };
  const file = path.join(dir, "openclaw.json");
  // Hand-built so the file really is JSON5, exactly like the live config.
  const text = JSON5.stringify(merged, null, 2)
    .replace('"mode": "token"', '"mode": "token",')
    .replace('"endpoints"', "endpoints");
  writeFileSync(file, text, "utf8");
  return file;
}

function run(args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function openclawAvailable() {
  const probe = spawnSync(isWindows ? "openclaw --version" : "openclaw", isWindows ? [] : ["--version"], {
    encoding: "utf8",
    shell: isWindows,
  });
  return probe.status === 0;
}

function readJson5(file) {
  return JSON5.parse(readFileSync(file, "utf8"));
}

describe("merge-openclaw-config", () => {
  it("dry run shows the additions, redacts the token, and writes nothing", () => {
    const dir = workspace();
    const configPath = writeConfig(dir);
    const before = readFileSync(configPath, "utf8");

    const { code, stdout } = run(["--dry-run", "--config", configPath, "--no-validate", "--no-sync-workspace"]);

    assert.equal(code, 0, stdout);
    assert.match(stdout, /\+ agents\.entries\["clinic-receptionist"\]\.workspace/);
    assert.match(stdout, /\+ agents\.ownership = "explicit"/);
    assert.match(stdout, /\+ mcp\.servers\.clinic\.transport = "stdio"/);
    assert.match(stdout, /Dry run: no files were written/);

    // The whole point of redaction: the value must not appear anywhere.
    assert.ok(!stdout.includes(TOKEN), "the token leaked into stdout");
    assert.match(stdout, /gateway\.auth\.token = \*\*\*redacted\*\*\*/);

    assert.equal(readFileSync(configPath, "utf8"), before, "a dry run must not touch the config");
    assert.equal(
      readdirSync(dir).filter((name) => name.includes(".bak")).length,
      0,
      "a dry run must not write a backup",
    );
  });

  it("writes, backs up the original, and leaves main, plugins and the token untouched", () => {
    const dir = workspace();
    const configPath = writeConfig(dir);
    const original = readJson5(configPath);

    const { code, stdout } = run(["--config", configPath, "--no-validate", "--no-sync-workspace", "--workspace", path.join(dir, "ws")]);
    assert.equal(code, 0, stdout);

    const backups = readdirSync(dir).filter((name) => name.includes(".bak-clinic-"));
    assert.equal(backups.length, 1, "exactly one timestamped backup");
    assert.equal(readFileSync(path.join(dir, backups[0]), "utf8"), JSON5.stringify(original, null, 2) + (readFileSync(path.join(dir, backups[0]), "utf8").endsWith("\n") ? "\n" : ""));

    const after = readJson5(configPath);
    assert.deepEqual(after.agents.entries.main, original.agents.entries.main);
    assert.deepEqual(after.plugins, original.plugins);
    assert.deepEqual(after.tools, original.tools);
    assert.equal(after.gateway.auth.token, TOKEN);
    assert.equal(after.agents.ownership, "explicit");
    assert.deepEqual(Object.keys(after.agents.entries).sort(), ["clinic-receptionist", "main"]);
    assert.equal(after.gateway.http.endpoints.chatCompletions.enabled, true);

    const clinic = after.agents.entries["clinic-receptionist"];
    assert.deepEqual(clinic.model, {
      primary: "nvidia/nvidia/nemotron-3-super-120b-a12b",
      fallbacks: ["google/gemini-3.8-flash"],
    });
    assert.equal(clinic.thinkingDefault, "off");
    assert.equal(clinic.models["nvidia/nvidia/nemotron-3-super-120b-a12b"].params.thinking, "off");
    assert.equal(
      clinic.models["nvidia/nvidia/nemotron-3-super-120b-a12b"].params.chat_template_kwargs.enable_thinking,
      false,
    );

    // MCP tools are `server__tool`; nothing from the core tool set may survive.
    assert.ok(clinic.tools.allow.every((name) => name.startsWith("clinic__")), "allow list must be MCP-only");
    assert.ok(!clinic.tools.deny.includes("group:plugins"), "denying group:plugins would deny the clinic tools too");
    assert.ok(!clinic.tools.allow.includes("exec") && !clinic.tools.allow.includes("read"));

    // ${VAR} references, never values.
    assert.equal(after.mcp.servers.clinic.env.CLINIC_TOOLS_TOKEN, "${CLINIC_TOOLS_TOKEN}");
    assert.equal(after.mcp.servers.clinic.env.CLINIC_API_URL, "${CLINIC_API_URL}");
    assert.ok(after.mcp.servers.clinic.args[0].endsWith("openclaw/mcp/clinic/server.mjs"));
    assert.ok(!stdout.includes(TOKEN), "the token leaked into stdout");
  });

  it("is idempotent: a second run reports no change", () => {
    const dir = workspace();
    const configPath = writeConfig(dir);
    run(["--config", configPath, "--no-validate", "--no-sync-workspace", "--workspace", path.join(dir, "ws")]);
    const once = readFileSync(configPath, "utf8");

    const second = run(["--config", configPath, "--no-validate", "--no-sync-workspace", "--config", configPath]);
    assert.equal(second.code, 0, second.stdout);
    assert.match(second.stdout, /no change -- the config already matches the fragment/);
    assert.equal(readFileSync(configPath, "utf8"), once);
  });

  it("keeps values the fragment does not own, and says so", () => {
    const dir = workspace();
    const configPath = writeConfig(dir);
    const fragment = path.join(dir, "conflict.json5");
    writeFileSync(
      fragment,
      `{
        gateway: { auth: { mode: "password" } },
        tools: { profile: "minimal" },
        agents: { entries: { "clinic-receptionist": { thinkingDefault: "high" } } },
      }`,
      "utf8",
    );

    const { code, stdout } = run([
      "--dry-run", "--config", configPath, "--fragment", fragment, "--no-validate", "--no-sync-workspace",
    ]);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /! gateway\.auth\.mode: kept "token", fragment asked for "password"/);
    assert.match(stdout, /! tools\.profile: kept "full", fragment asked for "minimal"/);
    // ...while a path the fragment owns is updated.
    assert.match(stdout, /~ agents\.entries\["clinic-receptionist"\]\.thinkingDefault: "off" -> "high"/);
  });

  it("enables chatCompletions when it is missing and leaves an explicit false alone", () => {
    const dir = workspace();
    const missing = writeConfig(dir);
    const added = run(["--dry-run", "--config", missing, "--no-validate", "--no-sync-workspace"]);
    assert.match(added.stdout, /chatCompletions\.enabled: added \(was missing\)/);

    const other = workspace();
    const disabled = writeConfig(other, {
      gateway: {
        mode: "local",
        port: 18789,
        auth: { mode: "token", token: TOKEN },
        http: { endpoints: { chatCompletions: { enabled: false } } },
      },
    });
    const kept = run(["--dry-run", "--config", disabled, "--no-validate", "--no-sync-workspace"]);
    assert.match(kept.stdout, /WARNING: present and false/);
  });

  it("refuses to touch a config it cannot parse", () => {
    const dir = workspace();
    const configPath = path.join(dir, "openclaw.json");
    writeFileSync(configPath, "{ this is not json5", "utf8");
    const before = readFileSync(configPath, "utf8");

    const { code, stdout, stderr } = run(["--config", configPath, "--no-validate", "--no-sync-workspace"]);
    assert.equal(code, 1);
    assert.match(stderr + stdout, /could not parse/);
    assert.equal(readFileSync(configPath, "utf8"), before);
  });

  // Needs the real CLI: this is the check that a bad merge never reaches disk.
  it(
    "refuses to write a merge the installed OpenClaw schema rejects",
    { skip: openclawAvailable() ? false : "openclaw is not on PATH" },
    () => {
      const dir = workspace();
      const configPath = writeConfig(dir);
      const before = readFileSync(configPath, "utf8");
      const fragment = path.join(dir, "invalid.json5");
      writeFileSync(
        fragment,
        `{ agents: { entries: { "clinic-receptionist": { tools: { allowance: ["nope"] } } } } }`,
        "utf8",
      );

      const { code, stdout } = run(["--config", configPath, "--fragment", fragment, "--no-sync-workspace"]);
      assert.equal(code, 1, stdout);
      assert.match(stdout, /Schema check: FAIL/);
      assert.match(stdout, /Unrecognized key: "allowance"/);
      assert.match(stdout, /Refusing to write/);
      assert.equal(readFileSync(configPath, "utf8"), before);
      assert.equal(
        readdirSync(dir).filter((name) => name.includes(".bak")).length,
        0,
        "a refused merge must not leave a backup behind",
      );
    },
  );

  it(
    "accepts the real fragment against the installed schema",
    { skip: openclawAvailable() ? false : "openclaw is not on PATH" },
    () => {
      const dir = workspace();
      const configPath = writeConfig(dir);
      const { code, stdout } = run(["--dry-run", "--config", configPath, "--no-sync-workspace"]);
      assert.equal(code, 0, stdout);
      assert.match(stdout, /Schema check: PASS/);
    },
  );
});
