import { appendFileSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { exec, type ExecResult } from "../util/exec.js";

/** Run git and throw with stderr on failure. */
export async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await exec("git", args, { cwd, ...(env ? { env } : {}) });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export function tryGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return exec("git", args, { cwd, ...(env ? { env } : {}) });
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await tryGit(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

export async function headSha(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "HEAD"]);
}

/** Create `branch` at `startPoint` unless it exists, and check it out at `path` unless already there. */
export async function ensureWorktree(repo: string, path: string, branch: string, startPoint: string): Promise<void> {
  if (!(await branchExists(repo, branch))) await git(repo, ["branch", branch, startPoint]);
  if (existsSync(path)) return;
  mkdirSync(dirname(path), { recursive: true });
  await git(repo, ["worktree", "add", path, branch]);
}

/** Directories named one of `names` in the main checkout, up to `depth` levels deep (repo-relative, `/`-separated). */
export function findSharedDirs(repo: string, names: readonly string[], depth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, level: number): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === ".git" || name === ".harness") continue;
      const full = join(dir, name);
      let stat;
      try { stat = lstatSync(full); } catch { continue; }
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (names.includes(name)) out.push(relative(repo, full).replaceAll("\\", "/"));
      else if (level < depth) walk(full, level + 1);
    }
  };
  walk(repo, 1);
  return out;
}

/**
 * Worktrees start without gitignored dependency folders, so builds fail and
 * agents (who may not install packages) get stuck. Give each worktree its own
 * hard-linked copy of the main checkout's folder: almost no disk, and unlike a
 * junction, an `npm ci` or `rm -rf node_modules` inside the worktree only
 * removes the worktree's links, never the real files. Kept git-ignored so it
 * never counts as a change.
 */
export async function provideSharedDirs(repo: string, worktree: string, names: readonly string[]): Promise<string[]> {
  const provided: string[] = [];
  for (const rel of findSharedDirs(repo, names)) {
    const target = join(worktree, rel);
    if (!existsSync(dirname(target))) continue; // the folder holding it is not in this branch
    let present = false;
    try { lstatSync(target); present = true; } catch { /* absent */ }
    if (present) continue;
    if ((await tryGit(worktree, ["check-ignore", "-q", rel])).code !== 0) await excludeEverywhere(worktree, rel);
    cloneTree(join(repo, rel), target);
    provided.push(rel);
  }
  return provided;
}

/**
 * Mirror a directory with hard links (copy when linking is impossible, e.g.
 * across volumes). Symlinks are recreated, pointing into the new tree when
 * they pointed inside the source.
 */
export function cloneTree(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(from);
      const abs = isAbsolute(link) ? link : join(dirname(from), link);
      const inside = relative(src, abs);
      const retarget = !inside.startsWith("..") && !isAbsolute(inside) ? join(dst, inside) : abs;
      let isDir = false;
      try { isDir = statSync(from).isDirectory(); } catch { /* dangling */ }
      symlinkSync(retarget, to, isDir ? (process.platform === "win32" ? "junction" : "dir") : "file");
    } else if (stat.isDirectory()) {
      cloneTree(from, to);
    } else {
      try { linkSync(from, to); } catch { copyFileSync(from, to); }
    }
  }
}

/** Add a path to the repository-wide exclude file (shared by every worktree). */
async function excludeEverywhere(worktree: string, rel: string): Promise<void> {
  const common = await git(worktree, ["rev-parse", "--git-common-dir"]);
  const file = join(isAbsolute(common) ? common : join(worktree, common), "info", "exclude");
  mkdirSync(dirname(file), { recursive: true });
  const line = `/${rel}`;
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!current.split(/\r?\n/).includes(line)) appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

/** The newest stash whose message is exactly `label`, as a commit sha. */
export async function findStash(cwd: string, label: string): Promise<string | null> {
  const r = await tryGit(cwd, ["stash", "list", "--format=%H %gs"]);
  for (const line of r.stdout.split(/\r?\n/)) {
    const space = line.indexOf(" ");
    if (space > 0 && line.slice(space + 1).endsWith(`: ${label}`)) return line.slice(0, space);
  }
  return null;
}

/** Re-apply parked work; on conflict leave the tree clean and report false. The stash entry is kept. */
export async function applyStash(cwd: string, sha: string): Promise<boolean> {
  if ((await tryGit(cwd, ["stash", "apply", "-q", sha])).code === 0) return true;
  await tryGit(cwd, ["reset", "-q", "--hard"]);
  await tryGit(cwd, ["clean", "-q", "-fd"]);
  return false;
}

