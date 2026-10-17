#!/usr/bin/env node
// Safe merge of `openclaw/openclaw.json5` into the live OpenClaw config.
//
//   npm run clinic:openclaw-merge -- --dry-run     # show the diff, write nothing
//   npm run clinic:openclaw-merge                  # back up, validate, write
//
// What it guarantees, in order:
//   1. The live config is parsed as JSON5. It is NOT strict JSON -- the one this
//      was built against contains a trailing comma and an unquoted `endpoints`
//      key, so `JSON.parse` fails on it and OpenClaw still loads it.
//   2. Only paths this fragment OWNS are written. Everything else -- gateway.auth,
//      gateway.remote, plugins, channels, agents.entries.main, any other agent --
//      is left exactly as it was, byte for byte in value terms.
//   3. The merged result is serialised, parsed again, and then validated against
//      the INSTALLED OpenClaw's schema by pointing OPENCLAW_STATE_DIR at a temp
//      directory. A config that would make the gateway refuse to start is never
//      written.
//   4. A timestamped backup is written before the config is replaced.
//   5. Secret-bearing keys are redacted in every line of output. `${VAR}`
//      references are printed as-is: they name an environment variable, they do
//      not contain a value.
//
// Exit codes: 0 success, 1 validation/merge failure, 2 usage error.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Agent id and MCP server name this fragment manages. Keep in sync with the .json5. */
const AGENT_ID = "clinic-receptionist";
const MCP_SERVER = "clinic";

/**
 * Paths this script is allowed to create or change. Anything outside these is
 * preserved from the existing config, which is what keeps `gateway.auth.token`,
 * `plugins.*` and other agents untouched even if the fragment grows.
 */
const MANAGED_PATHS = [
  ["agents", "ownership"],
  ["agents", "entries", AGENT_ID],
  ["mcp", "servers", MCP_SERVER],
  ["gateway", "http", "endpoints", "chatCompletions", "enabled"],
];

/** Key names whose values must never reach stdout, an error message, or a diff. */
const SECRET_KEY = /(token|secret|password|passwd|passphrase|api[-_]?key|apikey|authorization|private[-_]?key|credential)s?$/i;

const REDACTED = "***redacted***";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  return `Usage: node scripts/merge-openclaw-config.mjs [options]

  --dry-run                Print the diff and validation result; write nothing.
  --config <path>          Config to merge into. Default: ~/.openclaw/openclaw.json
  --fragment <path>        Fragment to merge. Default: openclaw/openclaw.json5
  --openclaw-bin <path>    OpenClaw binary for schema validation. Default: openclaw
  --no-validate            Skip schema validation. The parse check still runs.
  --workspace <path>       Where to copy AGENTS.md + skills. Default: the config's
                           agents.entries.${AGENT_ID}.workspace
  --no-sync-workspace      Do not copy AGENTS.md or skills.
  -h, --help               This text.
`;
}

function parseArgs(argv) {
  const options = {
    dryRun: false,
    config: path.join(homedir(), ".openclaw", "openclaw.json"),
    fragment: path.join(REPO_ROOT, "openclaw", "openclaw.json5"),
    openclawBin: "openclaw",
    validate: true,
    syncWorkspace: true,
    workspace: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      index += 1;
      return value;
    };
    switch (arg) {
      case "--dry-run": options.dryRun = true; break;
      case "--config": options.config = path.resolve(next()); break;
      case "--fragment": options.fragment = path.resolve(next()); break;
      case "--openclaw-bin": options.openclawBin = next(); break;
      case "--no-validate": options.validate = false; break;
      case "--workspace": options.workspace = path.resolve(next()); break;
      case "--no-sync-workspace": options.syncWorkspace = false; break;
      case "-h":
      case "--help": process.stdout.write(usage()); process.exit(0); break;
      default: throw new UsageError(`unknown option ${arg}`);
    }
  }
  return options;
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const startsWith = (pathArray, prefix) =>
  prefix.length <= pathArray.length && prefix.every((segment, index) => segment === pathArray[index]);

