import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnRequest, TurnResult } from "../src/agents/turn.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { PlanRunner, type RunnerEvent } from "../src/engine/runner.js";
import { Store } from "../src/store/store.js";

const PASS = 'node -e "process.exit(0)"';
const contains = (file: string, text: string): string =>
  `node -e "process.exit(require('fs').readFileSync('${file}','utf8').includes('${text}')?0:1)"`;

function task(id: string, title: string, yaml: string): string {
  return `- [ ] **${id} — ${title}**\n\`\`\`yaml\n${yaml}\n\`\`\`\n`;
}

let root: string;
let repo: string;
let store: Store;
let installs: string[] = [];
const KEY = (): string => `${repo.replaceAll("\\", "/").toLowerCase()}#demo`;

function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "harness-runner-"));
  repo = join(root, "repo");
  mkdirSync(join(repo, "src"), { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@example.com");
  sh(repo, "config", "user.name", "T");
  writeFileSync(join(repo, "src", "base.txt"), "base\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "init");
  store = new Store(":memory:");
  installs = [];
});
afterEach(() => {
  store.close();
  try { execFileSync("git", ["worktree", "prune"], { cwd: repo }); } catch { /* ignore */ }
  rmSync(root, { recursive: true, force: true });
});

function writePlan(body: string, header = `checks: ['${PASS}']`): string {
  mkdirSync(join(repo, ".harness", "plans"), { recursive: true });
  const file = join(repo, ".harness", "plans", "demo.md");
  writeFileSync(file, `---\ntitle: Demo\n${header}\n---\n\n${body}`);
  return file;
}

type Script = (req: TurnRequest, call: number) => Partial<TurnResult> & { write?: Record<string, string> };

/** A scripted agent: writes files into its cwd and answers with a structured result. */
function fakeTurns(script: Script) {
  const calls: TurnRequest[] = [];
  let n = 0;
  const runTurn = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    const out = script(req, n++);
    for (const [file, text] of Object.entries(out.write ?? {})) {
      mkdirSync(join(req.cwd, file, ".."), { recursive: true });
      writeFileSync(join(req.cwd, file), text);
    }
    const sessionId = req.resumeSession ?? `${req.agent}-session-${n}`;
    return {
      code: 0, timedOut: false, durationMs: 1, text: "", sessionId,
      usage: { input: 100, cacheRead: 1000, cacheWrite: 50, output: 20, requests: 1, contextTokens: 1150 },
      ...out,
    };
  };
  return { calls, runTurn };
}

const done = (summary = "did it") => ({ structured: { status: "done", summary, files_changed: [], decisions: [], questions: [] } });
const approve = { structured: { decision: "approve", notes: "", followups: [] } };
const taskId = (prompt: string): string | undefined => /# Task (\S+):|Task (\S+) is not done yet/.exec(prompt)?.slice(1).find(Boolean);

function runner(planFile: string, runTurn: (r: TurnRequest) => Promise<TurnResult>, events: RunnerEvent[] = []) {
  const r = new PlanRunner({ repo, planFile, store, config: { ...DEFAULT_CONFIG, maxAttempts: 2 }, worktreeRoot: join(root, "wt"),
    skillsRoot: join(root, "no-skills"), deps: { runTurn, sleep: async () => undefined, installDeps: async (cwd) => { installs.push(cwd); return { ok: true, output: "" }; } } });
  r.on("event", (e: RunnerEvent) => { if (e.type !== "line") events.push(e); });
  return r;
}