/** Commit identity: the user's own when configured, a harness identity otherwise. Author always names the agent. */
export async function commitEnv(cwd: string, agent: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_AUTHOR_NAME: `${agent} (harnessOrch)`, GIT_AUTHOR_EMAIL: "harnessorch@localhost" };
  const configured = (await tryGit(cwd, ["config", "user.email"])).stdout.trim();
  if (!configured) Object.assign(env, { GIT_COMMITTER_NAME: "harnessOrch", GIT_COMMITTER_EMAIL: "harnessorch@localhost" });
  return env;
}

/** Stage everything and commit; returns the new sha, or null when there was nothing to commit. */
export async function commitAll(cwd: string, message: string, agent: string): Promise<string | null> {
  await git(cwd, ["add", "-A"]);
  if ((await tryGit(cwd, ["diff", "--cached", "--quiet"])).code === 0) return null;
  await git(cwd, ["commit", "-q", "--no-verify", "-m", message], await commitEnv(cwd, agent));
  return headSha(cwd);
}

/** Throw away uncommitted work in a lane (after a usage-limit handoff or an abandoned task). */
export async function discardChanges(cwd: string): Promise<void> {
  await git(cwd, ["reset", "-q", "--hard"]);
  await git(cwd, ["clean", "-q", "-fd"]);
}

/** Undo a worker's changes to specific paths: restore tracked files, delete new ones. */
export async function revertPaths(cwd: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const tracked = (await tryGit(cwd, ["cat-file", "-e", `HEAD:${path}`])).code === 0;
    if (tracked) await git(cwd, ["restore", "--source=HEAD", "--staged", "--worktree", "--", path]);
    else {
      await tryGit(cwd, ["rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
      await git(cwd, ["clean", "-q", "-f", "--", path]);
    }
  }
}

/** Park uncommitted lane work on the stash (recoverable by the human), leaving the lane clean. */
export async function stashWip(cwd: string, label: string): Promise<boolean> {
  if (!(await tryGit(cwd, ["status", "--porcelain"])).stdout.trim()) return false;
  await git(cwd, ["stash", "push", "-q", "-u", "-m", label]);
  return true;
}

export interface MergeOutcome {
  merged: boolean;
  conflicts: string[];
}

/** `git merge --no-ff`; on conflict the merge is left in progress for a resolver. */
export async function mergeNoFf(cwd: string, branch: string, message: string, agent: string): Promise<MergeOutcome> {
  const r = await tryGit(cwd, ["merge", "--no-ff", "--no-edit", "-m", message, branch], await commitEnv(cwd, agent));
  if (r.code === 0) return { merged: true, conflicts: [] };
  const conflicts = (await tryGit(cwd, ["diff", "--name-only", "--diff-filter=U"])).stdout.split(/\r?\n/).filter(Boolean);
  if (!conflicts.length) throw new Error(`git merge ${branch} failed: ${(r.stderr || r.stdout).trim()}`);
  return { merged: false, conflicts };
}

export async function unresolvedPaths(cwd: string): Promise<string[]> {
  const files = (await tryGit(cwd, ["diff", "--name-only", "--diff-filter=U"])).stdout.split(/\r?\n/).filter(Boolean);
  const markers = (await tryGit(cwd, ["grep", "-l", "-E", "^(<<<<<<<|>>>>>>>) "])).stdout.split(/\r?\n/).filter(Boolean);
  return [...new Set([...files, ...markers])];
}

/** Conclude a merge a resolver fixed up. */
export async function concludeMerge(cwd: string, agent: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "--no-verify", "--no-edit"], await commitEnv(cwd, agent));
  return headSha(cwd);
}

export async function abortMerge(cwd: string): Promise<void> {
  await tryGit(cwd, ["merge", "--abort"]);
}

/** Bring a lane up to date with the plan branch. Lane commits are always merged first, so this fast-forwards. */
export async function syncLane(lane: string, planBranch: string): Promise<void> {
  const ff = await tryGit(lane, ["merge", "--ff-only", "-q", planBranch]);
  if (ff.code === 0) return;
  // Leftover unmerged lane commits (an abandoned task): the plan branch is the truth.
  await git(lane, ["reset", "-q", "--hard", planBranch]);
}

/** Patches of the given commits, capped for a review prompt. */
export async function commitsDiff(cwd: string, shas: readonly string[], maxChars = 120_000): Promise<{ diff: string; truncated: boolean }> {
  let diff = "";
  for (const sha of shas) diff += `${await git(cwd, ["show", "--stat", "--patch", "--format=commit %H%n%s", sha])}\n\n`;
  return diff.length > maxChars ? { diff: `${diff.slice(0, maxChars)}\n… (diff truncated)`, truncated: true } : { diff, truncated: false };
}
