import { createWriteStream } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ChildProcess } from "node:child_process";
import { spawnRun } from "./process-group.js";
import { killProcessTree, type SpawnResult } from "./spawn.js";
import { resolveWindowsCommand, windowsInvocation } from "./win-command.js";
import { log as diagnostics } from "./log.js";

export interface StreamOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  /** Raw stdout+stderr is appended here, so a run can be replayed or re-parsed later. */
  logFile?: string;
  /** Every complete stdout line, as it arrives (live agent panels, budget watchers). */
  onLine?: (line: string) => void;
  /** Return a reason to kill the whole process tree at once (budget overrun, sub-agent fan-out). */
  abortOn?: (line: string) => string | undefined;
}

/**
 * Run literal argv under process containment, streaming stdout line by line.
 *
 * Unlike spawnLogged (which joins argv for cmd.exe and so cannot carry JSON or
 * spaces), this uses exec's escaped batch-shim launch plan, so `claude.cmd`
 * and `codex.cmd` receive arbitrary argument values intact. Never rejects.
 */
export function streamProcess(cmd: string, args: string[], opts: StreamOptions): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const env = { ...(opts.env ?? process.env), PWD: resolvePath(opts.cwd) };
    let child: ChildProcess;
    try {
      const invocation = process.platform === "win32"
        ? windowsInvocation(resolveWindowsCommand(cmd, opts.cwd, env), args, env)
        : { command: cmd, args, env };
      child = spawnRun(invocation.command, invocation.args, {
        cwd: opts.cwd, shell: false, env: invocation.env, windowsHide: true,
      });
    } catch (error) {
      diagnostics.warn(`${cmd}: ${String(error)}`);
      resolve({ code: 127, timedOut: false, durationMs: Date.now() - start });
      return;
    }

    const logStream = opts.logFile ? createWriteStream(opts.logFile, { flags: "a" }) : null;
    let aborted: string | undefined;
    let pending = "";
    const onStdout = (d: Buffer): void => {
      logStream?.write(d);
      const lines = (pending + d.toString("utf8")).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    };
    const handleLine = (line: string): void => {
      if (!line) return;
      opts.onLine?.(line);
      if (aborted !== undefined || !opts.abortOn) return;
      const reason = opts.abortOn(line);
      if (reason === undefined) return;
      aborted = reason;
      killProcessTree(child);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", (d: Buffer) => logStream?.write(d));

    let timedOut = false;
    const timer = opts.timeoutMs ? setTimeout(() => { timedOut = true; killProcessTree(child); }, opts.timeoutMs) : undefined;

    let finished = false;
    const finish = (code: number): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      if (pending) handleLine(pending);
      const done = (): void => resolve({
        code: timedOut ? 124 : aborted !== undefined ? 125 : code,
        durationMs: Date.now() - start,
        timedOut,
        ...(aborted !== undefined && !timedOut ? { aborted } : {}),
      });
      if (!logStream) return done();
      logStream.once("close", done);
      logStream.end();
    };
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 0));

    if (child.stdin) {
      if (opts.input !== undefined) child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}
