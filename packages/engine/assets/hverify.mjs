#!/usr/bin/env node
// hverify: run a check command and print only what an agent needs — failures
// with a little context and the closing summary. Exit code is the command's.
// Usage: node hverify.mjs "<command>"
// Keep the filter in sync with src/checks/filter.ts.
import { spawn } from "node:child_process";

const FAILURE = /\b(fail(ed|ure|ing)?|error|errors|exception|traceback|panic|assert(ion)?|expected|received|not ok|cannot|undefined is not|TypeError|ReferenceError|SyntaxError)\b|✗|×|✖|FAIL\b/i;
const MAX_LINE = 300;

export function filterCheckOutput(text, passed, opts = {}) {
  const maxLines = opts.maxLines ?? 100;
  const context = opts.context ?? 2;
  const tailCount = opts.tail ?? 8;
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trimEnd()).filter((l, i, all) => l || all[i - 1]);
  const clip = (l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l);
  if (passed) return lines.slice(-Math.min(tailCount, 3)).map(clip).join("\n");
  const keep = new Set();
  lines.forEach((l, i) => {
    if (!FAILURE.test(l)) return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j);
  });
  const tailStart = Math.max(0, lines.length - tailCount);
  for (let i = tailStart; i < lines.length; i++) keep.add(i);
  if (keep.size === tailCount && lines.length > tailCount) {
    for (let i = Math.max(0, lines.length - 40); i < lines.length; i++) keep.add(i);
  }
  const out = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last >= 0 && i > last + 1) out.push("…");
    out.push(clip(lines[i]));
    last = i;
  }
  if (out.length <= maxLines) return out.join("\n");
  const head = out.slice(0, maxLines - tailCount - 1);
  return [...head, `… (${out.length - maxLines + 1} more lines omitted)`, ...out.slice(-tailCount)].join("\n");
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll("\\", "/").split("/").pop());
if (isMain) {
  const command = process.argv.slice(2).join(" ");
  if (!command) {
    console.error('usage: node hverify.mjs "<command>"');
    process.exit(2);
  }
  const child = spawn(command, { shell: true, windowsHide: true });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  child.on("close", (code) => {
    const passed = code === 0;
    console.log(`$ ${command}\n${passed ? "PASSED" : `FAILED (exit ${code})`}`);
    const filtered = filterCheckOutput(output, passed);
    if (filtered) console.log(filtered);
    process.exit(code ?? 1);
  });
}
