import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathMatchesGlob } from "../git/path-locks.js";
import { cleanEnvironment } from "../util/environment.js";
import { exec } from "../util/exec.js";
import { spawnLogged } from "../util/spawn.js";
import { filterCheckOutput } from "./filter.js";

/** Absolute path of the worker-side filter wrapper (`node <path> "<command>"`). */
export const HVERIFY_PATH = fileURLToPath(new URL("../../assets/hverify.mjs", import.meta.url)).replaceAll("\\", "/");

export function hverifyCommand(command: string): string {
  return `node ${HVERIFY_PATH} "${command.replaceAll('"', '\\"')}"`;
}

export interface CheckResult {
  command: string;
  passed: boolean;
  code: number;
  /** Filtered output: what a worker or the orchestrator gets to see. */
  excerpt: string;
  logFile: string;
}

/**
 * Run trusted check commands (from the plan the user approved) through the
 * shell, stopping at the first failure. Credentials are scrubbed from the env.
 */
export async function runChecks(commands: readonly string[], cwd: string, logDir: string, timeoutMs = 900_000): Promise<CheckResult[]> {
  mkdirSync(logDir, { recursive: true });
  const results: CheckResult[] = [];
  for (const [i, command] of commands.entries()) {
    const logFile = join(logDir, `check-${Date.now()}-${i}.log`);
    const r = await spawnLogged(command, [], { cwd, shell: true, logFile, timeoutMs, env: cleanEnvironment() });
    let raw = "";
    try { raw = readFileSync(logFile, "utf8"); } catch { /* never started */ }
    const passed = r.code === 0;
    const excerpt = r.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s\n${filterCheckOutput(raw, false)}` : filterCheckOutput(raw, passed);
    results.push({ command, passed, code: r.code, excerpt, logFile });
    if (!passed) break;
  }
  return results;
}

export function checksPassed(results: readonly CheckResult[]): boolean {
  return results.every((r) => r.passed);
}

/** One compact block for a prompt: only failing commands carry output. */
export function formatCheckFailures(results: readonly CheckResult[]): string {
  return results.filter((r) => !r.passed).map((r) => `$ ${r.command} (exit ${r.code})\n${r.excerpt}`).join("\n\n");
}

/** Every path the working tree changed relative to HEAD, including untracked files. */
export async function changedPaths(cwd: string): Promise<string[]> {
  const r = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
  if (r.code !== 0) throw new Error(`git status failed: ${r.stderr.trim()}`);
  const out: string[] = [];
  const entries = r.stdout.split("\0");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    out.push(e.slice(3));
    // Renames and copies carry the original path as the next entry.
    if (e[0] === "R" || e[0] === "C") out.push(entries[++i]);
  }
  return [...new Set(out.map((p) => p.replaceAll("\\", "/")))];
}

export interface ScopeViolation {
  path: string;
  reason: "outside write_scope" | "protected";
}

/** Changed paths a task was not allowed to touch. */
export function scopeViolations(paths: readonly string[], writeScope: readonly string[], protectedPaths: readonly string[] = []): ScopeViolation[] {
  const out: ScopeViolation[] = [];
  for (const path of paths) {
    if (protectedPaths.some((p) => pathMatchesGlob(p, path))) out.push({ path, reason: "protected" });
    else if (!writeScope.some((g) => pathMatchesGlob(g, path))) out.push({ path, reason: "outside write_scope" });
  }
  return out;
}

export const ensureDir = (file: string): string => {
  mkdirSync(dirname(file), { recursive: true });
  return file;
};