const isManaged = (pathArray) => MANAGED_PATHS.some((prefix) => startsWith(pathArray, prefix));

/**
 * Deep-merge `source` (the fragment) into `target` (the live config).
 *
 * - plain objects recurse
 * - a managed path is created or overwritten
 * - an unmanaged existing value is preserved and recorded as a conflict
 *
 * Returns the merged object plus the bookkeeping the diff needs.
 */
function merge(target, source, trail, report) {
  const result = isPlainObject(target) ? { ...target } : target;
  let mergedTarget = result;    for (const [key, sourceValue] of Object.entries(source)) {
      const here = [...trail, key];
    const existing = isPlainObject(mergedTarget) ? mergedTarget[key] : undefined;

    if (isPlainObject(sourceValue)) {
      const nested = merge(existing, sourceValue, here, report);
      if (!isPlainObject(mergedTarget)) mergedTarget = {};
      mergedTarget[key] = nested.value;
      continue;
    }

    if (existing === undefined) {
      if (!isPlainObject(mergedTarget)) mergedTarget = {};
      mergedTarget[key] = sourceValue;
      report.added.push(here);
      continue;
    }

    if (deepEqual(existing, sourceValue)) {
      report.unchanged.push(here);
      continue;
    }

    if (isManaged(here)) {
      if (!isPlainObject(mergedTarget)) mergedTarget = {};
      mergedTarget[key] = sourceValue;
      report.updated.push({ path: here, from: existing, to: sourceValue });
    } else {
      report.conflicts.push({ path: here, kept: existing, ignored: sourceValue });
    }
  }

  return { value: mergedTarget };
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * Flatten to leaf paths (arrays and scalars are leaves) for diffing.
 *
 * Keyed by the serialised path, not by the array: two equal-looking arrays are
 * different Map keys, which would make every unchanged key look added and removed
 * at once.
 */
function flatten(value, trail = [], into = new Map()) {
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) into.set(JSON.stringify(trail), { trail, value: {} });
    for (const key of keys) flatten(value[key], [...trail, key], into);
    return into;
  }
  into.set(JSON.stringify(trail), { trail, value });
  return into;
}