describe("plan runner", { timeout: 90_000 }, () => {
  it("runs tasks across agents, one session per agent, reviews per author, then merges", async () => {
    const plan = writePlan([
      task("T1", "Codex one", `agent: codex\ngoal: one\nwrite_scope: [src/T1.txt]`),
      task("T2", "Small", `role: small\ngoal: two\nwrite_scope: [src/T2.txt]`),
      task("T3", "Codex two", `agent: codex\ndepends_on: [T1]\ngoal: three\nwrite_scope: [src/T3.txt]\nchecks: ["${contains("src/T1.txt", "one").replaceAll('"', '\\"')}"]`),
    ].join("\n"));
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      const id = taskId(req.prompt)!;
      return { ...done(`${id} ok`), write: { [`src/${id}.txt`]: id === "T1" ? "one" : id } };
    });
    const r = runner(plan, runTurn);
    expect(await r.run()).toBe("ready");

    const planBranch = "harness/demo";
    expect(sh(repo, "show", `${planBranch}:src/T3.txt`)).toBe("T3");
    expect(sh(repo, "log", "--format=%s", planBranch)).toMatch(/Merge T1: Codex one/);
    const file = readFileSync(plan, "utf8");
    expect(file).toContain("- [x] **T1 — Codex one**");
    expect(file).toContain("- [x] **T3 — Codex two**");

    // Codex's second task resumed its first task's session.
    const codexTasks = calls.filter((c) => c.agent === "codex" && c.prompt.startsWith("# Task"));
    expect(codexTasks.map((c) => c.resumeSession)).toEqual([undefined, "codex-session-1"]);
    // T2 is a small task: first routing choice is a free OpenCode model, with a fenced result.
    expect(calls.find((c) => c.prompt.includes("# Task T2"))?.agent).toBe("opencode");
    // Each author reviewed once, by a different agent, read-only.
    const reviews = calls.filter((c) => c.prompt.startsWith("Review the changes"));
    expect(reviews.map((c) => [c.agent, c.readOnly])).toEqual(expect.arrayContaining([["claude", true], ["codex", true]]));
    expect(reviews.every((c) => c.resumeSession === undefined)).toBe(true);

    await r.mergeToBase();
    expect(readFileSync(join(repo, "src", "T2.txt"), "utf8")).toBe("T2");
    expect(sh(repo, "branch", "--list", "harness/*")).toBe("");
    expect(sh(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(store.plan(KEY())?.status).toBe("merged");
  });

  it("feeds filtered check failures back into the same session until they pass", async () => {
    const plan = writePlan(task("T1", "Fix me", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]\nchecks: ["${contains("src/T1.txt", "good").replaceAll('"', '\\"')}"]`));
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      return { ...done(), write: { "src/T1.txt": req.prompt.includes("not done yet") ? "good" : "bad" } };
    });
    expect(await runner(plan, runTurn).run()).toBe("ready");
    const fix = calls.find((c) => c.prompt.includes("Task T1 is not done yet"))!;
    expect(fix.prompt).toContain("checks failed");
    expect(fix.resumeSession).toBe("codex-session-1");
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "done", attempts: 1 });
  });

  it("reverts changes outside the write scope without spending a turn", async () => {
    const plan = writePlan(task("T1", "Scoped", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`));
    const events: RunnerEvent[] = [];
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      return { ...done(), write: { "src/T1.txt": "ok", "src/other.txt": "oops", "src/base.txt": "changed" } };
    });
    expect(await runner(plan, runTurn, events).run()).toBe("ready");
    expect(calls.filter((c) => c.prompt.includes("Task T1"))).toHaveLength(1);
    expect(sh(repo, "ls-tree", "-r", "--name-only", "harness/demo", "src")).toBe("src/T1.txt\nsrc/base.txt");
    expect(sh(repo, "show", "harness/demo:src/base.txt")).toBe("base");
    expect(events.some((e) => e.type === "info" && /reverted changes outside your write scope/.test(e.message))).toBe(true);
  });

  it("escalates a stuck task once, pauses it for the human, and keeps independent work going", async () => {
    const plan = writePlan([
      task("T1", "Stuck", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]\nchecks: ['node -e "process.exit(1)"']`),
      task("T2", "Dependent", `agent: codex\ndepends_on: [T1]\ngoal: g\nwrite_scope: [src/T2.txt]`),
      task("T3", "Independent", `agent: claude\ngoal: g\nwrite_scope: [src/T3.txt]`),
    ].join("\n"));
    const events: RunnerEvent[] = [];
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("You are the orchestrator")) return { structured: { action: "human", agent: "", guidance: "needs a product decision" } };
      if (req.prompt.startsWith("Review the changes")) return approve;
      const id = taskId(req.prompt)!;
      return { ...done(), write: { [`src/${id}.txt`]: id } };
    });
    expect(await runner(plan, runTurn, events).run()).toBe("paused");
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "paused", orchestrated: true });
    expect(store.task(KEY(), "T2")?.status).toBe("pending");
    expect(store.task(KEY(), "T3")?.status).toBe("done");
    // Codex was asked first, then Opus (Codex said human).
    expect(calls.filter((c) => c.prompt.startsWith("You are the orchestrator")).map((c) => [c.agent, c.model.model, c.readOnly]))
      .toEqual([["codex", "gpt-6.1-sol", true], ["claude", "claude-opus-5-5", true]]);
    expect(readFileSync(plan, "utf8")).toMatch(/- \[ \] \*\*T1 — Stuck\*\* ⏸ needs you: checks failed/);
    expect(events.some((e) => e.type === "needs-you" && e.taskId === "T1")).toBe(true);
  });

  it("lets the orchestrator reassign a stuck task", async () => {
    const plan = writePlan(task("T1", "Hard one", `agent: opencode\ngoal: g\nwrite_scope: [src/T1.txt]\nchecks: ["${contains("src/T1.txt", "good").replaceAll('"', '\\"')}"]`));
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("You are the orchestrator")) return { structured: { action: "reassign", agent: "codex", guidance: "write good" } };
      if (req.prompt.startsWith("Review the changes")) return approve;
      return { ...done(), write: { "src/T1.txt": req.agent === "codex" ? "good" : "bad" } };
    });
    expect(await runner(plan, runTurn).run()).toBe("ready");
    const codexBrief = calls.find((c) => c.agent === "codex" && c.prompt.startsWith("# Task T1"))!;
    expect(codexBrief.prompt).toContain("## Guidance\nwrite good");
    expect(store.task(KEY(), "T1")?.agent).toBe("codex");
  });

  it("continues a same-agent retry in place: same session, work kept, only the guidance sent", async () => {
    const plan = writePlan(task("T1", "Blocked once", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt, src/T1b.txt]`));
    let briefs = 0;
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("You are the orchestrator")) return { structured: { action: "retry", agent: "", guidance: "use the default" } };
      if (req.prompt.startsWith("Review the changes")) return approve;
      if (req.prompt.startsWith("# Task T1")) {
        briefs++;
        return { structured: { status: "blocked", summary: "half done", files_changed: [], decisions: [], questions: ["which default?"] }, write: { "src/T1.txt": "first half" } };
      }
      return { ...done(), write: { "src/T1b.txt": "second half" } };
    });
    expect(await runner(plan, runTurn).run()).toBe("ready");
    expect(briefs).toBe(1);
    const retry = calls.find((c) => c.prompt.includes("the orchestrator looked at your report"))!;
    expect(retry.prompt).toContain("Guidance: use the default");
    expect(retry.resumeSession).toBe("codex-session-1");
    expect(sh(repo, "show", "harness/demo:src/T1.txt")).toBe("first half");
    expect(sh(repo, "show", "harness/demo:src/T1b.txt")).toBe("second half");
  });

  it("falls back to the next agent when one hits its usage limit", async () => {
    const plan = writePlan(task("T1", "Small", `role: small\ngoal: g\nwrite_scope: [src/T1.txt]`));
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      if (req.agent === "opencode") return { code: 1, usageLimit: { resetAt: null, message: "limit reached" }, structured: undefined };
      return { ...done(), write: { "src/T1.txt": "x" } };
    });
    expect(await runner(plan, runTurn).run()).toBe("ready");
    expect(calls.filter((c) => c.prompt.includes("# Task T1")).map((c) => c.agent)).toEqual(["opencode", "codex"]);
  });

  it("'Review again' after a failed fix redoes the fix first, then reviews once more", async () => {
    const plan = writePlan(task("T1", "Stubborn", `agent: codex
goal: g
write_scope: [src/T1.txt]`));
    let reviews = 0;
    let fixes = 0;
    const { runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) {
        reviews++;
        return reviews === 1 ? { structured: { decision: "request-changes", notes: "add the missing part", followups: [] } } : approve;
      }
      if (req.prompt.includes("reviewer requested changes")) {
        fixes++;
        // The first fix dies (like the wrongly killed turn); the human's retry must redo it, not just re-review.
        if (fixes === 1) return { code: 1, aborted: "killed", structured: undefined };
        return { ...done(), write: { "src/T1.txt": "fixed" } };
      }
      return { ...done(), write: { "src/T1.txt": "x" } };
    });
    const r = runner(plan, runTurn);
    expect(await r.run()).toBe("paused");
    expect([reviews, fixes]).toEqual([1, 1]);
    r.resolveReview("codex", "retry");
    expect(await r.run()).toBe("ready");
    expect([reviews, fixes]).toEqual([2, 2]);
    expect(store.reviews(KEY(), "codex").map((v) => v.decision)).toEqual(["request-changes", "approve"]);
    expect(sh(repo, "show", "harness/demo:src/T1.txt")).toBe("fixed");
  });

  it("runs one review fix round in the author's session, then re-reviews", async () => {
    const plan = writePlan(task("T1", "Reviewed", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`));
    let reviews = 0;
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) {
        reviews++;
        return reviews === 1 ? { structured: { decision: "request-changes", notes: "add a newline", followups: [] } } : approve;
      }
      return { ...done(), write: { "src/T1.txt": req.prompt.includes("reviewer requested changes") ? "x\n" : "x" } };
    });
    expect(await runner(plan, runTurn).run()).toBe("ready");
    expect(store.reviews(KEY(), "codex").map((r) => r.decision)).toEqual(["request-changes", "approve"]);
    const fix = calls.find((c) => c.prompt.includes("reviewer requested changes"))!;
    expect(fix.resumeSession).toBe("codex-session-1");
    expect(calls.filter((c) => c.prompt.startsWith("Review the changes")).at(-1)?.prompt).toContain("Review fixes (codex)");
  });

  it("links ignored dependency folders into worktrees, and never deletes them on cleanup", async () => {
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    sh(repo, "add", ".gitignore");
    sh(repo, "commit", "-q", "-m", "ignore deps");
    mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    const needsDep = `node -e "require('./node_modules/dep')"`;
    const plan = writePlan(task("T1", "Uses deps", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]\nchecks: ["${needsDep.replaceAll('"', '\\"')}"]`),
      `checks: ["${needsDep.replaceAll('"', '\\"')}"]`);
    const { runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      // An agent "reinstalls": wipes its node_modules and writes a fresh one (what npm ci does).
      rmSync(join(req.cwd, "node_modules"), { recursive: true, force: true });
      return { ...done(), write: { "src/T1.txt": "x", "node_modules/dep/index.js": "module.exports = 2;\n" } };
    });
    const r = runner(plan, runTurn);
    expect(await r.run()).toBe("ready");
    await r.mergeToBase();
    // The main checkout's dependencies are untouched, and every worktree was removed.
    expect(readFileSync(join(repo, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(sh(repo, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("re-runs plan checks when a fix adds no commit, and still reviews the task's merged commit", async () => {
    const flag = join(root, "env-ready");
    const planCheck = `node -e "require('fs').statSync(process.argv[1])" ${flag.replaceAll("\\", "/")}`;
    const plan = writePlan(task("T1", "Env", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]\nchecks: ['${PASS}']`),
      `checks: ["${planCheck.replaceAll('"', '\\"')}"]`);
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      if (req.prompt.includes("plan checks failed after merging")) {
        writeFileSync(flag, "ok"); // fixes the environment, changes nothing in git
        return done();
      }
      return { ...done(), write: { "src/T1.txt": "x" } };
    });
    expect(await runner(plan, runTurn).run()).toBe("ready");
    const sha = store.task(KEY(), "T1")?.commitSha;
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const review = calls.find((c) => c.prompt.startsWith("Review the changes"))!;
    expect(review.prompt).toContain(`commit ${sha}`);
    expect(store.reviews(KEY(), "codex")).toHaveLength(1);
  });

  it("reverts edits a worker makes in the plan worktree", async () => {
    const plan = writePlan(task("T1", "Stray", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`));
    const events: RunnerEvent[] = [];
    const { runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      writeFileSync(join(root, "wt", "plan", "src", "stray.txt"), "nope");
      return { ...done(), write: { "src/T1.txt": "x" } };
    });
    expect(await runner(plan, runTurn, events).run()).toBe("ready");
    expect(sh(repo, "ls-tree", "-r", "--name-only", "harness/demo", "src")).not.toContain("stray.txt");
    expect(events.some((e) => e.type === "info" && /changed the plan worktree outside its own; reverted/.test(e.message))).toBe(true);
  });

  it("resumes a paused task at once, without disturbing work in flight, and restores its parked work", async () => {
    const plan = writePlan([
      task("T1", "Blocked", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt, src/T1b.txt]`),
      task("T2", "Slow", `agent: claude\ngoal: g\nwrite_scope: [src/T2.txt]`),
    ].join("\n"));
    let releaseT2!: () => void;
    const t2Gate = new Promise<void>((r) => { releaseT2 = r; });
    let resumedSawWork: string | null = null;
    const calls: TurnRequest[] = [];
    const usage = { input: 1, cacheRead: 1, cacheWrite: 1, output: 1, requests: 1, contextTokens: 3 };
    const base = { code: 0, timedOut: false, durationMs: 1, text: "", usage };
    const runTurn = async (req: TurnRequest): Promise<TurnResult> => {
      calls.push(req);
      const sessionId = req.resumeSession ?? `${req.agent}-s${calls.length}`;
      if (req.prompt.startsWith("You are the orchestrator")) return { ...base, sessionId, structured: { action: "human", agent: "", guidance: "needs vite" } };
      if (req.prompt.startsWith("Review the changes")) return { ...base, sessionId, ...approve };
      if (req.prompt.startsWith("# Task T2")) {
        await t2Gate;
        writeFileSync(join(req.cwd, "src", "T2.txt"), "T2");
        return { ...base, sessionId, ...done() };
      }
      if (req.prompt.startsWith("# Task T1")) {
        writeFileSync(join(req.cwd, "src", "T1.txt"), "first half");
        return { ...base, sessionId, structured: { status: "blocked", summary: "half", files_changed: [], decisions: [], questions: ["vite missing"] } };
      }
      // The resumed turn: its earlier work must already be back in the tree.
      try { resumedSawWork = readFileSync(join(req.cwd, "src", "T1.txt"), "utf8"); } catch { resumedSawWork = null; }
      writeFileSync(join(req.cwd, "src", "T1b.txt"), "second half");
      return { ...base, sessionId, ...done() };
    };
    const r = runner(plan, runTurn);
    const running = r.run();
    await expect.poll(() => store.task(KEY(), "T1")?.status, { timeout: 30_000 }).toBe("paused");
    expect(store.task(KEY(), "T2")?.status).toBe("running");

    await r.prepare(); // what the app's Resume handler does first
    r.resumeTask("T1", { guidance: "deps are linked now" });
    expect(store.task(KEY(), "T2")?.status).toBe("running");
    // T1 restarts while T2 is still mid-turn.
    await expect.poll(() => store.task(KEY(), "T1")?.status, { timeout: 30_000 }).toBe("done");
    expect(store.task(KEY(), "T2")?.status).toBe("running");
    releaseT2();
    expect(await running).toBe("ready");

    expect(resumedSawWork).toBe("first half");
    const resumed = calls.find((c) => c.prompt.includes("the human answered"))!;
    expect(resumed.prompt).toContain("Guidance: deps are linked now");
    expect(resumed.resumeSession).toBe("codex-s1");
    expect(sh(repo, "show", "harness/demo:src/T1.txt")).toBe("first half");
    expect(sh(repo, "show", "harness/demo:src/T1b.txt")).toBe("second half");
    expect(calls.filter((c) => c.prompt.startsWith("# Task T1"))).toHaveLength(1);
  });

  it("keeps dev dependencies an agent adds, and reverts production ones the plan did not list", async () => {
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "g", dependencies: { a: "1.0.0" } }, null, 2));
    sh(repo, "add", "package.json");
    sh(repo, "commit", "-q", "-m", "manifest");
    const plan = writePlan([
      task("T1", "Dev dep", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`),
      task("T2", "Prod dep", `agent: claude\ndepends_on: [T1]\ngoal: g\nwrite_scope: [src/T2.txt]`),
    ].join("\n"));
    const manifest = (extra: object): string => JSON.stringify({ name: "g", ...extra }, null, 2);
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      if (req.prompt.startsWith("# Task T1")) return { ...done(), write: { "src/T1.txt": "x", "package.json": manifest({ dependencies: { a: "1.0.0" }, devDependencies: { playwright: "^1" } }) } };
      if (req.prompt.startsWith("# Task T2")) return { ...done(), write: { "src/T2.txt": "x", "package.json": manifest({ dependencies: { a: "1.0.0", lodash: "4" }, devDependencies: { playwright: "^1" } }) } };
      return { ...done(), write: { "src/T2.txt": "fixed" } };
    });
    expect(await runner(plan, runTurn).run()).toBe("ready");
    const merged = JSON.parse(sh(repo, "show", "harness/demo:package.json")) as { dependencies: object; devDependencies: object };
    expect(merged.devDependencies).toEqual({ playwright: "^1" });
    expect(merged.dependencies).toEqual({ a: "1.0.0" });
    // The plan worktree installed the new dev dependency before running the plan checks.
    expect(installs.some((p) => p.replaceAll("\\", "/").endsWith("/wt/plan"))).toBe(true);
    // T2's production dependency was reverted by the engine, without a turn spent asking.
    expect(calls.filter((c) => c.prompt.includes("Task T2"))).toHaveLength(1);
  });

  it("refuses a bare resume of a blocked question, and lets you skip a task", async () => {
    const plan = writePlan([
      task("T1", "Asks", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`),
      task("T2", "After", `agent: codex\ndepends_on: [T1]\ngoal: g\nwrite_scope: [src/T2.txt]`),
    ].join("\n"));
    const { runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("You are the orchestrator")) return { structured: { action: "human", agent: "", guidance: "ask the user" } };
      if (req.prompt.startsWith("Review the changes")) return approve;
      if (req.prompt.includes("Task T1")) return { structured: { status: "blocked", summary: "?", files_changed: [], decisions: [], questions: ["which one?"] } };
      return { ...done(), write: { "src/T2.txt": "x" } };
    });
    const r = runner(plan, runTurn);
    expect(await r.run()).toBe("paused");
    expect(() => r.resumeTask("T1")).toThrow(/waiting for an answer/);
    expect(() => r.resumeTask("T1", { guidance: "   " })).toThrow(/waiting for an answer/);
    r.skipTask("T1");
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "done", summary: "Skipped by you." });
    expect(readFileSync(plan, "utf8")).toContain("- [x] **T1 — Asks**");
    expect(await r.run()).toBe("ready");
    expect(store.task(KEY(), "T2")?.status).toBe("done");
  });

  it("refuses to start an invalid plan", async () => {
    const plan = writePlan(task("T1", "Bad", `agent: gemini\ngoal: g\nwrite_scope: [src/T1.txt]`));
    await expect(runner(plan, fakeTurns(() => done()).runTurn).prepare()).rejects.toThrow(/unknown agent gemini/);
  });
});
