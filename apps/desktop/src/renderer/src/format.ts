/**
 * Turn one raw JSONL line from an agent's headless stream into terminal text.
 * Returns null for lines that carry nothing worth showing (deltas, bookkeeping).
 */
const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
};

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === "object" && !Array.isArray(v) ? v as J : {});
const clip = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const crlf = (s: string): string => s.replace(/\r?\n/g, "\r\n");

/** Lane worktrees live at …/.harness-wt/<repo>/<plan>/<agent>/; show paths relative to that. */
const relative = (s: string): string => s.replace(/[A-Za-z]:[\\/][^"'\s]*?[\\/]\.harness-wt[\\/][^\\/]+[\\/][^\\/]+[\\/][^\\/]+[\\/]/g, "")
  .replace(/node [^\s"]*hverify\.mjs/g, "hverify");

function toolSummary(name: string, input: J): string {
  const arg = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.filePath ?? input.description;
  return `${c.cyan("●")} ${name}${typeof arg === "string" ? c.dim(` ${clip(oneLine(relative(arg)), 120)}`) : ""}`;
}

export function formatLine(agent: string, raw: string): string | null {
  if (!raw.startsWith("{")) return c.dim(clip(raw, 200));
  let e: J;
  try { e = JSON.parse(raw) as J; } catch { return null; }

  if (agent === "claude") {
    if (e.type === "system" && e.subtype === "init") return c.dim(`session ${String(e.session_id ?? "").slice(0, 8)} · ${String(e.model ?? "")} · ${(e.tools as unknown[] | undefined)?.length ?? 0} tools`);
    if (e.type === "assistant") {
      const parts = (obj(e.message).content as J[] | undefined) ?? [];
      const out = parts.map((p) => p.type === "text" ? crlf(String(p.text ?? "")) : p.type === "tool_use" ? toolSummary(String(p.name), obj(p.input)) : "").filter(Boolean);
      return out.length ? out.join("\r\n") : null;
    }
    if (e.type === "result") return (e.is_error ? c.red : c.green)(`■ turn finished (${String(e.num_turns ?? "?")} requests)`);
    return null;
  }

  if (agent === "codex") {
    if (e.type === "thread.started") return c.dim(`thread ${String(e.thread_id ?? "").slice(0, 8)}`);
    if (e.type === "item.completed") {
      const item = obj(e.item);
      if (item.type === "agent_message") return crlf(String(item.text ?? ""));
      if (item.type === "command_execution") {
        const code = item.exit_code;
        return `${c.cyan("$")} ${clip(oneLine(relative(String(item.command ?? ""))), 140)}${typeof code === "number" ? (code === 0 ? c.dim(" ✓") : c.red(` exit ${code}`)) : ""}`;
      }
      if (item.type === "file_change") {
        const changes = (item.changes as J[] | undefined) ?? [];
        return `${c.yellow("✎")} ${changes.map((ch) => String(ch.path ?? "")).join(", ") || "files changed"}`;
      }
      return null;
    }
    if (e.type === "turn.completed") return c.green("■ turn finished");
    if (e.type === "turn.failed" || e.type === "error") return c.red(`✗ ${clip(oneLine(JSON.stringify(e.error ?? e.message ?? e)), 200)}`);
    return null;
  }

  // opencode
  const part = obj(e.part);
  if (e.type === "text") return crlf(String(part.text ?? ""));
  if (e.type === "tool_use") return toolSummary(String(part.tool ?? "tool"), obj(obj(part.state).input));
  if (e.type === "step_finish") return null;
  if (e.type === "error") return c.red(`✗ ${clip(oneLine(JSON.stringify(e.error ?? e)), 200)}`);
  return null;
}

export const banner = (text: string): string => `\r\n\x1b[1;35m── ${text} ──\x1b[0m\r\n`;
