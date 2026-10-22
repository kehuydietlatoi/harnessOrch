import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanEnvironment } from "../util/environment.js";
import { exec } from "../util/exec.js";

/**
 * Package manifests and lockfiles. Every task may change these, because agents
 * may add development dependencies on their own; dependencyViolations() keeps
 * production dependencies out of their reach.
 */
export const MANIFEST_GLOBS = [
  "package.json", "**/package.json", "package-lock.json", "npm-shrinkwrap.json",
  "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock",
];
const LOCKFILES = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];
const PROD_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "bundledDependencies", "bundleDependencies"];

export const isManifest = (path: string): boolean => /(^|\/)package\.json$/.test(path) || LOCKFILES.includes(path.split("/").pop() ?? "");

type Json = Record<string, unknown>;
const parse = (text: string | null): Json | null => {
  if (text === null) return null;
  try { const v = JSON.parse(text) as unknown; return v && typeof v === "object" && !Array.isArray(v) ? v as Json : {}; } catch { return {}; }
};
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

/**
 * What an agent changed in a package.json that it may not: anything in the
 * production dependency fields, and upgrading or removing an existing dev
 * dependency. Adding new dev dependencies, scripts, etc. is fine.
 */
export function dependencyViolations(before: string | null, after: string | null, allowed: readonly string[] = []): string[] {
  const a = parse(before) ?? {};
  const b = parse(after) ?? {};
  const out: string[] = [];
  for (const field of PROD_FIELDS) {
    const x = record(a[field]);
    const y = record(b[field]);
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (JSON.stringify(x[name]) === JSON.stringify(y[name])) continue;
      // The plan named it (approved at Start): adding it is fine, changing an existing one is not.
      if (allowed.includes(name) && x[name] === undefined) continue;
      out.push(`${field}.${name}: ${x[name] === undefined ? "added" : y[name] === undefined ? "removed" : "changed"}`);
    }
  }
  const devBefore = record(a.devDependencies);
  const devAfter = record(b.devDependencies);
  for (const [name, version] of Object.entries(devBefore)) {
    if (devAfter[name] === undefined) out.push(`devDependencies.${name}: removed`);
    else if (devAfter[name] !== version) out.push(`devDependencies.${name}: changed ${String(version)} → ${String(devAfter[name])}`);
  }
  return out;
}

/** The repo's package manager, by lockfile; null when it has no Node manifest. */
export function packageManager(cwd: string): { cmd: string; args: string[] } | null {
  if (!existsSync(join(cwd, "package.json"))) return null;
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return { cmd: "pnpm", args: ["install", "--frozen-lockfile"] };
  if (existsSync(join(cwd, "yarn.lock"))) return { cmd: "yarn", args: ["install", "--frozen-lockfile"] };
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return { cmd: "bun", args: ["install", "--frozen-lockfile"] };
  // Never let the engine's own install rewrite or create a lockfile: that would be a stray change in the worktree.
  return existsSync(join(cwd, "package-lock.json")) || existsSync(join(cwd, "npm-shrinkwrap.json"))
    ? { cmd: "npm", args: ["ci", "--no-audit", "--no-fund"] }
    : { cmd: "npm", args: ["install", "--no-package-lock", "--no-audit", "--no-fund"] };
}

/**
 * Why `cwd`'s installed packages do not match its manifest, or null when they do.
 * Catches a node_modules copied from a main checkout nobody re-installed after
 * a dependency was added. Reads each package's own package.json rather than
 * npm's node_modules/.package-lock.json, which can claim packages that are not
 * there. With an npm lockfile every locked package must be installed at its
 * locked version; otherwise every direct dependency must be installed.
 */
export function staleDeps(cwd: string): string | null {
  const read = (rel: string): Json | null => {
    try { return JSON.parse(readFileSync(join(cwd, rel), "utf8")) as Json; } catch { return null; }
  };
  const manifest = read("package.json");
  if (!manifest) return null;
  const lock = read("package-lock.json") ?? read("npm-shrinkwrap.json");
  if (lock && typeof lock.packages === "object" && lock.packages) {
    for (const [path, entry] of Object.entries(lock.packages as Record<string, Json>)) {
      // Workspace links and platform-specific optional packages are legitimately absent.
      if (!path.startsWith("node_modules/") || entry.link || entry.optional || entry.devOptional) continue;
      const name = path.slice("node_modules/".length);
      const have = read(`${path}/package.json`);
      if (!have) return `${name} is not installed`;
      if (have.version !== entry.version) return `${name} is ${String(have.version)}, locked at ${String(entry.version)}`;
    }
    return null;
  }
  for (const field of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys((manifest[field] ?? {}) as Json)) {
      if (!read(`node_modules/${name}/package.json`)) return `${name} is not installed`;
    }
  }
  return null;
}

/**
 * Bring a worktree's dependencies in line with its lockfile after a merge or
 * sync changed it. Engine-run and trusted; the node_modules here is the
 * worktree's own hard-linked copy, so this never touches the main checkout.
 */
export async function installDeps(cwd: string, timeoutMs = 600_000): Promise<{ ok: boolean; output: string }> {
  const pm = packageManager(cwd);
  if (!pm) return { ok: true, output: "" };
  const r = await exec(pm.cmd, pm.args, { cwd, timeoutMs, env: cleanEnvironment(), contain: true });
  return { ok: r.code === 0, output: `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/).slice(-20).join("\n") };
}
