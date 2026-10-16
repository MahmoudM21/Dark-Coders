#!/usr/bin/env node
// Byte-identity check for the runtime prompt files.
//
//   npm run check:prompts
//
// docs/PROMPTS.md carries a "Runtime files" section whose markdown fences hold the
// verbatim contents of the three files the OpenClaw agent actually reads. They must
// stay identical, and LF, or the agent runs a prompt the repo does not document.
// Locate each block by its `## FILE:` marker rather than by line number, strip the
// single trailing newline the fence adds, and compare bytes against disk.
//
// Exits non-zero and names the first differing byte on any mismatch.

import { readFileSync } from "node:fs";

const PROMPTS = "docs/PROMPTS.md";
const docs = readFileSync(PROMPTS, "utf8");
const lines = docs.split("\n");

/** Pull `## FILE: \`path\`` blocks out of the "Runtime files" section, by marker. */
function extractBlocks() {
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^## FILE: `([^`]+)`\s*$/.exec(lines[index]);
    if (!marker) continue;
    let open = index + 1;
    while (open < lines.length && lines[open].trim() === "") open += 1;
    if (!lines[open]?.startsWith("```")) {
      throw new Error(`${PROMPTS}:${index + 1} — no fenced block after ${marker[1]}`);
    }
    const body = [];
    let cursor = open + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (lines[cursor].startsWith("```")) break;
      body.push(lines[cursor]);
    }
    if (cursor >= lines.length) {
      throw new Error(`${PROMPTS}:${index + 1} — unterminated fenced block for ${marker[1]}`);
    }
    // The fence owns a newline after the content; the file ends without one.
    blocks.push({ path: marker[1], text: body.join("\n") + "\n" });
    index = cursor;
  }
  return blocks;
}

function firstDifference(a, b) {
  const limit = Math.min(a.length, b.length);
  for (let index = 0; index < limit; index += 1) {
    if (a[index] !== b[index]) {
      const line = a.slice(0, index).split("\n").length;
      return `first difference at byte ${index + 1} (line ${line}): docs has ${JSON.stringify(a[index])}, file has ${JSON.stringify(b[index])}`;
    }
  }
  return a.length === b.length
    ? "identical"
    : `one side is longer: docs ${a.length} bytes, file ${b.length} bytes`;
}

const blocks = extractBlocks();
if (blocks.length === 0) {
  console.error(`No "## FILE:" blocks found in ${PROMPTS}.`);
  process.exit(2);
}

let failures = 0;
for (const block of blocks) {
  let onDisk;
  try {
    onDisk = readFileSync(block.path, "utf8");
  } catch (error) {
    console.log(`FAIL  ${block.path} — cannot read it (${error instanceof Error ? error.message : String(error)})`);
    failures += 1;
    continue;
  }
  if (onDisk.includes("\r")) {
    console.log(`FAIL  ${block.path} — has CRLF line endings; the runtime files must stay LF`);
    failures += 1;
    continue;
  }
  const difference = firstDifference(block.text, onDisk);
  if (difference === "identical") {
    console.log(`PASS  ${block.path} — byte-identical to its block in ${PROMPTS}`);
  } else {
    console.log(`FAIL  ${block.path} — ${difference}`);
    failures += 1;
  }
}

console.log(
  `\n${failures === 0 ? "PASS" : "FAIL"}: ${blocks.length - failures} of ${blocks.length} runtime prompt files match ${PROMPTS} byte for byte.`,
);
process.exit(failures === 0 ? 0 : 1);
