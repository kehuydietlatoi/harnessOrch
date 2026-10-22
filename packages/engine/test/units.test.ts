import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { claudeTurnArgs, codexTurnArgs, opencodeTurnArgs, reduceClaude, reduceCodex, reduceOpencodeTurn, structuredFrom } from "../src/agents/turn.js";
import { estimateTokens, parseWorkerResult, renderBrief, renderHandoff, RESULT_SCHEMA } from "../src/brief/brief.js";
import { scopeViolations } from "../src/checks/checks.js";
import { filterCheckOutput } from "../src/checks/filter.js";
import { budgetWatcher, cacheHitRate, effectiveTokens } from "../src/ledger/effective.js";
import { parsePlan } from "../src/plan/plan.js";
import { blockedBy, nextDispatches, type SchedTask } from "../src/scheduler/scheduler.js";
import { Store } from "../src/store/store.js";
// @ts-expect-error plain JS worker-side wrapper, no types
import { filterCheckOutput as hverifyFilter } from "../assets/hverify.mjs";

const j = (o: unknown): string => JSON.stringify(o);

describe("agent turn arguments", () => {
  it("builds the lean Claude worker measured in M0", () => {
    const args = claudeTurnArgs({ model: { model: "claude-sonnet-5-5", effort: "medium" }, schema: { type: "object" } }, { id: "s1", resume: false });
    expect(args).toEqual(expect.arrayContaining(["--setting-sources", "project", "--strict-mcp-config", "--disable-slash-commands", "--session-id", "s1"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Edit,Write,Bash,Grep,Glob");
    expect(args[args.indexOf("--json-schema") + 1]).toBe('{"type":"object"}');
    expect(args).toContain("Bash(git push:*)");
    const review = claudeTurnArgs({ model: {}, readOnly: true }, { id: "s2", resume: true });
    expect(review[review.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(review).not.toContain("acceptEdits");
    expect(review.slice(-2)).toEqual(["--resume", "s2"]);
  });

  it("builds Codex args with unused features off, resume last", () => {
    const args = codexTurnArgs({ model: { model: "gpt-6.1-sol", effort: "medium" }, resumeSession: "t1" }, "/tmp/s.json");
    expect(args.slice(0, 3)).toEqual(["exec", "--json", "--ignore-user-config"]);
    expect(args).toEqual(expect.arrayContaining(["--disable", "multi_agent", "--output-schema", "/tmp/s.json", "--approve-for-me"]));
    expect(args.slice(-3)).toEqual(["resume", "t1", "-"]);
    expect(codexTurnArgs({ model: {}, imageGeneration: true })).not.toContain("image_generation");
    expect(codexTurnArgs({ model: {}, readOnly: true })).toEqual(expect.arrayContaining(["-s", "read-only"]));
  });

  it("requires an explicit OpenCode model and runs it pure", () => {
    expect(() => opencodeTurnArgs({ model: {} })).toThrow(/explicit provider\/model/);
    expect(opencodeTurnArgs({ model: { model: "opencode/x" }, resumeSession: "ses_1" })).toEqual(["run", "--format", "json", "-m", "opencode/x", "-s", "ses_1", "--pure"]);
  });
});

describe("turn reducers", () => {
  it("reads Claude usage, context size and structured output", () => {
    const raw = [
      j({ type: "system", subtype: "init", session_id: "abc" }),
      j({ type: "assistant", message: { usage: { input_tokens: 2, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100 } } }),
      j({ type: "assistant", message: { usage: { input_tokens: 3, cache_read_input_tokens: 6000, cache_creation_input_tokens: 400 } } }),
      j({ type: "result", session_id: "abc", num_turns: 2, result: "ok", structured_output: { status: "done" },
        usage: { input_tokens: 5, cache_read_input_tokens: 11000, cache_creation_input_tokens: 500, output_tokens: 90 } }),
    ].join("\n");
    expect(reduceClaude(raw)).toEqual({ text: "ok", sessionId: "abc", structured: { status: "done" },
      usage: { input: 5, cacheRead: 11000, cacheWrite: 500, output: 90, requests: 2, contextTokens: 6403 } });
  });

  it("reads Codex usage (input includes cached) and the schema answer", () => {
    const raw = [
      j({ type: "thread.started", thread_id: "t-1" }),
      j({ type: "item.completed", item: { type: "command_execution" } }),
      j({ type: "item.completed", item: { type: "agent_message", text: '{"status":"done","summary":"x"}' } }),
      j({ type: "turn.completed", usage: { input_tokens: 26860, cached_input_tokens: 13184, cache_write_input_tokens: 0, output_tokens: 155 } }),
    ].join("\n");
    const r = reduceCodex(raw);
    expect(r.sessionId).toBe("t-1");
    expect(r.structured).toEqual({ status: "done", summary: "x" });
    expect(r.usage).toEqual({ input: 13676, cacheRead: 13184, cacheWrite: 0, output: 155, requests: 2, contextTokens: 13430 });
  });

  it("subtracts a resumed Codex thread's earlier totals (turn.completed is cumulative per thread)", () => {
    // Real totals from two consecutive turns on one thread.
    const first = { input: 211091, cached: 148224, cacheWrite: 0, output: 1207 };
    const raw = [
      j({ type: "thread.started", thread_id: "t-1" }),
      j({ type: "item.completed", item: { type: "reasoning" } }),
      j({ type: "item.completed", item: { type: "command_execution" } }),
      j({ type: "item.completed", item: { type: "agent_message", text: "need permission" } }),
      j({ type: "turn.completed", usage: { input_tokens: 309601, cached_input_tokens: 244736, cache_write_input_tokens: 0, output_tokens: 1456 } }),
    ].join("\n");
    const r = reduceCodex(raw, { threadId: "t-1", totals: first });
    expect(r.usage).toEqual({ input: 1998, cacheRead: 96512, cacheWrite: 0, output: 249, requests: 3, contextTokens: 32837 });
    expect(r.threadTotals).toEqual({ input: 309601, cached: 244736, cacheWrite: 0, output: 1456 });
    // A different thread (the resume did not take) is counted whole.
    expect(reduceCodex(raw, { threadId: "t-other", totals: first }).usage.cacheRead).toBe(244736);
    // No turn.completed (killed turn): no totals, so the caller keeps the old ones.
    expect(reduceCodex(j({ type: "thread.started", thread_id: "t-1" }), { threadId: "t-1", totals: first }).threadTotals).toBeUndefined();
  });

  it("sums OpenCode steps and parses a fenced result", () => {
    const raw = [
      j({ type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 11513, output: 78, cache: { read: 1792, write: 0 } } } }),
      j({ type: "text", sessionID: "ses_1", part: { text: 'Done.\n```json\n{"status":"done","summary":"s"}\n```' } }),
      j({ type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 13405, output: 3, cache: { read: 0, write: 0 } } } }),
    ].join("\n");
    const r = reduceOpencodeTurn(raw);
    expect(r.usage).toEqual({ input: 24918, cacheRead: 1792, cacheWrite: 0, output: 81, requests: 2, contextTokens: 13405 });
    expect(r.structured).toEqual({ status: "done", summary: "s" });
    expect(structuredFrom("no json here")).toEqual({});
  });
});

describe("check output filter", () => {
  const log = ["> test", ...Array.from({ length: 200 }, (_, i) => `ok ${i} passing thing`), "FAIL src/a.test.ts", "  expected 1 received 2",
    "  at a.test.ts:3", ...Array.from({ length: 50 }, (_, i) => `noise ${i}`), "Tests: 1 failed, 200 passed"].join("\n");

  it("keeps failures with context plus the summary, not the passing noise", () => {
    const out = filterCheckOutput(log, false);
    expect(out).toContain("FAIL src/a.test.ts");
    expect(out).toContain("expected 1 received 2");
    expect(out).toContain("Tests: 1 failed, 200 passed");
    expect(out).not.toContain("ok 100 passing");
    expect(out.split("\n").length).toBeLessThan(25);
  });

  it("returns a short tail on success and caps runaway output", () => {
    expect(filterCheckOutput(log, true).split("\n")).toHaveLength(3);
    const flood = Array.from({ length: 1000 }, (_, i) => `error ${i}`).join("\n");
    expect(filterCheckOutput(flood, false).split("\n").length).toBeLessThanOrEqual(100);
  });

  it("matches the worker-side hverify filter exactly", () => {
    for (const passed of [true, false]) expect(hverifyFilter(log, passed)).toBe(filterCheckOutput(log, passed));
  });
});

describe("scope check", () => {
  it("flags paths outside the write scope and protected paths", () => {
    expect(scopeViolations(["src/ai/a.ts", "src/world/b.ts", "AGENTS.md"], ["src/ai/**"], ["AGENTS.md"])).toEqual([
      { path: "src/world/b.ts", reason: "outside write_scope" }, { path: "AGENTS.md", reason: "protected" },
    ]);
  });
});

describe("briefs", () => {
  const { plan } = parsePlan(`---\ntitle: P\nchecks: ["npm test"]\n---\n- [ ] **T1 — Thing**\n\`\`\`yaml\ngoal: Do the thing\nwrite_scope: ["src/**"]\nread_first: ["src/a.ts:1-40"]\n\`\`\`\n`);

  it("renders pointers and the hverify-wrapped checks within budget", () => {
    const brief = renderBrief(plan.tasks[0], { planTitle: "P", planChecks: plan.header.checks, facts: ["uses ESM"], skills: ["/s/tdd/SKILL.md"], fencedResult: false });
    expect(brief).toContain("src/a.ts:1-40");
    expect(brief).toContain('hverify.mjs "npm test"');
    expect(brief).toContain("/s/tdd/SKILL.md");
    expect(estimateTokens(brief)).toBeLessThan(2000);
  });

  it("validates worker results against the contract", () => {
    expect(RESULT_SCHEMA.required).toContain("status");
    expect(parseWorkerResult({ status: "done", summary: "s" })).toEqual({ status: "done", summary: "s", files_changed: [], decisions: [], questions: [] });
    expect(parseWorkerResult({ status: "finished", summary: "s" })).toBeNull();
    expect(parseWorkerResult("done")).toBeNull();
  });

  it("keeps the newest handoff entries inside the budget", () => {
    const entries = Array.from({ length: 50 }, (_, i) => ({ id: `T${i}`, title: "t", summary: "x".repeat(200), decisions: [] }));
    const handoff = renderHandoff(entries, 300);
    expect(estimateTokens(handoff)).toBeLessThanOrEqual(300);
    expect(handoff).toContain("T49");
    expect(handoff).not.toContain("T0 ");
  });
});

describe("effective tokens", () => {
  it("weights cache reads and writes", () => {
    expect(effectiveTokens({ input: 100, cacheRead: 10000, cacheWrite: 400, output: 50 })).toBe(100 + 1000 + 500 + 50);
    expect(cacheHitRate({ input: 0, cacheRead: 97, cacheWrite: 3 })).toBeCloseTo(0.97);
    expect(cacheHitRate({ input: 0, cacheRead: 0, cacheWrite: 0 })).toBeNull();
  });

  it("counts each Claude request once, though it streams one event per content block", () => {
    const watch = budgetWatcher("claude", 1000);
    const block = (id: string) => j({ type: "assistant", message: { id, usage: { input_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 } } });
    // Thinking, text and three tool calls of the same request: 400, not 2000.
    for (let i = 0; i < 5; i++) expect(watch(block("msg_1"))).toBeUndefined();
    expect(watch(block("msg_2"))).toBeUndefined();
    expect(watch.spent).toBe(800);
    expect(watch(block("msg_3"))).toMatch(/1200 > 1000/);
    expect(watch.spent).toBe(1200);
  });

  it("records the real usage of a Claude turn killed before its result", () => {
    const block = (id: string, extra: object) => j({ type: "assistant", message: { id, usage: { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50, output_tokens: 30, ...extra } } });
    const raw = [block("a", {}), block("a", {}), block("b", { cache_read_input_tokens: 2000 })].join("\n");
    expect(reduceClaude(raw).usage).toMatchObject({ input: 4, cacheRead: 3000, cacheWrite: 100, output: 60, requests: 2 });
  });

  it("stops a Claude turn once the live total passes its budget", () => {
    const watch = budgetWatcher("claude", 1000);
    const step = j({ type: "assistant", message: { usage: { input_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 100 } } });
    expect(watch(step)).toBeUndefined();
    expect(watch(step)).toBeUndefined();
    expect(watch(step)).toMatch(/token budget exceeded/);
    expect(budgetWatcher("codex", 1)(step)).toBeUndefined();
  });
});

describe("scheduler", () => {
  const codex = { agent: "codex" }, claude = { agent: "claude" }, oc = { agent: "opencode" };
  const t = (id: string, o: Partial<SchedTask> = {}): SchedTask => ({ id, dependsOn: [], status: "queued", writeScope: [`src/${id}/**`], candidates: [codex], ...o });

  it("starts ready tasks in plan order, one per agent, up to concurrency", () => {
    const tasks = [t("a"), t("b"), t("c", { candidates: [claude] }), t("d", { candidates: [oc] }), t("e", { dependsOn: ["a"], candidates: [oc] })];
    expect(nextDispatches({ tasks, concurrency: 3, busyAgents: new Set(), unavailable: new Set() }))
      .toEqual([{ taskId: "a", ref: codex }, { taskId: "c", ref: claude }, { taskId: "d", ref: oc }]);
    expect(nextDispatches({ tasks, concurrency: 1, busyAgents: new Set(["codex"]), unavailable: new Set() })).toEqual([{ taskId: "c", ref: claude }]);
  });

  it("falls back only on usage limits, never because an agent is busy", () => {
    const tasks = [t("a", { candidates: [oc, codex] })];
    expect(nextDispatches({ tasks, concurrency: 3, busyAgents: new Set(["opencode"]), unavailable: new Set() })).toEqual([]);
    expect(nextDispatches({ tasks, concurrency: 3, busyAgents: new Set(), unavailable: new Set(["opencode"]) })).toEqual([{ taskId: "a", ref: codex }]);
  });

  it("never runs overlapping write scopes together and holds back dependents of tasks that need you", () => {
    const tasks = [t("a", { status: "checking", writeScope: ["src/**"] }), t("b", { candidates: [claude] }), t("c", { candidates: [oc], writeScope: ["docs/**"] })];
    expect(nextDispatches({ tasks, concurrency: 3, busyAgents: new Set(["codex"]), unavailable: new Set() }).map((d) => d.taskId)).toEqual(["c"]);
    for (const status of ["waiting", "stopped", "interrupted"] as const) {
      const paused = [t("a", { status }), t("b", { dependsOn: ["a"] }), t("c", { dependsOn: ["b"] }), t("d")];
      expect(nextDispatches({ tasks: paused, concurrency: 3, busyAgents: new Set(), unavailable: new Set() }).map((d) => d.taskId)).toEqual(["d"]);
      expect([...blockedBy(paused)]).toEqual([["b", "a"], ["c", "a"]]);
    }
  });

  it("lets skipped tasks satisfy their dependents", () => {
    const tasks = [t("a", { status: "skipped" }), t("b", { dependsOn: ["a"] })];
    expect(nextDispatches({ tasks, concurrency: 3, busyAgents: new Set(), unavailable: new Set() }).map((d) => d.taskId)).toEqual(["b"]);
  });
});

describe("store", () => {
  it("migrates task statuses from before the lifecycle, and adds the timing columns", () => {
    const file = join(mkdtempSync(join(tmpdir(), "store-")), "h.db");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE tasks (plan_id TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, agent TEXT, model TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, note TEXT, summary TEXT, decisions TEXT NOT NULL DEFAULT '[]',
      commit_sha TEXT, orchestrated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (plan_id, id));
      INSERT INTO tasks (plan_id, id, status) VALUES ('p', 'A', 'pending'), ('p', 'B', 'running'), ('p', 'C', 'paused'), ('p', 'D', 'done');`);
    old.close();
    const s = new Store(file);
    expect(s.tasks("p").map((t) => [t.id, t.status, t.phaseStartedAt])).toEqual([
      ["A", "queued", null], ["B", "interrupted", null], ["C", "waiting", null], ["D", "done", null]]);
    s.close();
  });

  it("persists plans, tasks, sessions, runs, reviews and events", () => {
    const s = new Store(":memory:");
    s.upsertPlan({ id: "p", repo: "/r", file: ".harness/plans/p.md", baseBranch: "main", planBranch: "harness/p", status: "running" });
    s.syncTasks("p", [{ id: "T1", done: false }, { id: "T2", done: true }]);
    expect(s.task("p", "T1")?.status).toBe("queued");
    s.updateTask("p", "T1", { status: "working", agent: "codex", attempts: 1, decisions: ["uses ESM"], orchestrated: true, phaseStartedAt: "2026-10-22T10:00:00Z" });
    s.syncTasks("p", [{ id: "T1", done: false }]);
    expect(s.task("p", "T1")).toMatchObject({ status: "working", agent: "codex", attempts: 1, decisions: ["uses ESM"], orchestrated: true, note: null,
      phaseStartedAt: "2026-10-22T10:00:00Z", turnStartedAt: null });
    expect(s.task("p", "T2")?.status).toBe("done");
    s.saveSession({ planId: "p", agent: "codex", sessionId: "t-1", contextTokens: 5000, turns: 1 });
    expect(s.session("p", "codex")?.sessionId).toBe("t-1");
    const threadTotals = { input: 9, cached: 5, cacheWrite: 0, output: 2 };
    s.saveSession({ planId: "p", agent: "codex", sessionId: "t-1", contextTokens: 5000, turns: 2, threadTotals });
    expect(s.session("p", "codex")?.threadTotals).toEqual(threadTotals);
    s.dropSession("p", "codex");
    expect(s.session("p", "codex")).toBeUndefined();
    const usage = { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, requests: 1, contextTokens: 6 };
    for (const e of [10, 30, 20]) s.addRun({ planId: "p", taskId: "T1", agent: "codex", model: null, phase: "implement", outcome: "done", usage, effective: e, durationMs: 5, logFile: null });
    expect(s.medianEffective("codex", "implement")).toBe(20);
    s.addReview({ planId: "p", agent: "codex", round: 1, reviewer: "claude", decision: "approve", notes: "" });
    expect(s.reviews("p", "codex")).toHaveLength(1);
    const ev = s.addEvent("p", "task.done", { task: "T1" });
    expect(s.events("p", ev.id - 1)).toEqual([ev]);
    s.close();
  });
});
