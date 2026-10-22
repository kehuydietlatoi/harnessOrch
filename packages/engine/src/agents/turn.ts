import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AdapterConfig, ModelSpec } from "../config.js";
import { codexDelegation } from "../adapters/codex.js";
import { lastFencedBlock } from "../adapters/headless.js";
import { buildOpencodeArgv } from "../adapters/opencode-events.js";
import { opencodePermissions } from "../adapters/opencode.js";
import { detectUsageLimit, type UsageLimit } from "../adapters/usage-limit.js";
import { workerEnvironment } from "../util/environment.js";
import { streamProcess } from "../util/stream.js";
import { hverifyCommand } from "../checks/checks.js";

export type AgentId = "claude" | "codex" | "opencode";
export const AGENT_IDS: readonly AgentId[] = ["claude", "codex", "opencode"];

/** Token usage of one turn, split the way prompt caching bills it. */
export interface TurnUsage {
  /** Input tokens not served from or written to the cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** Model requests the turn made. */
  requests: number;
  /** Context size of the turn's last request: what the next turn will replay. */
  contextTokens: number;
}

/** Codex's running usage for a whole thread, as its `turn.completed` reports it. */
export interface ThreadTotals {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

export interface TurnRequest {
  agent: AgentId;
  model: ModelSpec;
  cwd: string;
  prompt: string;
  /** Continue this session instead of starting one. */
  resumeSession?: string;
  /** Codex only: the resumed thread's totals after its previous turn, subtracted to get this turn's usage. */
  threadTotals?: ThreadTotals;
  /** JSON Schema the final answer must satisfy. */
  schema?: object;
  readOnly?: boolean;
  /** Codex only: keep image generation available (asset tasks). */
  imageGeneration?: boolean;
  /** Plan check commands; OpenCode may run exactly these through hverify, nothing broader. */
  checkCommands?: readonly string[];
  logFile: string;
  timeoutMs?: number;
  adapter?: AdapterConfig;
  onLine?: (line: string) => void;
  /** Extra kill switch, e.g. a live budget watcher. */
  abortOn?: (line: string) => string | undefined;
}

export interface TurnResult {
  code: number;
  durationMs: number;
  timedOut: boolean;
  aborted?: string;
  sessionId?: string;
  /** Final assistant text. */
  text: string;
  /** Schema-bound result, when the agent produced one. */
  structured?: unknown;
  usage: TurnUsage;
  /** Codex only: the thread's totals after this turn, when it reported them. */
  threadTotals?: ThreadTotals;
  usageLimit?: UsageLimit;
}

/** Built-in Claude tools a worker may use; everything else (Task, WebFetch, ...) stays unloaded. */
export const CLAUDE_WORKER_TOOLS = "Read,Edit,Write,Bash,Grep,Glob";
export const CLAUDE_READ_TOOLS = "Read,Grep,Glob";
/** Never auto-approved, even though Bash is. */
export const CLAUDE_RISKY_BASH = [
  "Bash(git push:*)", "Bash(git reset --hard:*)", "Bash(git clean:*)", "Bash(git checkout -- :*)",
  // Adding dev dependencies is allowed (the engine reverts production-dependency changes);
  // full reinstalls, upgrades and removals are not.
  "Bash(npm ci:*)", "Bash(npm update:*)", "Bash(npm uninstall:*)", "Bash(npm remove:*)", "Bash(npm audit fix:*)",
  "Bash(pnpm install:*)", "Bash(pnpm update:*)", "Bash(pnpm remove:*)", "Bash(yarn install:*)", "Bash(yarn upgrade:*)",
  "Bash(yarn remove:*)", "Bash(bun install:*)", "Bash(bun update:*)", "Bash(bun remove:*)",
  "Bash(rm -rf /:*)", "Bash(curl:*)", "Bash(wget:*)",
];

/**
 * Lean Claude worker (M0: ~6.6k-token preamble instead of ~23.6k): no user settings,
 * plugins, skills, MCP servers or slash commands; only the listed built-in tools.
 */
export function claudeTurnArgs(req: Pick<TurnRequest, "model" | "readOnly" | "schema">, session: { id: string; resume: boolean }): string[] {
  const args = [
    "-p", "--output-format", "stream-json", "--verbose",
    "--setting-sources", "project",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--tools", req.readOnly ? CLAUDE_READ_TOOLS : CLAUDE_WORKER_TOOLS,
  ];
  if (req.readOnly) args.push("--disallowedTools", "Edit,Write,Bash,NotebookEdit");
  else args.push("--permission-mode", "acceptEdits", "--allowedTools", "Bash", "--disallowedTools", ...CLAUDE_RISKY_BASH);
  if (req.model.model) args.push("--model", req.model.model);
  if (req.model.effort) args.push("--effort", req.model.effort);
  if (req.schema) args.push("--json-schema", JSON.stringify(req.schema));
  args.push(session.resume ? "--resume" : "--session-id", session.id);
  return args;
}

export function claudeEnv(adapter?: AdapterConfig): NodeJS.ProcessEnv {
  return { ...workerEnvironment("claude", adapter?.env), ENABLE_CLAUDEAI_MCP_SERVERS: "false", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
}

/** OpenCode bash patterns for adding dev dependencies (its default is deny-all). */
export const OPENCODE_DEV_INSTALLS = [
  "npm install -D *", "npm i -D *", "npm install --save-dev *", "pnpm add -D *", "yarn add -D *", "bun add -d *", "npx playwright install*",
];

/** Codex features a coding worker never needs; disabling them roughly halves the baseline (M0: 49k → 27k). */
export const CODEX_DISABLED_FEATURES = [
  "apps", "browser_use", "browser_use_external", "computer_use", "multi_agent", "plugins", "remote_plugin",
  "skill_search", "tool_suggest", "goals", "image_generation", "in_app_browser", "sleep_tool",
];

export function codexTurnArgs(req: Pick<TurnRequest, "model" | "readOnly" | "imageGeneration" | "resumeSession">, schemaFile?: string): string[] {
  const args = ["exec", "--json", "--ignore-user-config", "--skip-git-repo-check"];
  for (const feature of CODEX_DISABLED_FEATURES) {
    if (feature === "image_generation" && req.imageGeneration) continue;
    args.push("--disable", feature);
  }
  if (schemaFile) args.push("--output-schema", schemaFile);
  if (req.model.model) args.push("-m", req.model.model);
  if (req.model.effort) args.push("-c", `model_reasoning_effort=${req.model.effort}`);
  args.push(...(req.readOnly ? ["-s", "read-only"] : ["--approve-for-me"]));
  if (req.resumeSession) args.push("resume", req.resumeSession);
  args.push("-");
  return args;
}

export function opencodeTurnArgs(req: Pick<TurnRequest, "model" | "resumeSession">): string[] {
  if (!req.model.model) throw new Error("OpenCode requires an explicit provider/model");
  return [...buildOpencodeArgv({ model: req.model.model, variant: req.model.effort, resumeSession: req.resumeSession }), "--pure"];
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Json : {});
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

function parseLines(raw: string): Json[] {
  const out: Json[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { out.push(obj(JSON.parse(t))); } catch { /* non-JSON noise */ }
  }
  return out;
}

const emptyUsage = (): TurnUsage => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0, contextTokens: 0 });