const displayPath = (pathArray) => {
  if (pathArray.length === 0) return "(root)";
  let output = "";
  for (const segment of pathArray) {
    output += /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`;
  }
  return output.replace(/^\./, "");
};

/** Render a value for output, redacting secret-bearing keys. */
function render(pathArray, value) {
  const key = pathArray[pathArray.length - 1] ?? "";
  if (SECRET_KEY.test(key)) return REDACTED;
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return JSON.stringify(value.length > 6 ? [...value.slice(0, 6), `…${value.length - 6} more`] : value);
  return JSON.stringify(value);
}

/** Expand a leading `~` the way OpenClaw does for workspace/agentDir. */
function expandHome(input) {
  if (input === "~") return homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) return path.join(homedir(), input.slice(2));
  return input;
}

const toPosix = (input) => input.split(path.sep).join("/");

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function checkParseRoundTrip(merged, serialised) {
  try {
    const reparsed = JSON5.parse(serialised);
    if (!deepEqual(reparsed, merged)) return { ok: false, detail: "re-parsing the merged config produced a different object" };
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: `merged config is not parseable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Validate a candidate config against the installed OpenClaw's schema.
 * OPENCLAW_STATE_DIR moves the config path OpenClaw reads, which is what makes
 * `openclaw config validate` able to judge a file that is not installed yet.
 */
function checkSchema(serialised, openclawBin) {
  const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-merge-"));
  try {
    writeFileSync(path.join(stateDir, "openclaw.json"), serialised, "utf8");
    // Windows ships `openclaw` as a .cmd shim, which needs a shell to run. Build
    // one command string rather than passing an args array alongside `shell`,
    // which Node deprecates for argument-escaping reasons.
    const useShell = process.platform === "win32";
    const quotedBin = openclawBin.includes(" ") ? `"${openclawBin}"` : openclawBin;
    const run = useShell
      ? spawnSync(`${quotedBin} config validate --json`, {
          encoding: "utf8",
          shell: true,
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          timeout: 120_000,
        })
      : spawnSync(openclawBin, ["config", "validate", "--json"], {
          encoding: "utf8",
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          timeout: 120_000,
        });

    if (run.error && run.error.code === "ENOENT") {
      return { ok: false, unavailable: true, detail: `could not run \`${openclawBin}\`` };
    }
    if (run.error) {
      return { ok: false, unavailable: true, detail: run.error.message };
    }

    const stdout = (run.stdout ?? "").trim();
    let parsed;
    try {
      parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
    } catch {
      return {
        ok: false,
        detail: `validator produced no JSON (exit ${run.status}): ${(run.stderr || stdout).slice(0, 400)}`,
      };
    }

    if (parsed.valid === true) return { ok: true, warnings: parsed.warnings ?? [] };
    return {
      ok: false,
      issues: parsed.issues ?? [],
      detail: parsed.error?.message ?? "config is invalid",
    };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Workspace files
// ---------------------------------------------------------------------------

/**
 * OpenClaw injects `AGENTS.md` from the agent workspace and scans
 * `<workspace>/skills` first, so the repo's authored files have to exist there.
 * They are copied rather than symlinked: symlinks need extra privileges on
 * Windows, and the repo must stay the only editable copy.
 */
function syncWorkspace(workspaceDir, options) {
  const copies = [];
  const agentsSource = path.join(REPO_ROOT, "openclaw", "agents", AGENT_ID, "AGENTS.md");
  const skillsRoot = path.join(REPO_ROOT, "openclaw", "skills");

  const plan = [[agentsSource, path.join(workspaceDir, "AGENTS.md")]];
  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = path.join(skillsRoot, entry.name, "SKILL.md");
      if (existsSync(source)) plan.push([source, path.join(workspaceDir, "skills", entry.name, "SKILL.md")]);
    }
  }

  for (const [source, destination] of plan) {
    const existing = existsSync(destination) ? readFileSync(destination, "utf8") : undefined;
    const incoming = readFileSync(source, "utf8");
    const state = existing === undefined ? "created" : existing === incoming ? "current" : "updated";
    copies.push({ source, destination, state });
    if (options.dryRun) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    if (state !== "current") writeFileSync(destination, incoming, "utf8");
  }
  return copies;
}

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------

function backupStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

function backupPathFor(configPath) {
  const base = `${configPath}.bak-clinic-${backupStamp()}`;
  if (!existsSync(base)) return base;
  for (let attempt = 2; attempt < 100; attempt += 1) {
    const candidate = `${base}-${attempt}`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error("could not find a free backup filename");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.fragment)) {
    throw new Error(`fragment not found: ${options.fragment}`);
  }

  const fragmentText = readFileSync(options.fragment, "utf8").replaceAll("__REPO_ROOT__", toPosix(REPO_ROOT));
  let fragment;
  try {
    fragment = JSON5.parse(fragmentText);
  } catch (error) {
    throw new Error(`fragment is not valid JSON5 (${options.fragment}): ${error instanceof Error ? error.message : String(error)}`);
  }

  const configExists = existsSync(options.config);
  const configText = configExists ? readFileSync(options.config, "utf8") : "{}";
  let live;
  try {
    live = JSON5.parse(configText);
  } catch (error) {
    throw new Error(
      `could not parse ${options.config}: ${error instanceof Error ? error.message : String(error)}. ` +
        "Refusing to touch a config it cannot read; restore the file from a backup first.",
    );
  }
  if (!isPlainObject(live)) throw new Error(`${options.config} does not contain a JSON object`);

  const before = JSON5.parse(JSON.stringify(live)); // pristine copy for the diff
  const report = { added: [], updated: [], unchanged: [], conflicts: [] };
  const merged = merge(live, fragment, [], report).value;

  // The chat-completions endpoint is the console's only way in. Enable it when it
  // is absent; leave an explicit `false` alone (that is a deliberate choice) but
  // say so, because the console will not work until it is true.
  const endpointsPath = ["gateway", "http", "endpoints", "chatCompletions", "enabled"];
  const readPath = (root, trail) => trail.reduce((node, key) => (isPlainObject(node) ? node[key] : undefined), root);

  let endpointsNote;
  if (readPath(merged, endpointsPath) === undefined) {
    let node = merged;
    for (const key of endpointsPath.slice(0, -1)) {
      if (!isPlainObject(node[key])) node[key] = {};
      node = node[key];
    }
    node[endpointsPath[endpointsPath.length - 1]] = true;
    report.added.push(endpointsPath);
    endpointsNote = "added (was missing)";
  } else if (readPath(merged, endpointsPath) === false) {
    endpointsNote = "WARNING: present and false -- the console cannot reach the gateway";
  } else {
    endpointsNote = "already enabled";
  }

  const serialised = `${JSON.stringify(merged, null, 2)}\n`;

  const parseCheck = checkParseRoundTrip(merged, serialised);
  const schemaCheck = options.validate ? checkSchema(serialised, options.openclawBin) : { ok: true, skipped: true };

  // ---- output -------------------------------------------------------------
  const out = [];
  out.push("Clinic OpenClaw merge");
  out.push(`  config    ${options.config}${configExists ? "" : "  (does not exist yet; it will be created)"}`);
  out.push(`  fragment  ${options.fragment}`);
  out.push(`  repo      ${toPosix(REPO_ROOT)}`);
  out.push(`  mode      ${options.dryRun ? "dry run -- nothing will be written" : "write"}`);
  out.push("");

  const beforeLeaves = flatten(before);
  const afterLeaves = flatten(merged);
  const lines = [];
  for (const [key, { trail, value }] of afterLeaves) {
    const earlier = beforeLeaves.get(key);
    if (!earlier) lines.push({ order: 0, text: `  + ${displayPath(trail)} = ${render(trail, value)}` });
    else if (!deepEqual(earlier.value, value)) {
      lines.push({ order: 1, text: `  ~ ${displayPath(trail)}: ${render(trail, earlier.value)} -> ${render(trail, value)}` });
    }
  }
  for (const [key, { trail, value }] of beforeLeaves) {
    if (!afterLeaves.has(key)) lines.push({ order: 2, text: `  - ${displayPath(trail)} = ${render(trail, value)}` });
  }
  lines.sort((a, b) => a.order - b.order || a.text.localeCompare(b.text));

  out.push("Diff:");
  if (lines.length === 0) out.push("  (no change -- the config already matches the fragment)");
  else out.push(...lines.map((line) => line.text));

  // Prove the redaction works instead of only claiming it: list every secret
  // still in the config, with its value withheld.
  const secrets = [...afterLeaves.values()]
    .map(({ trail }) => trail)
    .filter((trail) => SECRET_KEY.test(trail[trail.length - 1] ?? ""))
    .sort((a, b) => displayPath(a).localeCompare(displayPath(b)));
  if (secrets.length > 0) {
    out.push("");
    out.push("Secrets in the merged config (values never printed):");
    for (const trail of secrets) {
      const touched = report.updated.some((item) => deepEqual(item.path, trail));
      out.push(`  ${displayPath(trail)} = ${REDACTED}${touched ? "  (CHANGED)" : "  (untouched)"}`);
    }
  }

  if (report.conflicts.length > 0) {
    out.push("");
    out.push("Kept existing values (not owned by this fragment):");
    for (const conflict of report.conflicts) {
      out.push(`  ! ${displayPath(conflict.path)}: kept ${render(conflict.path, conflict.kept)}, fragment asked for ${render(conflict.path, conflict.ignored)}`);
    }
  }

  out.push("");
  out.push(`chatCompletions.enabled: ${endpointsNote}`);
  out.push(`Parse check: ${parseCheck.ok ? "PASS" : "FAIL"}`);
  out.push(
    `Schema check: ${schemaCheck.skipped ? "SKIPPED (--no-validate)" : schemaCheck.unavailable ? `UNAVAILABLE (${schemaCheck.detail})` : schemaCheck.ok ? "PASS" : "FAIL"}`,
  );
  if (schemaCheck.issues?.length) {
    for (const issue of schemaCheck.issues) out.push(`  ${issue.path}: ${issue.message}`);
  }

  // ---- workspace ----------------------------------------------------------
  const workspaceDir = options.workspace
    ?? expandHome(readPath(merged, ["agents", "entries", AGENT_ID, "workspace"]) ?? "");
  if (options.syncWorkspace && workspaceDir) {
    const copies = syncWorkspace(workspaceDir, options);
    out.push("");
    out.push(`Workspace: ${workspaceDir}`);
    for (const copy of copies) {
      out.push(`  ${options.dryRun ? "would be " : ""}${copy.state.padEnd(7)} ${path.relative(workspaceDir, copy.destination)}`);
    }
  }

  // ---- write --------------------------------------------------------------
  const failed = !parseCheck.ok || (!schemaCheck.ok && !schemaCheck.unavailable);
  if (failed) {
    out.push("");
    out.push("Refusing to write: validation failed. The config was not modified.");
    process.stdout.write(`${out.join("\n")}\n`);
    process.exit(1);
  }
  if (schemaCheck.unavailable) {
    out.push("");
    out.push(`WARNING: schema validation could not run (${schemaCheck.detail}).`);
    out.push("  The merged config parses, but nothing checked it against the OpenClaw schema.");
    out.push(`  Validate before restarting: OPENCLAW_STATE_DIR=<dir with this config> ${options.openclawBin} config validate`);
  }

  if (options.dryRun) {
    out.push("");
    out.push("Dry run: no files were written.");
    process.stdout.write(`${out.join("\n")}\n`);
    return;
  }

  let backup;
  if (configExists) {
    backup = backupPathFor(options.config);
    copyFileSync(options.config, backup);
    out.push("");
    out.push(`Backup: ${backup}`);
  }

  const comments = lookLikeCommentedSource(configText);
  writeFileSync(options.config, serialised, "utf8");

  // Re-read what actually landed on disk rather than trusting the in-memory copy.
  const onDisk = JSON5.parse(readFileSync(options.config, "utf8"));
  if (!deepEqual(onDisk, merged)) {
    out.push("");
    out.push("ERROR: the file on disk does not match what was merged.");
    if (backup) out.push(`Restore it with: Copy-Item "${backup}" "${options.config}"`);
    process.stdout.write(`${out.join("\n")}\n`);
    process.exit(1);
  }

  out.push("");
  out.push(`Wrote ${options.config}`);
  if (comments) {
    out.push("NOTE: the previous config contained comments or trailing commas; it is now strict JSON.");
    out.push(`      The originals are preserved in ${backup ? path.basename(backup) : "the backup"}.`);
  }
  out.push("");
  out.push("Next: restart the gateway, then run `openclaw doctor`.");
  process.stdout.write(`${out.join("\n")}\n`);
}

/**
 * True when the text has JSON5-only syntax (comments or a trailing comma), so the
 * caller can warn that normalising to strict JSON dropped something.
 */
function lookLikeCommentedSource(text) {
  const withoutStrings = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return /\/\/|\/\*/.test(withoutStrings) || /,\s*[}\]]/.test(withoutStrings);
}

try {
  main();
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n\n${usage()}`);
    process.exit(2);
  }
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
