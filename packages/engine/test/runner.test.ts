import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnRequest, TurnResult } from "../src/agents/turn.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { PlanRunner, type RunnerDeps, type RunnerEvent } from "../src/engine/runner.js";
import { Store } from "../src/store/store.js";
import { parsePlan } from "../src/plan/plan.js";

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

type Reply = Partial<TurnResult> & { write?: Record<string, string> };
type Script = (req: TurnRequest, call: number) => Reply | Promise<Reply>;

/** A scripted agent: writes files into its cwd and answers with a structured result. */
function fakeTurns(script: Script) {
  const calls: TurnRequest[] = [];
  let n = 0;
  const runTurn = async (req: TurnRequest): Promise<TurnResult> => {
    calls.push(req);
    const call = n++;
    const out = await script(req, call);
    for (const [file, text] of Object.entries(out.write ?? {})) {
      mkdirSync(join(req.cwd, file, ".."), { recursive: true });
      writeFileSync(join(req.cwd, file), text);
    }
    const sessionId = req.resumeSession ?? `${req.agent}-session-${call + 1}`;
    return {
      code: 0, timedOut: false, durationMs: 1, text: "", sessionId,
      usage: { input: 100, cacheRead: 1000, cacheWrite: 50, output: 20, requests: 1, contextTokens: 1150 },
      ...out,
    };
  };
  return { calls, runTurn };
}

/** A turn that runs until the task is stopped, then reports what a killed process reports. */
const untilStopped = (req: TurnRequest): Promise<Reply> => new Promise((resolve) => {
  const stop = (): void => resolve({ code: 125, aborted: "stopped by you", structured: undefined });
  if (req.signal?.aborted) stop();
  else req.signal?.addEventListener("abort", stop, { once: true });
});
const done = (summary = "did it") => ({ structured: { status: "done", summary, files_changed: [], decisions: [], questions: [] } });
const approve = { structured: { decision: "approve", notes: "", followups: [] } };
const taskId = (prompt: string): string | undefined => /# Task (\S+):|Task (\S+) is not done yet/.exec(prompt)?.slice(1).find(Boolean);