/** Reduce a Claude stream-json turn. */
export function reduceClaude(raw: string): Omit<TurnResult, "code" | "timedOut" | "durationMs"> {
  const events = parseLines(raw);
  const usage = emptyUsage();
  let text = "";
  let structured: unknown;
  let sessionId: string | undefined;
  let finished = false;
  // Per request (one message id can span several stream events): the fallback when the turn was killed before "result".
  const requests = new Map<string, Json>();
  for (const e of events) {
    if (typeof e.session_id === "string") sessionId = e.session_id;
    if (e.type === "assistant") {
      const message = obj(e.message);
      const u = obj(message.usage);
      const ctx = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
      if (ctx > 0) usage.contextTokens = ctx;
      requests.set(typeof message.id === "string" ? message.id : `r${requests.size}`, u);
    }
    if (e.type === "result") {
      finished = true;
      const u = obj(e.usage);
      usage.input = num(u.input_tokens);
      usage.cacheRead = num(u.cache_read_input_tokens);
      usage.cacheWrite = num(u.cache_creation_input_tokens);
      usage.output = num(u.output_tokens);
      usage.requests = Math.max(1, num(e.num_turns));
      if (typeof e.result === "string") text = e.result;
      if (e.structured_output !== undefined) structured = e.structured_output;
    }
  }
  if (!finished) {
    for (const u of requests.values()) {
      usage.input += num(u.input_tokens);
      usage.cacheRead += num(u.cache_read_input_tokens);
      usage.cacheWrite += num(u.cache_creation_input_tokens);
      usage.output += num(u.output_tokens);
    }
    usage.requests = requests.size;
  }
  if (!usage.contextTokens) usage.contextTokens = Math.round((usage.input + usage.cacheRead + usage.cacheWrite) / Math.max(1, usage.requests));
  return { text, sessionId, usage, ...(structured !== undefined ? { structured } : {}) };
}

