/**
 * Shrink check output to what a worker needs to act on: failure lines with a
 * little context, plus the closing summary. Full logs stay on disk; replaying
 * them every turn was the old orchestrator's biggest token sink.
 *
 * Keep in sync with assets/hverify.mjs (the same filter, runnable by workers).
 */
const FAILURE = /\b(fail(ed|ure|ing)?|error|errors|exception|traceback|panic|assert(ion)?|expected|received|not ok|cannot|undefined is not|TypeError|ReferenceError|SyntaxError)\b|✗|×|✖|FAIL\b/i;
const MAX_LINE = 300;

export interface FilterOptions {
  maxLines?: number;
  context?: number;
  tail?: number;
}

export function filterCheckOutput(text: string, passed: boolean, opts: FilterOptions = {}): string {
  const maxLines = opts.maxLines ?? 100;
  const context = opts.context ?? 2;
  const tailCount = opts.tail ?? 8;
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/).map((l) => l.trimEnd()).filter((l, i, all) => l || all[i - 1]);
  const clip = (l: string): string => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}…` : l);
  if (passed) return lines.slice(-Math.min(tailCount, 3)).map(clip).join("\n");

  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (!FAILURE.test(l)) return;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) keep.add(j);
  });
  const tailStart = Math.max(0, lines.length - tailCount);
  for (let i = tailStart; i < lines.length; i++) keep.add(i);
  if (keep.size === tailCount && lines.length > tailCount) {
    // Nothing looked like a failure: show a longer tail instead.
    for (let i = Math.max(0, lines.length - 40); i < lines.length; i++) keep.add(i);
  }

  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (last >= 0 && i > last + 1) out.push("…");
    out.push(clip(lines[i]));
    last = i;
  }
  if (out.length <= maxLines) return out.join("\n");
  // Over budget: keep the first failures and the summary tail.
  const head = out.slice(0, maxLines - tailCount - 1);
  return [...head, `… (${out.length - maxLines + 1} more lines omitted)`, ...out.slice(-tailCount)].join("\n");
}