function runner(planFile: string, runTurn: (r: TurnRequest) => Promise<TurnResult>, events: RunnerEvent[] = [], deps: Partial<RunnerDeps> = {}) {
  const r = new PlanRunner({ repo, planFile, store, config: { ...DEFAULT_CONFIG, maxAttempts: 2 }, worktreeRoot: join(root, "wt"),
    skillsRoot: join(root, "no-skills"), deps: { runTurn, sleep: async () => undefined, installDeps: async (cwd) => { installs.push(cwd); return { ok: true, output: "" }; }, ...deps } });
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
      const threadTotals = req.agent === "codex" ? { threadTotals: { input: 500, cached: 400, cacheWrite: 0, output: 10 } } : {};
      return { ...done(`${id} ok`), ...threadTotals, write: { [`src/${id}.txt`]: id === "T1" ? "one" : id } };
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
    // Codex reports thread totals: the resumed turn gets the first turn's totals to subtract.
    expect(codexTasks[1]?.threadTotals).toEqual({ input: 500, cached: 400, cacheWrite: 0, output: 10 });
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

  it("discards a plan without merging: worktrees and unmerged branches go, the base branch is untouched", async () => {
    const plan = writePlan(task("T1", "Throwaway", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`));
    const { runTurn } = fakeTurns((req) => req.prompt.startsWith("Review the changes") ? approve : { ...done(), write: { "src/T1.txt": "x" } });
    const r = runner(plan, runTurn);
    expect(await r.run()).toBe("ready");
    expect(sh(repo, "branch", "--list", "harness/*")).not.toBe("");

    expect(await r.discard()).toEqual([]);
    expect(sh(repo, "branch", "--list", "harness/*")).toBe("");
    expect(sh(repo, "worktree", "list").split("\n")).toHaveLength(1);
    expect(existsSync(join(repo, "src", "T1.txt"))).toBe(false);
    expect(store.plan(KEY())?.status).toBe("discarded");
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

  it("asks you before keeping out-of-scope files the agent says it needs; allowing them widens the scope", async () => {
    const plan = writePlan(task("T1", "Needs more", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`));
    const events: RunnerEvent[] = [];
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      if (req.prompt.includes("the human answered")) return done("finished");
      return { structured: { status: "done", summary: "fixed the core", files_changed: ["src/T1.txt", "./src/core.txt"], decisions: [], questions: [] },
        write: { "src/T1.txt": "item", "src/core.txt": "fix", "src/noise.txt": "oops" } };
    });
    const r = runner(plan, runTurn, events);
    // The core fix is not silently reverted while the task passes on what is left.
    expect(await r.run()).toBe("paused");
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "waiting", scopeRequest: ["src/core.txt"] });
    expect(r.snapshot().tasks[0]?.scopeRequest).toEqual(["src/core.txt"]);
    expect(events.some((e) => e.type === "needs-you" && /outside its write scope: src\/core\.txt/.test(e.message))).toBe(true);

    r.resumeTask("T1", { allowScope: true });
    expect(await r.run()).toBe("ready");
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "done", extraScope: ["src/core.txt"], scopeRequest: [] });
    expect(sh(repo, "show", "harness/demo:src/core.txt")).toBe("fix");
    // Unlisted noise is still reverted without asking.
    expect(sh(repo, "ls-tree", "-r", "--name-only", "harness/demo", "src")).not.toContain("noise.txt");
    expect(calls.find((c) => c.prompt.includes("the human answered"))?.prompt).toContain("allowed these files beyond your write scope: src/core.txt");
    expect(r.snapshot().tasks[0]?.writeScope).toEqual(["src/T1.txt", "src/core.txt"]);
  });

  it("resuming without allowing reverts the out-of-scope files and does not ask again", async () => {
    const plan = writePlan(task("T1", "Declined", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`));
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      return { structured: { status: "done", summary: "s", files_changed: ["src/T1.txt", "src/core.txt"], decisions: [], questions: [] },
        write: { "src/T1.txt": "item", "src/core.txt": "fix" } };
    });
    const r = runner(plan, runTurn);
    expect(await r.run()).toBe("paused");
    r.resumeTask("T1");
    expect(await r.run()).toBe("ready");
    expect(sh(repo, "ls-tree", "-r", "--name-only", "harness/demo", "src")).not.toContain("core.txt");
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "done", extraScope: [], scopeRequest: [] });
    expect(calls.find((c) => c.prompt.includes("the human answered"))?.prompt).toContain("did not allow changes to src/core.txt");
  });

  it("a review fix that needs out-of-scope files waits for you, keeps its edits, and lands once allowed", async () => {
    const plan = writePlan(task("T1", "Reviewed", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`));
    let reviews = 0;
    let fixes = 0;
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) {
        reviews++;
        return reviews === 1 ? { structured: { decision: "request-changes", notes: "the item does nothing; fix the core", followups: [] } } : approve;
      }
      if (req.prompt.includes("reviewer requested changes")) {
        fixes++;
        // The second fix only finishes: its first attempt's edits must be back in the tree.
        if (fixes === 2) return done("kept the core fix");
        return { structured: { status: "done", summary: "fixed core", files_changed: ["src/core.txt"], decisions: [], questions: [] }, write: { "src/core.txt": "fix" } };
      }
      return { ...done(), write: { "src/T1.txt": "item" } };
    });
    const r = runner(plan, runTurn);
    expect(await r.run()).toBe("paused");
    expect(r.reviewStates()[0]).toMatchObject({ state: "needs-you", scopeRequest: ["src/core.txt"] });
    expect(r.reviewStates()[0]?.why).toMatch(/outside the write scope.*src\/core\.txt/);

    r.resolveReview("codex", "retry", { allowScope: true });
    expect(await r.run()).toBe("ready");
    expect(sh(repo, "show", "harness/demo:src/core.txt")).toBe("fix");
    expect(store.task(KEY(), "T1")?.extraScope).toEqual(["src/core.txt"]);
    const second = calls.filter((c) => c.prompt.includes("reviewer requested changes"))[1]!;
    expect(second.prompt).toContain("Your previous fix attempt is back in the work tree.");
    expect(second.prompt).toContain("allowed these files beyond your write scope: src/core.txt");
  });

  it("a blocked review fix tells you what the agent asked", async () => {
    const plan = writePlan(task("T1", "Reviewed", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`));
    const { runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return { structured: { decision: "request-changes", notes: "n", followups: [] } };
      if (req.prompt.includes("reviewer requested changes")) {
        return { structured: { status: "blocked", summary: "s", files_changed: [], decisions: [], questions: ["Can the scope include src/core.txt?"] } };
      }
      return { ...done(), write: { "src/T1.txt": "item" } };
    });
    const r = runner(plan, runTurn);
    expect(await r.run()).toBe("paused");
    expect(r.reviewStates()[0]?.why).toBe("codex is blocked on the review findings: Can the scope include src/core.txt?");
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
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "waiting", orchestrated: true });
    expect(store.task(KEY(), "T2")?.status).toBe("queued");
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

  it("lets the orchestrator amend a check that cannot run, in memory and in the plan file", async () => {
    const plan = writePlan(task("T1", "Unrunnable check", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]\nchecks: ["no-such-tool-xyz --boss"]`));
    const events: RunnerEvent[] = [];
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("You are the orchestrator")) {
        return { structured: { action: "amend", agent: "", guidance: "the tool does not exist; the check now uses node", checks: ['node -e "process.exit(0)"'] } };
      }
      if (req.prompt.startsWith("Review the changes")) return approve;
      if (req.prompt.startsWith("# Task T1")) {
        return { structured: { status: "blocked", summary: "s", files_changed: [], decisions: [], questions: ["no-such-tool-xyz is not installed; the check cannot run"] }, write: { "src/T1.txt": "work" } };
      }
      return done();
    });
    expect(await runner(plan, runTurn, events).run()).toBe("ready");
    const orchestrator = calls.find((c) => c.prompt.startsWith("You are the orchestrator"))!;
    expect(orchestrator.prompt).toContain("`no-such-tool-xyz --boss`");
    const retry = calls.find((c) => c.prompt.includes("the orchestrator looked at your report"))!;
    expect(retry.prompt).toContain('The engine now runs these checks for this task:');
    expect(retry.prompt).toContain('process.exit(0)');
    expect(sh(repo, "show", "harness/demo:src/T1.txt")).toBe("work");
    expect(parsePlan(readFileSync(plan, "utf8")).plan.tasks[0].checks).toEqual(['node -e "process.exit(0)"']);
    expect(events.some((e) => e.type === "info" && e.message.startsWith("T1: orchestrator changed the checks"))).toBe(true);
  });

  it("grants image generation itself when the orchestrator asks, and keeps it in the plan file", async () => {
    const plan = writePlan(task("T1", "Icons", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`));
    const events: RunnerEvent[] = [];
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("You are the orchestrator")) return { structured: { action: "retry", agent: "", guidance: "image_gen is on now", checks: [], grant: ["images"] } };
      if (req.prompt.startsWith("Review the changes")) return approve;
      if (req.prompt.startsWith("# Task T1")) {
        return { structured: { status: "blocked", summary: "s", files_changed: [], decisions: [], questions: ["image_gen is not enabled"] } };
      }
      return { ...done(), write: { "src/T1.txt": "icon" } };
    });
    expect(await runner(plan, runTurn, events).run()).toBe("ready");
    const orchestrator = calls.find((c) => c.prompt.startsWith("You are the orchestrator"))!;
    expect(orchestrator.prompt).toContain("images: Codex image generation (image_gen)");
    expect(calls.find((c) => c.prompt.startsWith("# Task T1"))?.imageGeneration).toBeFalsy();
    expect(calls.find((c) => c.prompt.includes("the orchestrator looked at your report"))?.imageGeneration).toBe(true);
    expect(parsePlan(readFileSync(plan, "utf8")).plan.tasks[0].images).toBe(true);
    expect(events.some((e) => e.type === "info" && e.message.startsWith("T1: granted Codex image generation"))).toBe(true);
  });

  it("refuses an amend that drops a check and pauses for the human", async () => {
    const plan = writePlan(task("T1", "Two checks", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]\nchecks: ["node -e \\"process.exit(0)\\"", "no-such-tool-xyz"]`));
    const { runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("You are the orchestrator")) return { structured: { action: "amend", agent: "", guidance: "drop it", checks: ['node -e "process.exit(0)"'] } };
      if (req.prompt.startsWith("Review the changes")) return approve;
      return { structured: { status: "blocked", summary: "s", files_changed: [], decisions: [], questions: ["the check cannot run"] } };
    });
    expect(await runner(plan, runTurn).run()).toBe("paused");
    expect(store.task(KEY(), "T1")?.status).toBe("waiting");
    expect(parsePlan(readFileSync(plan, "utf8")).plan.tasks[0].checks).toHaveLength(2);
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
    const r = runner(plan, runTurn);
    const states: string[] = [];
    r.on("event", () => { const s = r.reviewStates()[0]?.state; if (s && s !== states.at(-1)) states.push(s); });
    expect(await r.run()).toBe("ready");
    // The board sees the fix as running work, never as something that needs you.
    expect(states).toEqual(expect.arrayContaining(["reviewing", "fixing"]));
    expect(states).not.toContain("needs-you");
    expect(r.reviewStates()).toEqual([{ agent: "codex", state: "approved", reviewer: "claude", round: 2, why: null, tasks: ["T1"], scopeRequest: [] }]);
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

  it("installs in worktrees whose copied dependencies miss a locked package, and keeps tool metadata unshared", async () => {
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "g", devDependencies: { dep: "1.0.0" } }));
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/dep": { version: "1.0.0" } } }));
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "deps");
    // The main checkout's npm record claims dep, but dep itself is missing.
    mkdirSync(join(repo, "node_modules"), { recursive: true });
    writeFileSync(join(repo, "node_modules", ".package-lock.json"), "main record\n");
    const plan = writePlan(task("T1", "T", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`));
    const { runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      // A tool rewrites its metadata in place (no unlink), as npm does with its record.
      writeFileSync(join(req.cwd, "node_modules", ".package-lock.json"), "worktree record\n");
      return { ...done(), write: { "src/T1.txt": "x" } };
    });
    expect(await runner(plan, runTurn).run()).toBe("ready");
    const ends = installs.map((p) => p.replaceAll("\\", "/").split("/").pop());
    expect(ends).toEqual(expect.arrayContaining(["plan", "codex"]));
    expect(readFileSync(join(repo, "node_modules", ".package-lock.json"), "utf8")).toBe("main record\n");
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
      // Session ids by agent, not call order: T1 and T2 start concurrently.
      const sessionId = req.resumeSession ?? `${req.agent}-s${calls.filter((c) => c.agent === req.agent).length}`;
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
    await expect.poll(() => store.task(KEY(), "T1")?.status, { timeout: 30_000 }).toBe("waiting");
    expect(store.task(KEY(), "T2")?.status).toBe("working");

    await r.prepare(); // what the app's Resume handler does first
    r.resumeTask("T1", { guidance: "deps are linked now" });
    expect(store.task(KEY(), "T2")?.status).toBe("working");
    // T1 restarts while T2 is still mid-turn.
    await expect.poll(() => store.task(KEY(), "T1")?.status, { timeout: 30_000 }).toBe("done");
    expect(store.task(KEY(), "T2")?.status).toBe("working");
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
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "skipped", summary: "Skipped by you." });
    expect(readFileSync(plan, "utf8")).toContain("- [x] **T1 — Asks**");
    expect(await r.run()).toBe("ready");
    expect(store.task(KEY(), "T2")?.status).toBe("done");
  });

  it("stops a working task: kills the turn, parks its edits, holds its dependents, keeps others going; Resume restores them", async () => {
    const plan = writePlan([
      task("T1", "Long", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt, src/T1b.txt]`),
      task("T2", "After", `agent: codex\ndepends_on: [T1]\ngoal: g\nwrite_scope: [src/T2.txt]`),
      task("T3", "Independent", `agent: claude\ngoal: g\nwrite_scope: [src/T3.txt]`),
    ].join("\n"));
    let resumedSaw: string | null = null;
    const { calls, runTurn } = fakeTurns(async (req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      if (req.prompt.startsWith("# Task T1")) {
        writeFileSync(join(req.cwd, "src", "T1.txt"), "half");
        return untilStopped(req);
      }
      if (req.prompt.includes("the human answered")) {
        resumedSaw = readFileSync(join(req.cwd, "src", "T1.txt"), "utf8");
        return { ...done(), write: { "src/T1b.txt": "rest" } };
      }
      const id = taskId(req.prompt)!;
      return { ...done(), write: { [`src/${id}.txt`]: id } };
    });
    const r = runner(plan, runTurn);
    const running = r.run();
    await expect.poll(() => calls.some((c) => c.prompt.startsWith("# Task T1")), { timeout: 30_000 }).toBe(true);
    const info = await r.stopInfo("T1");
    expect(info).toMatchObject({ state: "working", agent: "codex", stoppable: true, deferred: false, uncommittedFiles: 1, dependents: ["T2"], tokensSoFar: null });
    expect(info.turnElapsedMs).not.toBeNull();
    r.stopTask("T1");
    expect(await running).toBe("paused");
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "stopped", note: "stopped by you; edits kept on the stash" });
    expect(store.task(KEY(), "T2")?.status).toBe("queued");
    expect(store.task(KEY(), "T3")?.status).toBe("done");
    expect(sh(join(root, "wt", "codex"), "stash", "list", "--format=%gs")).toContain("harnessOrch demo T1 (paused)");
    expect(() => r.stopTask("T1")).toThrow(/only a working, checking or merging task/);

    // The killed turn still reported its session: the resumed turn continues it.
    const session = store.session(KEY(), "codex")?.sessionId;
    expect(session).toBeDefined();
    r.resumeTask("T1");
    expect(await r.run()).toBe("ready");
    expect(resumedSaw).toBe("half");
    expect(calls.find((c) => c.prompt.includes("the human answered"))!.resumeSession).toBe(session);
    expect(sh(repo, "show", "harness/demo:src/T1.txt")).toBe("half");
    expect(store.task(KEY(), "T2")?.status).toBe("done");
  });

  it("Restart clean drops the parked edits and starts from a fresh brief", async () => {
    const plan = writePlan(task("T1", "Again", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt, src/junk.txt]`));
    let briefs = 0;
    let sawJunk = true;
    const { runTurn } = fakeTurns(async (req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      if (req.prompt.startsWith("# Task T1")) briefs++;
      if (briefs === 1) {
        writeFileSync(join(req.cwd, "src", "junk.txt"), "junk");
        return untilStopped(req);
      }
      sawJunk = existsSync(join(req.cwd, "src", "junk.txt"));
      return { ...done(), write: { "src/T1.txt": "clean" } };
    });
    const r = runner(plan, runTurn);
    const running = r.run();
    await expect.poll(() => briefs, { timeout: 30_000 }).toBe(1);
    r.stopTask("T1");
    expect(await running).toBe("paused");
    await r.restartClean("T1");
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "queued", attempts: 0 });
    expect(sh(join(root, "wt", "codex"), "stash", "list", "--format=%gs")).not.toContain("T1 (paused)");
    expect(await r.run()).toBe("ready");
    expect(briefs).toBe(2);
    expect(sawJunk).toBe(false);
  });

  it("stops a task while its check runs, killing the check", async () => {
    const slow = 'node -e "setTimeout(() => {}, 60000)"';
    const plan = writePlan(task("T1", "Checked", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]\nchecks: ['${slow}']`));
    const { runTurn } = fakeTurns((req) => req.prompt.startsWith("Review the changes") ? approve : { ...done(), write: { "src/T1.txt": "x" } });
    const r = runner(plan, runTurn);
    const running = r.run();
    await expect.poll(() => store.task(KEY(), "T1")?.status, { timeout: 30_000 }).toBe("checking");
    const started = Date.now();
    r.stopTask("T1");
    expect(await running).toBe("paused");
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "stopped", attempts: 0 });
  });

  it.each([
    ["pass", "done"],
    ["fail", "stopped"],
  ] as const)("defers a stop during a merge; when the plan checks %s the task ends %s", async (outcome, end) => {
    const gate = join(root, "merge-gate").replaceAll("\\", "/");
    writeFileSync(join(root, "plan-check.cjs"), `const f = require("fs");
setInterval(() => { if (f.existsSync(${JSON.stringify(gate)})) process.exit(${outcome === "pass" ? 0 : 1}); }, 50);\n`);
    const planCheck = `node ${join(root, "plan-check.cjs").replaceAll("\\", "/")}`;
    const plan = writePlan(task("T1", "Merging", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]\nchecks: ['${PASS}']`), `checks: ['${planCheck}']`);
    const { calls, runTurn } = fakeTurns((req) => req.prompt.startsWith("Review the changes") ? approve : { ...done(), write: { "src/T1.txt": "x" } });
    const r = runner(plan, runTurn);
    const running = r.run();
    await expect.poll(() => store.task(KEY(), "T1")?.status, { timeout: 30_000 }).toBe("merging");
    expect((await r.stopInfo("T1")).deferred).toBe(true);
    r.stopTask("T1");
    expect(store.task(KEY(), "T1")?.status).toBe("merging");
    writeFileSync(gate, "");
    await expect.poll(() => store.task(KEY(), "T1")?.status, { timeout: 30_000 }).toBe(end);
    r.stop();
    await running;
    // A failed merge under a pending stop does not start a fix round.
    expect(calls.filter((c) => c.prompt.includes("Task T1 is not done yet"))).toHaveLength(0);
  });

  it("a budget kill is still a fix round, not a stop", async () => {
    const plan = writePlan(task("T1", "Runaway", `agent: claude\ngoal: g\nwrite_scope: [src/T1.txt]`));
    const { runTurn } = fakeTurns((req, n) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      if (n === 0) return { code: 125, aborted: "token budget exceeded (9 > 1 effective tokens)", structured: undefined };
      return { ...done(), write: { "src/T1.txt": "x" } };
    });
    expect(await runner(plan, runTurn).run()).toBe("ready");
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "done", attempts: 1 });
  });

  it("marks tasks left in flight by a closed app interrupted, keeps their edits, and Start continues them", async () => {
    const plan = writePlan([
      task("T1", "Cut off", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt, src/T1b.txt]`),
      task("T2", "After", `agent: codex\ndepends_on: [T1]\ngoal: g\nwrite_scope: [src/T2.txt]`),
    ].join("\n"));
    // The first app session: T1's turn writes half its work and never returns.
    const first = fakeTurns((req) => {
      writeFileSync(join(req.cwd, "src", "T1.txt"), "half");
      return new Promise<Reply>(() => undefined);
    });
    void runner(plan, first.runTurn).run();
    await expect.poll(() => first.calls.length, { timeout: 30_000 }).toBe(1);
    expect(store.task(KEY(), "T1")?.status).toBe("working");

    // The app reopens: a new runner over the same store.
    let restored: string | null = null;
    const second = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      if (req.prompt.includes("Task T1")) {
        restored ??= existsSync(join(req.cwd, "src", "T1.txt")) ? readFileSync(join(req.cwd, "src", "T1.txt"), "utf8") : "";
        return { ...done(), write: { "src/T1b.txt": "rest" } };
      }
      return { ...done(), write: { "src/T2.txt": "x" } };
    });
    const r = runner(plan, second.runTurn);
    await r.prepare();
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "interrupted", note: "codex was working when the app closed; its edits are kept" });
    const lane = join(root, "wt", "codex");
    expect(sh(lane, "status", "--porcelain")).toBe("");
    expect(await r.run()).toBe("ready");
    expect(restored).toBe("half");
    expect(sh(lane, "stash", "list", "--format=%gs")).not.toContain("leftover before T1");
    expect(sh(repo, "show", "harness/demo:src/T1.txt")).toBe("half");
  });

  it("runs setup once when Resume and Start race, so recovery never touches a task it already started", async () => {
    // Stale dependencies make setup slow (it installs), which is the window the live race hit.
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "g", devDependencies: { dep: "1.0.0" } }));
    writeFileSync(join(repo, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/dep": { version: "1.0.0" } } }));
    sh(repo, "add", "-A");
    sh(repo, "commit", "-q", "-m", "deps");
    const plan = writePlan(task("T1", "Cut off", `agent: claude\ngoal: g\nwrite_scope: [src/T1.txt, src/T1b.txt]`));
    const first = fakeTurns((req) => {
      writeFileSync(join(req.cwd, "src", "T1.txt"), "half");
      return new Promise<Reply>(() => undefined);
    });
    void runner(plan, first.runTurn).run();
    await expect.poll(() => first.calls.length, { timeout: 30_000 }).toBe(1);

    // The app reopens. Resume (which prepares) and Start (which runs) are pressed while setup installs.
    const events: RunnerEvent[] = [];
    let restored: string | null = null;
    const second = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      restored ??= existsSync(join(req.cwd, "src", "T1.txt")) ? readFileSync(join(req.cwd, "src", "T1.txt"), "utf8") : "";
      return { ...done(), write: { "src/T1b.txt": "rest" } };
    });
    const slowInstall = async (cwd: string): Promise<{ ok: boolean; output: string }> => {
      installs.push(cwd);
      await new Promise((res) => setTimeout(res, 300));
      return { ok: true, output: "" };
    };
    const r = runner(plan, second.runTurn, events, { installDeps: slowInstall });
    const resumeClick = r.prepare();
    const startClick = r.run();
    await resumeClick;
    expect(await startClick).toBe("ready");
    const t1 = events.filter((e) => e.type === "task" && e.taskId === "T1").map((e) => (e as { status: string }).status);
    // Interrupted once by recovery, then continued; never re-interrupted while running.
    expect(t1.filter((s) => s === "interrupted")).toHaveLength(1);
    expect(t1.indexOf("interrupted")).toBeLessThan(t1.indexOf("working"));
    expect(second.calls.filter((c) => !c.prompt.startsWith("Review the changes"))).toHaveLength(1);
    expect(restored).toBe("half");
  });

  it("an engine error parks the task's edits so Resume restores them", async () => {
    const plan = writePlan(task("T1", "Crashes", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`));
    const { runTurn } = fakeTurns((req) => {
      writeFileSync(join(req.cwd, "src", "T1.txt"), "latest");
      throw new Error("boom");
    });
    expect(await runner(plan, runTurn).run()).toBe("paused");
    expect(store.task(KEY(), "T1")).toMatchObject({ status: "waiting", note: "engine error: boom" });
    expect(sh(join(root, "wt", "codex"), "stash", "list", "--format=%gs")).toContain("harnessOrch demo T1 (paused)");
  });

  it("Stop all stops every task in flight and dispatches nothing new", async () => {
    const plan = writePlan([
      task("T1", "One", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`),
      task("T2", "Two", `agent: claude\ngoal: g\nwrite_scope: [src/T2.txt]`),
      task("T3", "Three", `agent: opencode\ngoal: g\nwrite_scope: [src/T3.txt]`),
    ].join("\n"), `checks: ['${PASS}']\nconcurrency: 2`);
    const { calls, runTurn } = fakeTurns(async (req) => untilStopped(req));
    const r = runner(plan, runTurn);
    const running = r.run();
    await expect.poll(() => calls.length, { timeout: 30_000 }).toBe(2);
    expect(r.stopAll().sort()).toEqual(["T1", "T2"]);
    expect(await running).toBe("stopped");
    await expect.poll(() => [store.task(KEY(), "T1")?.status, store.task(KEY(), "T2")?.status], { timeout: 30_000 }).toEqual(["stopped", "stopped"]);
    expect(store.task(KEY(), "T3")?.status).toBe("queued");
    expect(calls).toHaveLength(2);
  });

  it("after the app closes mid review-fix, redoes the fix before reviewing again", async () => {
    const plan = writePlan(task("T1", "Reviewed", `agent: codex\ngoal: g\nwrite_scope: [src/T1.txt]`));
    // The first app session: the review rejects, and the fix turn dies with the app.
    const first = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return { structured: { decision: "request-changes", notes: "add a newline", followups: [] } };
      if (req.prompt.includes("reviewer requested changes")) return new Promise<Reply>(() => undefined);
      return { ...done(), write: { "src/T1.txt": "x" } };
    });
    void runner(plan, first.runTurn).run();
    await expect.poll(() => first.calls.some((c) => c.prompt.includes("reviewer requested changes")), { timeout: 30_000 }).toBe(true);

    const second = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      return { ...done(), write: { "src/T1.txt": "x\n" } };
    });
    expect(await runner(plan, second.runTurn).run()).toBe("ready");
    const kinds = second.calls.map((c) => (c.prompt.startsWith("Review the changes") ? "review" : c.prompt.includes("reviewer requested changes") ? "fix" : "other"));
    expect(kinds).toEqual(["fix", "review"]);
    expect(store.reviews(KEY(), "codex").map((r) => [r.round, r.decision])).toEqual([[1, "request-changes"], [2, "approve"]]);
  });

  it("sends a task's chosen model and thinking level to its agent", async () => {
    const plan = writePlan([
      task("T1", "Picked", `agent: claude\nmodel: claude-sonnet-5-5\neffort: low\ngoal: g\nwrite_scope: [src/T1.txt]`),
      task("T2", "Routed", `role: hard\neffort: max\ngoal: g\nwrite_scope: [src/T2.txt]`),
    ].join("\n"));
    const { calls, runTurn } = fakeTurns((req) => {
      if (req.prompt.startsWith("Review the changes")) return approve;
      const id = taskId(req.prompt)!;
      return { ...done(), write: { [`src/${id}.txt`]: id } };
    });
    const r = runner(plan, runTurn);
    r.load();
    // The board shows what each task will run on before it starts.
    expect(r.snapshot().tasks.map((t) => [t.id, t.routedModel, t.routedEffort])).toEqual([["T1", "claude-sonnet-5-5", "low"], ["T2", "claude-opus-5-5", "max"]]);
    expect(await r.run()).toBe("ready");
    const brief = (id: string) => calls.find((c) => c.prompt.startsWith(`# Task ${id}`))!.model;
    expect(brief("T1")).toMatchObject({ agent: "claude", model: "claude-sonnet-5-5", effort: "low" });
    expect(brief("T2")).toMatchObject({ agent: "claude", model: "claude-opus-5-5", effort: "max" });
    expect(r.snapshot().modelChoices.claude).toEqual(expect.arrayContaining(["claude-opus-5-5", "claude-sonnet-5-5"]));
  });

  it("refuses to start an invalid plan", async () => {
    const plan = writePlan(task("T1", "Bad", `agent: gemini\ngoal: g\nwrite_scope: [src/T1.txt]`));
    await expect(runner(plan, fakeTurns(() => done()).runTurn).prepare()).rejects.toThrow(/unknown agent gemini/);
  });
});