/**
 * Reduce a Codex `exec --json` turn. `turn.completed` reports the thread's running
 * totals, so a resumed turn's usage is those minus the totals `resumed` had. `input_tokens` includes the cached part.
 */
export function reduceCodex(raw: string, resumed?: { threadId: string; totals: ThreadTotals }): Omit<TurnResult, "code" | "timedOut" | "durationMs"> {
  const usage = emptyUsage();
  let text = "";
  let sessionId: string | undefined;
  let threadTotals: ThreadTotals | undefined;
  let items = 0;
  for (const e of parseLines(raw)) {
    if (e.type === "thread.started" && typeof e.thread_id === "string") sessionId = e.thread_id;
    if (e.type === "item.completed") {
      const item = obj(e.item);
      items++;
      if (item.type === "agent_message" && typeof item.text === "string") text = item.text;
    }
    if (e.type === "turn.completed") {
      const u = obj(e.usage);
      threadTotals = { input: num(u.input_tokens), cached: num(u.cached_input_tokens), cacheWrite: num(u.cache_write_input_tokens), output: num(u.output_tokens) };
    }
  }
  if (threadTotals) {
    const prior = resumed && (sessionId ?? resumed.threadId) === resumed.threadId ? resumed.totals : undefined;
    const since = (k: keyof ThreadTotals): number => Math.max(0, threadTotals![k] - (prior?.[k] ?? 0));
    usage.cacheRead = since("cached");
    usage.cacheWrite = since("cacheWrite");
    usage.input = Math.max(0, since("input") - usage.cacheRead - usage.cacheWrite);
    usage.output = since("output");
  }
  // Codex reports no per-request usage: each completed item is roughly one model request.
  usage.requests = Math.max(1, items);
  usage.contextTokens = Math.round((usage.input + usage.cacheRead + usage.cacheWrite) / usage.requests);
  return { text, sessionId, usage, ...(threadTotals ? { threadTotals } : {}), ...structuredFrom(text) };
}

/** Reduce an OpenCode `run --format json` turn. `tokens.input` excludes cache reads. */
export function reduceOpencodeTurn(raw: string): Omit<TurnResult, "code" | "timedOut" | "durationMs"> {
  const usage = emptyUsage();
  let text = "";
  let sessionId: string | undefined;
  for (const e of parseLines(raw)) {
    if (typeof e.sessionID === "string") sessionId = e.sessionID;
    const part = obj(e.part);
    if (e.type === "text" && typeof part.text === "string") text = part.text;
    if (e.type === "step_finish") {
      const t = obj(part.tokens);
      const cache = obj(t.cache);
      usage.input += num(t.input);
      usage.cacheRead += num(cache.read);
      usage.cacheWrite += num(cache.write);
      usage.output += num(t.output);
      usage.requests++;
      usage.contextTokens = num(t.input) + num(cache.read) + num(cache.write);
    }
  }
  return { text, sessionId, usage, ...structuredFrom(text) };
}

/** Agents without native schema support end with a fenced JSON block (or plain JSON). */
export function structuredFrom(text: string): { structured?: unknown } {
  const candidate = lastFencedBlock(text) ?? text.trim();
  if (!candidate.startsWith("{")) return {};
  try { return { structured: JSON.parse(candidate) as unknown }; } catch { return {}; }
}

function stateDirOutside(cwd: string): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-turn-"));
  if (realpathSync(dir).startsWith(realpathSync(cwd))) throw new Error("turn state must live outside the worktree");
  return dir;
}

/** Run one turn of an agent session. Never throws for agent failures; reads usage from the turn's own output. */
export async function runTurn(req: TurnRequest): Promise<TurnResult> {
  mkdirSync(dirname(req.logFile), { recursive: true });
  writeFileSync(req.logFile, "");
  const state = stateDirOutside(req.cwd);
  try {
    let cmd: string;
    let args: string[];
    let env: NodeJS.ProcessEnv;
    let abort = req.abortOn;
    let claudeSession: string | undefined;
    if (req.agent === "claude") {
      claudeSession = req.resumeSession ?? randomUUID();
      cmd = req.adapter?.cmd ?? "claude";
      args = claudeTurnArgs(req, { id: claudeSession, resume: req.resumeSession !== undefined });
      env = claudeEnv(req.adapter);
    } else if (req.agent === "codex") {
      let schemaFile: string | undefined;
      if (req.schema) {
        schemaFile = join(state, "schema.json");
        writeFileSync(schemaFile, JSON.stringify(req.schema));
      }
      cmd = req.adapter?.cmd ?? "codex";
      args = codexTurnArgs(req, schemaFile);
      env = workerEnvironment("codex", req.adapter?.env);
      const extra = abort;
      abort = (line) => codexDelegation(line) ?? extra?.(line);
    } else {
      const config = join(state, "opencode.json");
      const permission = opencodePermissions(realpathSync(req.cwd), req.readOnly);
      if (!req.readOnly) {
        const bash = permission.bash as Record<string, string>;
        for (const c of req.checkCommands ?? []) bash[hverifyCommand(c)] = "allow";
        // Adding dev dependencies is allowed for every agent; the engine reverts production-dependency changes.
        for (const p of OPENCODE_DEV_INSTALLS) bash[p] = "allow";
      }
      writeFileSync(config, JSON.stringify({ permission }), { mode: 0o600 });
      cmd = req.adapter?.cmd ?? "opencode";
      args = opencodeTurnArgs(req);
      env = {
        ...workerEnvironment("opencode", req.adapter?.env), OPENCODE_CONFIG: config, OPENCODE_DISABLE_PROJECT_CONFIG: "true",
        OPENCODE_CONFIG_CONTENT: "", OPENCODE_CONFIG_DIR: "", OPENCODE_PERMISSION: "",
      };
    }
    const proc = await streamProcess(cmd, args, {
      cwd: req.cwd, env, input: req.prompt, timeoutMs: req.timeoutMs, logFile: req.logFile, onLine: req.onLine, abortOn: abort,
    });
    const raw = readFileSync(req.logFile, "utf8");
    const reduced = req.agent === "claude" ? reduceClaude(raw) : req.agent === "codex" ? reduceCodex(raw, req.resumeSession && req.threadTotals ? { threadId: req.resumeSession, totals: req.threadTotals } : undefined) : reduceOpencodeTurn(raw);
    const usageLimit = proc.code === 0 ? null : detectUsageLimit(raw);
    return {
      ...reduced,
      sessionId: reduced.sessionId ?? claudeSession ?? req.resumeSession,
      code: proc.code, timedOut: proc.timedOut, durationMs: proc.durationMs,
      ...(proc.aborted ? { aborted: proc.aborted } : {}),
      ...(usageLimit ? { usageLimit } : {}),
    };
  } finally {
    rmSync(state, { recursive: true, force: true });
  }
}
