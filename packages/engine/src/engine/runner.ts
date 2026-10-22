import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_CONFIG, type AgentRef, type EngineConfig } from "../config.js";
import { runTurn as defaultRunTurn, type AgentId, type TurnRequest, type TurnResult } from "../agents/turn.js";
import { parseWorkerResult, renderBrief, renderFixPrompt, renderHandoff, RESULT_SCHEMA, type WorkerResult } from "../brief/brief.js";
import { changedPaths, checksPassed, formatCheckFailures, runChecks as defaultRunChecks, scopeViolations, type CheckResult } from "../checks/checks.js";
import { lockPathsOverlap } from "../git/path-locks.js";
import { budgetWatcher, effectiveTokens, type BudgetWatcher } from "../ledger/effective.js";
import { orchHome, projectId } from "../ledger/telemetry.js";
import { DECISION_SCHEMA, parseDecision, renderConflictPrompt, renderDecisionPrompt, type Decision } from "../orchestrator/orchestrator.js";
import { markTask, parsePlan, validatePlan, type Plan, type PlanTask, type TaskMark } from "../plan/plan.js";
import { parseVerdict, renderReviewPrompt, VERDICT_SCHEMA } from "../review/review.js";
import { blockedBy, nextDispatches, planFinished, type SchedTask } from "../scheduler/scheduler.js";
import { listSkills, selectSkills, type Skill, type SkillRole } from "../skills/skills.js";
import type { PlanStatus, RunPhase, Store, TaskRow } from "../store/store.js";
import * as g from "./git.js";
import { dependencyViolations, installDeps, isManifest, MANIFEST_GLOBS, staleDeps } from "./deps.js";
import { prepareWorktreeRemoval } from "../git/worktree.js";
import { canTransition, FINAL, IN_FLIGHT, NEEDS_YOU, STATE_INFO, STOPPABLE, transition, type TaskEvent, type TaskState } from "./lifecycle.js";

export interface RunnerDeps {
  runTurn: (req: TurnRequest) => Promise<TurnResult>;
  runChecks: (commands: readonly string[], cwd: string, logDir: string, timeoutMs?: number, signal?: AbortSignal) => Promise<CheckResult[]>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  installDeps: (cwd: string) => Promise<{ ok: boolean; output: string }>;
}

export interface RunnerOptions {
  /** The user's main checkout. */
  repo: string;
  /** Plan file, absolute or repo-relative. */
  planFile: string;
  store: Store;
  config?: EngineConfig;
  deps?: Partial<RunnerDeps>;
  skillsRoot?: string;
  /** Where lane worktrees live; defaults to `<repo>/../.harness-wt/<repo>/<plan>`. */
  worktreeRoot?: string;
}

export type RunnerEvent =
  | { type: "line"; agent: string; taskId: string | null; line: string }
  | { type: "task"; taskId: string; status: string; agent?: string; note?: string; details?: string }
  | { type: "plan"; status: PlanStatus; message?: string }
  | { type: "needs-you"; taskId?: string; message: string }
  | { type: "run"; agent: string; taskId: string | null; phase: RunPhase; outcome: string; effective: number }
  | { type: "info"; message: string };

const AGENTS: readonly AgentId[] = ["claude", "codex", "opencode"];

/** Store key of a plan: the same plan file name in two repos must not share state. */
export function planKey(repo: string, planFile: string): string {
  return `${resolve(repo).replaceAll("\\", "/").toLowerCase()}#${basename(planFile).replace(/\.md$/i, "")}`;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Failure details kept on events for the task panel: enough to read, small enough for the store. */
const clipDetails = (s: string): string => (s.length > 4000 ? `${s.slice(0, 4000)}\n… (truncated)` : s);

/** Why a finished task could not be accepted yet. `notMerged`: its commit never reached the plan branch. */
interface MergeFailure {
  reason: string;
  details: string;
  notMerged?: true;
}

/** The facts the Stop confirm shows before you stop a task. */
export interface StopInfo {
  taskId: string;
  state: TaskState;
  agent: string | null;
  /** Stop applies here right now (a task with work in flight). */
  stoppable: boolean;
  /** A merge is running: the stop takes effect once it finishes. */
  deferred: boolean;
  phaseElapsedMs: number | null;
  turnElapsedMs: number | null;
  /** Effective tokens of the running turn; null when the agent only reports them at the end (Codex). */
  tokensSoFar: number | null;
  tokensNote: string | null;
  uncommittedFiles: number;
  /** Unfinished tasks that depend on this one, directly or not; they wait while it is stopped. */
  dependents: string[];
  ifStopped: string;
  afterwards: string[];
}

type TaskPatch = Partial<Omit<TaskRow, "planId" | "id" | "status">>;

interface Lane {
  agent: AgentId;
  path: string;
  branch: string;
}

/**
 * Runs one plan to completion with no LLM in the loop except the workers
 * themselves and the orchestrator at decision points.
 */
export class PlanRunner extends EventEmitter {
  /** Plan slug: names the branches and worktrees. */
  readonly id: string;
  /** Store key: the same plan file name in two repos must not share state. */
  readonly key: string;
  readonly repo: string;
  readonly planPath: string;
  readonly planRel: string;
  readonly cfg: EngineConfig;
  readonly store: Store;
  private plan!: Plan;
  private readonly deps: RunnerDeps;
  private readonly skills: Skill[];
  private readonly wtRoot: string;
  private readonly stateDir: string;
  private baseBranch = "";
  private planBranch = "";
  private planWorktree = "";
  private stopped = false;
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly busy = new Set<string>();
  private readonly unavailableUntil = new Map<string, number>();
  /** Orchestrator guidance and reassignments, applied to a task's next attempt. */
  private readonly guidance = new Map<string, string>();
  private readonly reassigned = new Map<string, AgentRef>();
  /** Agents whose session must restart with a handoff (rotation, reassignment). */
  private readonly rotate = new Set<string>();
  private mergeChain: Promise<unknown> = Promise.resolve();
  /** One per task with work in flight: Stop aborts it. */
  private readonly controllers = new Map<string, AbortController>();
  /** The live budget watcher of each task's running turn, for tokens-so-far. */
  private readonly watchers = new Map<string, BudgetWatcher>();

  constructor(opts: RunnerOptions) {
    super();
    this.repo = resolve(opts.repo);
    this.planPath = isAbsolute(opts.planFile) ? opts.planFile : join(this.repo, opts.planFile);
    this.planRel = relative(this.repo, this.planPath).replaceAll("\\", "/");
    this.id = basename(this.planPath).replace(/\.md$/i, "");
    this.key = planKey(this.repo, this.planPath);
    this.cfg = opts.config ?? DEFAULT_CONFIG;
    this.store = opts.store;
    this.deps = { runTurn: defaultRunTurn, runChecks: defaultRunChecks, now: () => new Date(), sleep, installDeps, ...opts.deps };
    this.skills = listSkills(opts.skillsRoot);
    this.wtRoot = opts.worktreeRoot ?? join(dirname(this.repo), ".harness-wt", basename(this.repo), this.id);
    this.stateDir = join(orchHome(), projectId(this.repo), this.id);
  }

  emit(event: "event", e: RunnerEvent): boolean;
  emit(event: string, ...args: unknown[]): boolean { return super.emit(event, ...args); }

  private say(e: RunnerEvent): void {
    if (e.type !== "line") this.store.addEvent(this.key, e.type, e as unknown as Record<string, unknown>);
    this.emit("event", e);
  }

  get protectedPaths(): string[] {
    return [this.planRel, "AGENTS.md", "CLAUDE.md", ".harness/**"];
  }

  /** Parse and validate the plan file. Errors block a run. */
  load(): { plan: Plan; errors: string[]; warnings: string[] } {
    const { plan, errors } = parsePlan(readFileSync(this.planPath, "utf8"));
    const v = validatePlan(plan, { agents: AGENTS, skills: this.skills.map((s) => s.name), protectedPaths: this.protectedPaths });
    this.plan = plan;
    return { plan, errors: [...errors, ...v.errors], warnings: v.warnings };
  }

  /** Create the plan branch and its integration worktree; register the plan. */
  async prepare(): Promise<void> {
    const { errors } = this.load();
    if (errors.length) throw new Error(`plan is invalid:\n- ${errors.join("\n- ")}`);
    // Already prepared (e.g. a Resume click mid-run): pick up new tasks, never touch work in flight.
    if (this.planBranch) {
      this.store.syncTasks(this.key, this.plan.tasks);
      return;
    }
    this.baseBranch = this.plan.header.baseBranch ?? (await g.currentBranch(this.repo));
    this.planBranch = `harness/${this.id}`;
    this.planWorktree = join(this.wtRoot, "plan");
    await g.ensureWorktree(this.repo, this.planWorktree, this.planBranch, this.baseBranch);
    await this.linkShared(this.planWorktree);
    const existing = this.store.plan(this.key);
    this.store.upsertPlan({ id: this.key, repo: this.repo, file: this.planRel, baseBranch: this.baseBranch, planBranch: this.planBranch,
      status: existing?.status === "merged" ? "merged" : "paused" });
    this.store.syncTasks(this.key, this.plan.tasks);
    // A previous app session that died mid-run leaves tasks in flight; this process has nothing in flight yet.
    // Rows migrated from before the lifecycle arrive as "interrupted" with no note.
    for (const row of this.store.tasks(this.key)) {
      if (IN_FLIGHT.includes(row.status) || (row.status === "interrupted" && row.note === null)) await this.recover(row);
    }
  }

  /** A task the last app session left in flight: keep its edits, say what it was doing, and mark it interrupted. */
  private async recover(row: TaskRow): Promise<void> {
    const t = this.plan.tasks.find((x) => x.id === row.id);
    if (!t) return;
    const lanePath = row.agent ? join(this.wtRoot, row.agent) : null;
    const lane = lanePath && existsSync(lanePath) ? lanePath : null;
    if (row.status === "merging" && lane) {
      const head = (await g.tryGit(lane, ["log", "-1", "--format=%H%x09%s"])).stdout.trim().split("\t");
      if (head[1] === `${t.id}: ${t.title}` && head[0]) {
        if (await g.isAncestor(this.repo, head[0], this.planBranch)) {
          const commits = [...new Set([...this.commitsOf(t.id), head[0]])];
          this.setState(t.id, "merged", { commitSha: commits.join(" "), note: null }, { note: "the merge landed before the app closed" });
          this.mark(t.id, { done: true });
          return;
        }
        // Committed but never merged: turn the commit back into edits so they can be parked and resumed.
        await g.git(lane, ["reset", "-q", "--mixed", "HEAD~1"]);
      }
    }
    const parked = lane ? await g.stashWip(lane, this.parkLabel(t)) : false;
    const was = row.status === "interrupted" ? "running" : row.status;
    const note = `${row.agent ?? "the agent"} was ${was} when the app closed${parked ? "; its edits are kept" : ""}`;
    if (row.status === "interrupted") this.store.updateTask(this.key, t.id, { note });
    // The orchestrator's turn died with the app: let it decide again next time.
    else this.setState(t.id, "appClosed", { note, ...(row.status === "escalating" ? { orchestrated: false } : {}) }, { note });
  }

  stop(): void {
    this.stopped = true;
    this.wakeUp();
  }

  private looping = false;

  /** Is this process driving the plan right now? */
  get running(): boolean { return this.looping || this.inflight.size > 0; }

  private wakeUp: () => void = () => undefined;

  /** Resolves when something outside the loop (a human action) may have made new work runnable. */
  private wakeSignal(): Promise<void> {
    return new Promise((resolve) => { this.wakeUp = resolve; });
  }

  /** Worktrees whose installed dependencies were checked by this process; later changes go through syncDeps. */
  private readonly depsChecked = new Set<string>();

  private async linkShared(worktree: string): Promise<void> {
    const linked = await g.provideSharedDirs(this.repo, worktree, this.cfg.sharedDirs);
    if (linked.length) this.say({ type: "info", message: `provided ${linked.join(", ")} to the ${basename(worktree)} worktree (hard-linked copy)` });
    if (this.depsChecked.has(worktree)) return;
    this.depsChecked.add(worktree);
    // The copy is only as current as the main checkout: install before an agent or a check trips over a missing package.
    const stale = staleDeps(worktree);
    if (!stale) return;
    const r = await this.deps.installDeps(worktree);
    this.say({ type: "info", message: r.ok
      ? `dependencies were out of date (${stale}); installed them in the ${basename(worktree)} worktree`
      : `dependencies are out of date (${stale}) and installing them in the ${basename(worktree)} worktree failed:
${r.output}` });
  }

  /** Agents with a turn in flight right now. */
  get activeAgents(): string[] { return [...this.busy]; }

  private readonly held = new Set<string>();

  /**
   * A human takes over an agent's lane: no new dispatches for it until released.
   * Returns where to resume (null while the agent is mid-turn or has no session).
   */
  hold(agent: AgentId): { path: string; sessionId: string | null } | null {
    if (this.busy.has(agent)) return null;
    this.held.add(agent);
    return { path: join(this.wtRoot, agent), sessionId: this.store.session(this.key, agent)?.sessionId ?? null };
  }

  release(agent: AgentId): void {
    this.held.delete(agent);
    this.emit("event", { type: "info", message: `${agent} handed back to the engine` } satisfies RunnerEvent);
    this.wakeUp();
  }

  /** Run until the plan is ready to merge, stalls on a human, or is stopped. */
  async run(): Promise<PlanStatus> {
    if (this.looping) return "running";
    this.looping = true;
    try {
      return await this.loop();
    } finally {
      this.looping = false;
    }
  }

  private async loop(): Promise<PlanStatus> {
    if (!this.planBranch) await this.prepare();
    this.stopped = false;
    // Start continues tasks the app closed on, like Resume: same session, edits restored.
    for (const row of this.store.tasks(this.key)) if (row.status === "interrupted") this.resumeTask(row.id);
    this.setStatus("running");
    while (!this.stopped) {
      this.load();
      const sched = this.schedTasks();
      const unavailable = this.currentlyUnavailable();
      const busyAgents = new Set([...this.busy, ...this.held]);
      for (const d of nextDispatches({ tasks: sched, concurrency: this.plan.header.concurrency ?? this.cfg.concurrency, busyAgents, unavailable })) {
        this.track(d.ref.agent, `task:${d.taskId}`, this.runTask(this.task(d.taskId), d.ref));
      }
      this.startReviews();
      if (this.inflight.size === 0) {
        if (this.readyToMerge()) return this.setStatus("ready", "all tasks done and reviewed; ready to merge into " + this.baseBranch);
        const waitMs = this.waitForLimits(sched, unavailable) ?? this.waitForReviewers();
        if (waitMs !== null) {
          this.say({ type: "info", message: `every usable agent is at its usage limit; waiting ${Math.ceil(waitMs / 60_000)} min` });
          await Promise.race([this.deps.sleep(waitMs), this.wakeSignal()]);
          continue;
        }
        const paused = [...this.store.tasks(this.key).filter((t) => NEEDS_YOU.includes(t.status)).map((t) => t.id), ...[...this.reviewBlocked].map((a) => `review of ${a}`)];
        return this.setStatus("paused", paused.length ? `waiting for you on ${paused.join(", ")}` : "nothing can run");
      }
      // Wake on a finished turn, or at once when a human resumes, reassigns or hands a lane back.
      await Promise.race([...this.inflight.values(), this.wakeSignal()]);
    }
    return this.setStatus("stopped");
  }

  private setStatus(status: PlanStatus, message?: string): PlanStatus {
    this.store.setPlanStatus(this.key, status);
    this.say({ type: "plan", status, ...(message ? { message } : {}) });
    return status;
  }

  /** What each busy agent is doing: a task id, or "review" while its work is reviewed and fixed. */
  private readonly doing = new Map<string, string>();

  /** Live per-agent state for the status strip. */
  agentStates(): Array<{ agent: AgentId; state: "working" | "idle" | "limited" | "held"; task?: string; until?: string }> {
    const now = this.deps.now().getTime();
    return AGENTS.map((agent) => {
      const until = this.unavailableUntil.get(agent);
      if (this.held.has(agent)) return { agent, state: "held" as const };
      if (this.busy.has(agent)) return { agent, state: "working" as const, task: this.doing.get(agent) };
      if (until && until > now) return { agent, state: "limited" as const, until: new Date(until).toISOString() };
      return { agent, state: "idle" as const };
    });
  }

  /** Everything one agent contributed to the plan, as reviewed: its tasks' commits plus its review fixes. */
  async authorDiff(agent: string): Promise<string> {
    const tasks = this.store.tasks(this.key).filter((r) => r.agent === agent && r.status === "done");
    const commits = tasks.flatMap((r) => this.commitsOf(r.id));
    const fixes = (await g.tryGit(this.repo, ["log", "--all", "--reverse", "--format=%H%x09%s", "--fixed-strings", `--grep=Review fixes (${agent})`])).stdout
      .split(/\r?\n/).map((l) => l.split("\t")).filter(([, s]) => s === `Review fixes (${agent})`).map(([h]) => h);
    const all = [...new Set([...commits, ...(this.fixCommits.get(agent) ?? []), ...fixes])];
    return all.length ? (await g.commitsDiff(this.repo, all)).diff : "";
  }

  /** The patches of a task's commits on the plan branch (empty before its first merge). */
  async taskDiff(taskId: string): Promise<string> {
    let commits = this.commitsOf(taskId);
    if (!commits.length) {
      // Older runs did not record every commit: find the task's own commits by their subject line.
      const t = this.plan?.tasks.find((x) => x.id === taskId) ?? this.load().plan.tasks.find((x) => x.id === taskId);
      if (!t) return "";
      const log = await g.tryGit(this.repo, ["log", "--all", "--reverse", "--format=%H%x09%s", "--fixed-strings", `--grep=${t.id}: ${t.title}`]);
      commits = log.stdout.split(/\r?\n/).map((l) => l.split("\t")).filter(([, s]) => s === `${t.id}: ${t.title}`).map(([h]) => h);
    }
    return commits.length ? (await g.commitsDiff(this.repo, commits)).diff : "";
  }

  private track(agent: string, key: string, work: Promise<void>): void {
    this.busy.add(agent);
    this.doing.set(agent, key.startsWith("task:") ? key.slice(5) : "review");
    const p = work.catch((error: unknown) => {
      this.say({ type: "info", message: `${key} crashed: ${error instanceof Error ? error.message : String(error)}` });
      const taskId = key.startsWith("task:") ? key.slice(5) : null;
      const state = taskId ? this.store.task(this.key, taskId)?.status : undefined;
      if (taskId && state && canTransition(state, "error")) this.pause(taskId, "error", `engine error: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.inflight.delete(key);
      this.busy.delete(agent);
      this.doing.delete(agent);
    });
    this.inflight.set(key, p);
  }

  private task(id: string): PlanTask {
    const t = this.plan.tasks.find((x) => x.id === id);
    if (!t) throw new Error(`unknown task ${id}`);
    return t;
  }

  /** Ordered agent choices for a task: reassignment, explicit override, then the role's routing. */
  candidates(t: PlanTask): AgentRef[] {
    const re = this.reassigned.get(t.id);
    if (re) return [re];
    if (t.agent) {
      const routed = [...this.cfg.routing[t.role], ...this.cfg.routing.implement, ...this.cfg.routing.hard].find((r) => r.agent === t.agent);
      return [{ ...(routed ?? { agent: t.agent }), ...(t.model ? { model: t.model } : {}) }];
    }
    return this.cfg.routing[t.role];
  }

  private schedTasks(): SchedTask[] {
    const rows = new Map(this.store.tasks(this.key).map((r) => [r.id, r]));
    return this.plan.tasks.map((t) => ({
      id: t.id, dependsOn: t.dependsOn, writeScope: t.writeScope, candidates: this.candidates(t),
      status: rows.get(t.id)?.status ?? (t.done ? "done" : "queued"),
    }));
  }

  private currentlyUnavailable(): Set<string> {
    const now = this.deps.now().getTime();
    return new Set([...this.unavailableUntil].filter(([, until]) => until > now).map(([a]) => a));
  }

  /** When pending work is blocked only by usage limits, how long until the first one lifts. */
  private waitForLimits(sched: readonly SchedTask[], unavailable: ReadonlySet<string>): number | null {
    const blocked = blockedBy(sched);
    const waiting = sched.filter((t) => t.status === "queued" && !blocked.has(t.id) && t.candidates.every((c) => unavailable.has(c.agent)));
    if (!waiting.length) return null;
    const now = this.deps.now().getTime();
    const until = Math.min(...waiting.flatMap((t) => t.candidates.map((c) => this.unavailableUntil.get(c.agent) ?? now)));
    return Math.max(60_000, until - now);
  }

  private markLimited(agent: string, resetAt: string | null): void {
    const now = this.deps.now().getTime();
    const until = resetAt ? Math.max(now + 60_000, Date.parse(resetAt)) : now + 60 * 60_000;
    this.unavailableUntil.set(agent, until);
    this.say({ type: "info", message: `${agent} hit its usage limit; resumes ${new Date(until).toLocaleTimeString()}` });
  }

  private async lane(agent: AgentId): Promise<Lane> {
    const path = join(this.wtRoot, agent);
    const branch = `${this.planBranch}--${agent}`;
    await g.ensureWorktree(this.repo, path, branch, this.planBranch);
    await this.linkShared(path);
    return { agent, path, branch };
  }

  private logFile(name: string): string {
    return join(this.stateDir, "logs", `${name}-${this.deps.now().getTime()}.jsonl`);
  }

  private facts(t: PlanTask): string[] {
    const rows = this.store.tasks(this.key).filter((r) => r.status === "done" && r.decisions.length);
    const related = (other: PlanTask): boolean => t.dependsOn.includes(other.id) ||
      other.writeScope.some((a) => [...t.writeScope, ...t.readFirst.map((p) => p.replace(/:\d.*$/, ""))].some((b) => lockPathsOverlap(a, b)));
    return rows.filter((r) => related(this.task(r.id))).flatMap((r) => r.decisions.map((d) => `${d} (${r.id})`)).slice(0, 10);
  }

  private handoff(agent: string): string | undefined {
    const done = this.store.tasks(this.key).filter((r) => r.agent === agent && r.status === "done" && r.summary);
    if (!done.length) return undefined;
    return renderHandoff(done.map((r) => ({ id: r.id, title: this.task(r.id).title, summary: r.summary ?? "", decisions: r.decisions })));
  }

  private skillPaths(role: SkillRole, named: readonly string[]): string[] {
    return selectSkills(this.skills, role, named);
  }

  private budgetFor(agent: string, phase: RunPhase): number {
    const median = this.store.medianEffective(agent, phase);
    return median === null ? this.cfg.taskTokenBudget : Math.min(this.cfg.taskTokenBudget, Math.max(3 * median, 50_000));
  }

  /** One turn in an agent's plan session, with ledger, live lines and session bookkeeping. */
  private async turn(ref: AgentRef, opts: {
    cwd: string; prompt: string; taskId: string | null; phase: RunPhase; session: "lane" | "fresh";
    schema?: object; readOnly?: boolean; images?: boolean; signal?: AbortSignal;
  }): Promise<TurnResult> {
    const agent = ref.agent as AgentId;
    const watcher = budgetWatcher(agent, this.budgetFor(agent, opts.phase));
    // A stoppable task turn: the Stop confirm reads its elapsed time and tokens so far.
    if (opts.signal && opts.taskId) {
      this.watchers.set(opts.taskId, watcher);
      this.store.updateTask(this.key, opts.taskId, { turnStartedAt: this.deps.now().toISOString() });
    }
    const prior = opts.session === "lane" && !this.rotate.has(agent) ? this.store.session(this.key, agent) : undefined;
    const logFile = this.logFile(`${opts.taskId ?? opts.phase}-${agent}`);
    const result = await this.deps.runTurn({
      agent, model: ref, cwd: opts.cwd, prompt: opts.prompt, logFile,
      ...(prior ? { resumeSession: prior.sessionId, ...(prior.threadTotals ? { threadTotals: prior.threadTotals } : {}) } : {}),
      ...(opts.schema && agent !== "opencode" ? { schema: opts.schema } : {}),
      readOnly: opts.readOnly, imageGeneration: opts.images, adapter: this.cfg.adapters[agent],
      checkCommands: [...new Set([...this.plan.header.checks, ...this.plan.tasks.flatMap((t) => t.checks)])],
      timeoutMs: opts.phase === "review" ? this.cfg.reviewTimeoutMs : this.cfg.taskTimeoutMs,
      onLine: (line) => this.emit("event", { type: "line", agent, taskId: opts.taskId, line }),
      abortOn: watcher, signal: opts.signal,
    });
    if (opts.signal && opts.taskId) this.watchers.delete(opts.taskId);
    const effective = effectiveTokens(result.usage);
    const outcome = result.usageLimit ? "usage-limit" : result.aborted ? "aborted" : result.timedOut ? "timeout" : result.code === 0 ? "done" : "failed";
    this.store.addRun({ planId: this.key, taskId: opts.taskId, agent, model: ref.model ?? null, phase: opts.phase, outcome,
      usage: result.usage, effective, durationMs: result.durationMs, logFile });
    this.say({ type: "run", agent, taskId: opts.taskId, phase: opts.phase, outcome, effective });
    if (opts.session === "lane" && result.sessionId) {
      this.rotate.delete(agent);
      const turns = (prior?.turns ?? 0) + 1;
      if (result.usage.contextTokens > this.cfg.sessionCeilingTokens) {
        // Next task starts a fresh session with a handoff instead of replaying this context.
        this.store.dropSession(this.key, agent);
        this.say({ type: "info", message: `${agent} session reached ${result.usage.contextTokens} context tokens; rotating` });
      } else {
        // A turn killed before Codex reported totals keeps the old ones, so the next turn's usage includes it.
        const sameThread = prior?.sessionId === result.sessionId;
        const threadTotals = result.threadTotals ?? (sameThread ? prior?.threadTotals : undefined);
        this.store.saveSession({ planId: this.key, agent, sessionId: result.sessionId, contextTokens: result.usage.contextTokens, turns,
          ...(threadTotals ? { threadTotals } : {}) });
      }
    }
    if (result.usageLimit) this.markLimited(agent, result.usageLimit.resetAt);
    // Workers must stay in their own worktree. The plan worktree is the integration branch: undo stray edits there.
    if (opts.cwd !== this.planWorktree) await this.serialMerge(() => this.guardPlanWorktree(agent, opts.taskId));
    return result;
  }

  /** The only writer of task state: every move goes through the lifecycle table. */
  private setState(taskId: string, event: TaskEvent, patch: TaskPatch = {}, show: { note?: string; details?: string } = {}): TaskState {
    const row = this.store.task(this.key, taskId);
    const to = transition(row?.status ?? "queued", event);
    this.store.updateTask(this.key, taskId, { ...patch, status: to, phaseStartedAt: this.deps.now().toISOString() });
    const agent = patch.agent === undefined ? row?.agent : patch.agent;
    this.say({ type: "task", taskId, status: to, ...(agent ? { agent } : {}), ...(show.note ? { note: show.note } : {}),
      ...(show.details ? { details: clipDetails(show.details) } : {}) });
    return to;
  }

  private async runTask(t: PlanTask, ref: AgentRef): Promise<void> {
    const ctl = new AbortController();
    this.controllers.set(t.id, ctl);
    try {
      await this.work(t, ref, ctl);
    } finally {
      this.controllers.delete(t.id);
    }
  }

  private async work(t: PlanTask, ref: AgentRef, ctl: AbortController): Promise<void> {
    const agent = ref.agent as AgentId;
    this.setState(t.id, "dispatch", { agent, model: ref.model ?? null, note: null });
    this.mark(t.id, { done: false });
    const lane = await this.lane(agent);
    const fenced = agent === "opencode";
    const guidance = this.guidance.get(t.id);
    this.guidance.delete(t.id);
    const hasSession = !this.rotate.has(agent) && this.store.session(this.key, agent) !== undefined;
    // An orchestrator retry continues where it stopped: same work tree, same warm session, only the guidance.
    let continuing = this.continuing.delete(t.id) && hasSession;
    const resumedByHuman = this.resumed.delete(t.id);
    if (!continuing) {
      if (await g.stashWip(lane.path, `harnessOrch leftover before ${t.id}`)) this.say({ type: "info", message: `${agent} lane had leftover changes; stashed` });
      await this.syncLaneDeps(lane);
      // A human resume puts the parked attempt's work back instead of redoing it from scratch.
      const parked = resumedByHuman ? await g.findStash(lane.path, this.parkLabel(t)) : null;
      if (parked && await g.applyStash(lane.path, parked)) {
        this.say({ type: "info", message: `${t.id}: restored its parked work` });
        continuing = hasSession;
      }
    }
    const fresh = this.rotate.has(agent) || !this.store.session(this.key, agent);
    let prompt = continuing
      ? renderFixPrompt(t, resumedByHuman ? "the human answered" : "the orchestrator looked at your report",
        `${resumedByHuman ? "Your previous changes are back in the work tree. " : ""}Guidance: ${guidance ?? "try again"}`, fenced)
      : renderBrief(t, {
        planTitle: this.plan.header.title, projectType: this.plan.header.projectType, planChecks: this.plan.header.checks,
        facts: this.facts(t), skills: this.skillPaths(t.role === "hard" ? "fixer" : "implementer", [...t.skills, ...this.plan.header.skills]),
        fencedResult: fenced, ...(fresh ? { handoff: this.handoff(agent) } : {}),
      }) + (guidance ? `\n\n## Guidance\n${guidance}` : "");
    let attempts = this.store.task(this.key, t.id)?.attempts ?? 0;
    const history: string[] = [];

    for (;;) {
      // A plan-wide stop lets the current round finish, then stops the task like Stop would.
      if (this.stopped) ctl.abort();
      if (ctl.signal.aborted) return this.stopParked(t, lane);
      const r = await this.turn(ref, { cwd: lane.path, prompt, taskId: t.id, phase: attempts ? "fix" : "implement", session: "lane", schema: RESULT_SCHEMA, images: t.images, signal: ctl.signal });
      // A stop and a budget kill both abort the turn; only the stop's signal is set.
      if (ctl.signal.aborted) return this.stopParked(t, lane);
      if (r.usageLimit) {
        await g.discardChanges(lane.path);
        this.store.dropSession(this.key, agent);
        this.setState(t.id, "usageLimit", { agent: null }, { note: `${agent} at usage limit` });
        return;
      }
      const result = parseWorkerResult(r.structured);
      if (result) history.push(`${result.status}: ${result.summary}`);
      let failure: { reason: string; details: string } | null = null;
      if (!result) failure = { reason: r.aborted ?? (r.timedOut ? "the run timed out" : `no valid result (exit ${r.code})`), details: r.text.slice(-1500) };
      else if (result.status === "blocked") return this.escalate(t, lane, "blocked", "the agent is blocked", result.questions.join("\n") || result.summary, attempts, history);
      else if (result.status === "failed") failure = { reason: "the agent reported failure", details: result.summary };
      else {
        this.setState(t.id, "turnFinished");
        failure = await this.verify(t, lane, ctl.signal);
        if (ctl.signal.aborted) return this.stopParked(t, lane);
        if (!failure) {
          this.setState(t.id, "passed");
          const merged = await this.complete(t, lane, result);
          if (merged === true) return;
          failure = merged;
          // A stop pressed during the merge waited for it. The merge failed, so stop instead of a fix round.
          if (ctl.signal.aborted) return this.stopParked(t, lane);
        }
      }
      attempts++;
      this.store.updateTask(this.key, t.id, { attempts });
      if (attempts >= this.cfg.maxAttempts) return this.escalate(t, lane, "attemptsExhausted", failure.reason, failure.details, attempts, history);
      this.setState(t.id, "failed", {}, { note: `attempt ${attempts + 1}: ${failure.reason}`, details: failure.details });
      prompt = renderFixPrompt(t, failure.reason, failure.details, fenced);
    }
  }

  /** Stop: park the edits (Resume restores them) and wait for the human. */
  private async stopParked(t: PlanTask, lane: Lane): Promise<void> {
    const parked = await this.park(t, lane);
    const note = parked ? "stopped by you; edits kept on the stash" : "stopped by you";
    this.setState(t.id, "stop", { note }, { note });
  }

  /** Keep a stuck task's work recoverable on the stash and give the lane back clean. */
  private async park(t: PlanTask, lane: Lane): Promise<boolean> {
    if (!(await g.stashWip(lane.path, this.parkLabel(t)))) return false;
    this.say({ type: "info", message: `${t.id}: unfinished work kept on the stash in ${lane.path}; Resume restores it` });
    return true;
  }

  private parkLabel(t: PlanTask): string {
    return `harnessOrch ${this.id} ${t.id} (paused)`;
  }

  /** Tasks a human resumed on the same agent: restore their parked work. */
  private readonly resumed = new Set<string>();

  /** The engine's own definition of done: scope, then checks. */
  private async verify(t: PlanTask, lane: Lane, signal?: AbortSignal): Promise<{ reason: string; details: string } | null> {
    const paths = await changedPaths(lane.path);
    // Manifests are always in scope: agents may add dev dependencies on their own.
    const violations = scopeViolations(paths, [...t.writeScope, ...MANIFEST_GLOBS], this.protectedPaths);
    // Revert out-of-scope edits ourselves instead of spending a turn asking the worker to.
    let reverted = "";
    if (violations.length) {
      await g.revertPaths(lane.path, violations.map((v) => v.path));
      reverted = `The engine reverted changes outside your write scope (${t.writeScope.join(", ")}): ${violations.map((v) => `${v.path} (${v.reason})`).join(", ")}.`;
      this.say({ type: "info", message: `${t.id}: ${reverted}` });
    }
    const depsProblem = await this.guardDependencies(lane, paths, t.deps);
    if (depsProblem) {
      reverted = [reverted, depsProblem].filter(Boolean).join("\n");
      this.say({ type: "info", message: `${t.id}: ${depsProblem}` });
    }
    const checks = t.checks.length ? t.checks : this.plan.header.checks;
    if (!checks.length) return null;
    const results = await this.deps.runChecks(checks, lane.path, join(this.stateDir, "checks"), undefined, signal);
    if (checksPassed(results)) return null;
    return { reason: "checks failed", details: [reverted, formatCheckFailures(results)].filter(Boolean).join("\n\n") };
  }

  /**
   * Dev dependencies are the agent's call; production dependencies and changes to
   * existing packages are not. On a violation, revert every manifest and lockfile
   * the task touched (re-adding the allowed dev dependencies is the agent's job).
   */
  private async guardDependencies(lane: Lane, paths: readonly string[], allowed: readonly string[] = []): Promise<string | null> {
    const problems: string[] = [];
    for (const path of paths.filter((p) => /(^|\/)package\.json$/.test(p))) {
      const before = await g.tryGit(lane.path, ["show", `HEAD:${path}`]);
      let after: string | null = null;
      try { after = readFileSync(join(lane.path, path), "utf8"); } catch { /* deleted */ }
      problems.push(...dependencyViolations(before.code === 0 ? before.stdout : null, after, allowed).map((v) => `${path} ${v}`));
    }
    if (!problems.length) return null;
    await g.revertPaths(lane.path, paths.filter(isManifest));
    return `Dependency rule: only new dev dependencies may be added. Reverted package.json and lockfiles because of: ${problems.join("; ")}.`;
  }

  /** Install in a worktree whose manifests changed between two commits (after a merge or a lane sync). */
  private async syncDeps(cwd: string, from: string, to: string, where: string): Promise<void> {
    if (from === to) return;
    const changed = (await g.tryGit(cwd, ["diff", "--name-only", from, to])).stdout.split(/\r?\n/).filter(Boolean);
    if (!changed.some(isManifest)) return;
    const r = await this.deps.installDeps(cwd);
    this.say({ type: "info", message: r.ok ? `dependencies changed; installed them in the ${where} worktree` : `installing changed dependencies in the ${where} worktree failed:\n${r.output}` });
  }

  /** Fast-forward a lane onto the plan branch, then match its dependencies. */
  private async syncLaneDeps(lane: Lane): Promise<void> {
    const before = await g.headSha(lane.path);
    await g.syncLane(lane.path, this.planBranch);
    await this.syncDeps(lane.path, before, await g.headSha(lane.path), lane.agent);
  }

  /** Commit in the lane, merge into the plan branch, run plan checks, tick the box. */
  private async complete(t: PlanTask, lane: Lane, result: WorkerResult): Promise<true | { reason: string; details: string }> {
    const sha = await g.commitAll(lane.path, `${t.id}: ${t.title}`, lane.agent);
    const prior = this.commitsOf(t.id);
    let outcome: true | MergeFailure = true;
    if (sha) {
      outcome = await this.serialMerge(() => this.mergeLane(t, lane));
      // Merged (or kept despite failing plan checks): the lane fast-forwards onto the plan branch.
      await this.syncLaneDeps(lane);
      // Every commit that reached the plan branch belongs to the task and to its author's review.
      if (outcome === true || !outcome.notMerged) this.store.updateTask(this.key, t.id, { commitSha: [...prior, sha].join(" ") });
    } else if (prior.length) {
      // Nothing new to merge, but an earlier merge of this task failed the plan checks: they must pass now.
      outcome = await this.serialMerge(() => this.planChecks());
    }
    if (outcome !== true) return outcome;
    this.setState(t.id, "merged", { summary: result.summary, decisions: result.decisions, note: null });
    this.mark(t.id, { done: true });
    return true;
  }

  private serialMerge<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mergeChain.then(fn, fn);
    this.mergeChain = next.catch(() => undefined);
    return next;
  }

  private async mergeLane(t: PlanTask, lane: Lane): Promise<true | MergeFailure> {
    const before = await g.headSha(this.planWorktree);
    const m = await g.mergeNoFf(this.planWorktree, lane.branch, `Merge ${t.id}: ${t.title}`, lane.agent);
    if (!m.merged) {
      const resolved = await this.resolveConflict(t, m.conflicts);
      if (!resolved) {
        await g.abortMerge(this.planWorktree);
        // Uncommit in the lane so the worker can rebuild on top of the plan branch.
        await g.git(lane.path, ["reset", "-q", "--mixed", "HEAD~1"]);
        await g.discardChanges(lane.path);
        await this.syncLaneDeps(lane);
        return { reason: "merge conflict the orchestrator could not resolve", notMerged: true,
          details: `Conflicted files: ${m.conflicts.join(", ")}. Redo the task on top of the latest plan branch.` };
      }
    }
    // New dev dependencies from the lane must exist here before the plan checks run.
    await this.syncDeps(this.planWorktree, before, await g.headSha(this.planWorktree), "plan");
    // A failure keeps the merge; the lane fast-forwards onto it and the worker fixes forward.
    return this.planChecks();
  }

  private async guardPlanWorktree(agent: string, taskId: string | null): Promise<void> {
    const dirty = (await g.tryGit(this.planWorktree, ["status", "--porcelain"])).stdout.trim();
    if (!dirty) return;
    await g.discardChanges(this.planWorktree);
    this.say({ type: "info", message: `${agent}${taskId ? ` (${taskId})` : ""} changed the plan worktree outside its own; reverted: ${dirty.split(/\r?\n/).slice(0, 5).join(", ")}` });
  }

  /** The plan-level checks, on the integration branch. */
  private async planChecks(): Promise<true | MergeFailure> {
    if (!this.plan.header.checks.length) return true;
    const results = await this.deps.runChecks(this.plan.header.checks, this.planWorktree, join(this.stateDir, "checks"));
    return checksPassed(results) ? true : { reason: "plan checks failed after merging", details: formatCheckFailures(results) };
  }

  /** Commits of a task that reached the plan branch, oldest first. */
  private commitsOf(taskId: string): string[] {
    return (this.store.task(this.key, taskId)?.commitSha ?? "").split(" ").filter(Boolean);
  }

  private async resolveConflict(t: PlanTask, files: string[]): Promise<boolean> {
    const merged = this.store.tasks(this.key).filter((r) => r.status === "done").map((r) => this.task(r.id));
    for (const ref of this.orchestrators()) {
      this.say({ type: "info", message: `merge conflict on ${t.id} (${files.join(", ")}); ${ref.agent} is resolving` });
      const r = await this.turn(ref, { cwd: this.planWorktree, prompt: renderConflictPrompt(files, t, merged, this.plan.header.checks), taskId: t.id, phase: "conflict", session: "fresh" });
      if (r.usageLimit) continue;
      if ((await g.unresolvedPaths(this.planWorktree)).length === 0) {
        await g.concludeMerge(this.planWorktree, ref.agent);
        return true;
      }
    }
    return false;
  }

  private orchestrators(): AgentRef[] {
    const unavailable = this.currentlyUnavailable();
    return this.cfg.routing.orchestrator.filter((r) => !unavailable.has(r.agent));
  }

  /** A guardrail fired: ask the orchestrator once (Codex, then Opus), else pause for the human. */
  private async escalate(t: PlanTask, lane: Lane, event: "blocked" | "attemptsExhausted", reason: string, details: string, attempts: number, history: string[]): Promise<void> {
    const agent = lane.agent;
    this.setState(t.id, event);
    const row = this.store.task(this.key, t.id);
    if (!row?.orchestrated) {
      this.store.updateTask(this.key, t.id, { orchestrated: true });
      const decision = await this.decide(t, agent, reason, details, attempts, history);
      if (decision && decision.action !== "human") {
        this.guidance.set(t.id, decision.guidance);
        if (decision.action === "reassign" && decision.agent && decision.agent !== agent) {
          this.reassign(t, decision.agent);
          await this.park(t, lane);
        } else this.continuing.add(t.id);
        this.setState(t.id, "retry", { attempts: 0 }, { note: `orchestrator: ${decision.action}${decision.agent ? ` → ${decision.agent}` : ""}` });
        return;
      }
      if (decision) details = `${decision.guidance}\n\n${details}`;
    }
    await this.park(t, lane);
    this.pause(t.id, "human", `${reason}: ${details.split("\n")[0].slice(0, 200)}`, details);
  }

  /** Tasks the orchestrator sent back to the same agent: resume in place, keep the work tree. */
  private readonly continuing = new Set<string>();

  private async decide(t: PlanTask, agent: string, reason: string, details: string, attempts: number, history: string[]): Promise<Decision | null> {
    const available = AGENTS.filter((a) => !this.currentlyUnavailable().has(a));
    for (const ref of this.orchestrators()) {
      const prompt = renderDecisionPrompt({ planTitle: this.plan.header.title, task: t, agent, reason, details, attempts, history, availableAgents: available }, ref.agent === "opencode");
      const r = await this.turn(ref, { cwd: this.planWorktree, prompt, taskId: t.id, phase: "orchestrate", session: "fresh", schema: DECISION_SCHEMA, readOnly: true });
      const d = parseDecision(r.structured, AGENTS);
      if (d && d.action !== "human") return d;
      if (d && ref === this.orchestrators().at(-1)) return d;
    }
    return null;
  }

  private pause(taskId: string, event: "human" | "error", note: string, details?: string): void {
    this.setState(taskId, event, { note }, { note, ...(details ? { details } : {}) });
    this.mark(taskId, { done: false, note: `⏸ needs you: ${note.slice(0, 120)}` });
    this.say({ type: "needs-you", taskId, message: `${taskId} paused: ${note}` });
  }

  /** The human answered: retry the task, optionally with guidance or a different agent. */
  resumeTask(taskId: string, opts: { guidance?: string; agent?: AgentId } = {}): void {
    const t = this.task(taskId);
    const row = this.store.task(this.key, taskId);
    // A blocked agent asked a question; resending the same task without an answer just buys the same question again.
    if (row?.status === "waiting" && row.note?.startsWith("the agent is blocked") && !opts.guidance?.trim() && (!opts.agent || opts.agent === row.agent)) {
      throw new Error(`${taskId} is waiting for an answer to its question. Write your answer in the box, pick another agent, or skip the task.`);
    }
    if (!row || !canTransition(row.status, "resume")) throw new Error(`${taskId} is ${row?.status ?? "unknown"}; only a task that needs you can be resumed`);
    if (opts.guidance) this.guidance.set(taskId, opts.guidance);
    const current = row?.agent;
    if (opts.agent && opts.agent !== current) this.reassign(t, opts.agent);
    else this.resumed.add(taskId);
    // The orchestrator is not asked again: a human already looked, so a repeat failure comes straight back to you.
    this.setState(taskId, "resume", { attempts: 0, note: null }, { note: row.status === "interrupted" ? "continued after the app closed" : "resumed by you" });
    this.mark(taskId, { done: false });
    this.wakeUp();
  }

  /** Start the task over: drop its parked edits and attempts; its next turn gets a fresh brief. */
  async restartClean(taskId: string): Promise<void> {
    const row = this.store.task(this.key, taskId);
    if (!row || !canTransition(row.status, "restartClean")) throw new Error(`${taskId} is ${row?.status ?? "unknown"}; only a task that needs you can be restarted`);
    const lanePath = row.agent ? join(this.wtRoot, row.agent) : null;
    if (lanePath && existsSync(lanePath)) await g.dropStash(lanePath, this.parkLabel(this.task(taskId)));
    this.guidance.delete(taskId);
    this.resumed.delete(taskId);
    this.continuing.delete(taskId);
    this.setState(taskId, "restartClean", { attempts: 0, orchestrated: false, note: null }, { note: "restarted clean by you" });
    this.mark(taskId, { done: false });
    this.wakeUp();
  }

  /**
   * Stop one task now: kill its agent or check and park its edits. Its dependents wait.
   * During a merge the stop takes effect once the merge finishes.
   */
  stopTask(taskId: string): void {
    const row = this.store.task(this.key, taskId);
    const ctl = this.controllers.get(taskId);
    if (!row || !ctl || !STOPPABLE.includes(row.status)) {
      throw new Error(`${taskId} is ${row?.status ?? "unknown"}; only a working, checking or merging task can be stopped`);
    }
    ctl.abort();
    this.say({ type: "info", message: row.status === "merging" ? `${taskId}: stop requested; it takes effect when the merge finishes` : `${taskId}: stopping` });
  }

  /** No new dispatches, and every stoppable task in flight is stopped. Returns the tasks stopped. */
  stopAll(): string[] {
    this.stop();
    const stopped: string[] = [];
    for (const [id, ctl] of this.controllers) {
      const state = this.store.task(this.key, id)?.status;
      if (!state || !STOPPABLE.includes(state)) continue;
      ctl.abort();
      stopped.push(id);
    }
    if (stopped.length) this.say({ type: "info", message: `stopping ${stopped.join(", ")}` });
    return stopped;
  }

  /** The facts for the Stop confirm. */
  async stopInfo(taskId: string): Promise<StopInfo> {
    const row = this.store.task(this.key, taskId);
    if (!row) throw new Error(`unknown task ${taskId}`);
    const now = this.deps.now().getTime();
    const since = (iso: string | null): number | null => (iso ? Math.max(0, now - Date.parse(iso)) : null);
    const lanePath = row.agent ? join(this.wtRoot, row.agent) : null;
    const watcher = this.watchers.get(taskId);
    return {
      taskId, state: row.status, agent: row.agent,
      stoppable: STOPPABLE.includes(row.status) && this.controllers.has(taskId),
      deferred: row.status === "merging",
      phaseElapsedMs: since(row.phaseStartedAt),
      turnElapsedMs: row.status === "working" ? since(row.turnStartedAt) : null,
      tokensSoFar: row.agent === "codex" || !watcher ? null : watcher.spent,
      tokensNote: row.agent === "codex" ? "Codex reports tokens when the turn ends" : null,
      uncommittedFiles: lanePath && existsSync(lanePath) ? (await changedPaths(lanePath)).length : 0,
      dependents: this.dependentsOf(taskId),
      ifStopped: STATE_INFO[row.status].ifStopped,
      afterwards: ["Resume (edits restored, same session)", "Restart clean (edits dropped)", "Skip"],
    };
  }

  /** Unfinished tasks that depend on `taskId`, directly or through other tasks. */
  private dependentsOf(taskId: string): string[] {
    const states = new Map(this.store.tasks(this.key).map((r) => [r.id, r.status]));
    const out = new Set<string>();
    const visit = (id: string): void => {
      for (const t of this.plan.tasks) {
        if (!t.dependsOn.includes(id) || out.has(t.id)) continue;
        out.add(t.id);
        visit(t.id);
      }
    };
    visit(taskId);
    return [...out].filter((id) => !FINAL.includes(states.get(id) ?? "queued"));
  }

  /** The human decided a task is not needed: it counts as finished (no commit) so dependents can run. */
  skipTask(taskId: string): void {
    const row = this.store.task(this.key, taskId);
    const state = row?.status ?? "queued";
    if (FINAL.includes(state)) return;
    if (!canTransition(state, "skip")) throw new Error(`${taskId} is ${state}; stop it first`);
    this.setState(taskId, "skip", { summary: "Skipped by you.", note: null }, { note: "skipped by you" });
    this.mark(taskId, { done: true });
    this.wakeUp();
  }

  private reassign(t: PlanTask, agent: string): void {
    this.reassigned.delete(t.id);
    this.reassigned.set(t.id, this.candidates({ ...t, agent, model: undefined })[0]);
  }

  private mark(taskId: string, mark: TaskMark): void {
    try {
      const text = readFileSync(this.planPath, "utf8");
      const next = markTask(text, taskId, mark);
      if (next !== text) writeFileSync(this.planPath, next);
    } catch (error) {
      this.say({ type: "info", message: `could not update plan file: ${(error as Error).message}` });
    }
  }

  // ---- reviews -------------------------------------------------------------

  /** Agents that committed work in this plan. */
  private authors(): string[] {
    return [...new Set(this.store.tasks(this.key).filter((r) => r.status === "done" && r.commitSha && r.agent).map((r) => r.agent as string))];
  }

  /** An agent is reviewable once none of its tasks can still change. */
  private reviewable(agent: string): boolean {
    const rows = this.store.tasks(this.key);
    const pendingForAgent = this.plan.tasks.some((t) => {
      const row = rows.find((r) => r.id === t.id);
      if (row && FINAL.includes(row.status)) return false;
      return row?.agent === agent || this.candidates(t)[0]?.agent === agent;
    });
    return !pendingForAgent;
  }

  private reviewState(agent: string): "approved" | "rejected" | "pending" | "exhausted" {
    const last = this.store.reviews(this.key, agent).at(-1);
    if (!last) return "pending";
    if (last.decision === "approve") return "approved";
    return last.round >= this.cfg.maxReviewRounds + (this.extraRounds.get(agent) ?? 0) ? "exhausted" : "rejected";
  }

  /** Review rounds granted by "Review again", on top of maxReviewRounds. */
  private readonly extraRounds = new Map<string, number>();
  /** Authors whose next review must first fix the last round's findings (their fix never landed). */
  private readonly fixFirst = new Set<string>();

  private startReviews(): void {
    for (const agent of this.authors()) {
      const key = `review:${agent}`;
      if (this.inflight.has(key) || !this.reviewable(agent)) continue;
      const state = this.reviewState(agent);
      if (state === "approved" || this.reviewBlocked.has(agent)) continue;
      if (state === "exhausted") {
        this.blockReview(agent, `rejected ${this.cfg.maxReviewRounds} times`);
        continue;
      }
      if (!this.reviewerFor(agent)) continue;
      // The author is busy too: review fixes run in its lane session.
      this.track(agent, key, this.review(agent));
    }
  }

  /** Reviews that could run but every reviewer is at its limit. */
  private waitForReviewers(): number | null {
    const waiting = this.authors().filter((a) => this.reviewable(a) && !this.reviewBlocked.has(a) &&
      ["pending", "rejected"].includes(this.reviewState(a)) && !this.reviewerFor(a));
    if (!waiting.length) return null;
    const now = this.deps.now().getTime();
    const until = Math.min(...[...this.unavailableUntil.values()].filter((u) => u > now));
    return Number.isFinite(until) ? Math.max(60_000, until - now) : null;
  }

  private readonly reviewBlocked = new Set<string>();
  private readonly reviewFailures = new Map<string, number>();

  private blockReview(agent: string, why: string): void {
    this.reviewBlocked.add(agent);
    this.say({ type: "needs-you", message: `review of ${agent}'s work needs you: ${why}` });
  }

  /** The human looked at a blocked review: approve as-is or let the engine review again. */
  resolveReview(agent: string, action: "approve" | "retry"): void {
    this.reviewBlocked.delete(agent);
    this.reviewFailures.delete(agent);
    if (action === "approve") {
      const round = (this.store.reviews(this.key, agent).at(-1)?.round ?? 0) + 1;
      this.store.addReview({ planId: this.key, agent, round, reviewer: "human", decision: "approve", notes: "approved by you" });
    } else {
      // One more fix-and-review cycle: the author addresses the last findings, then a fresh review runs.
      this.extraRounds.set(agent, (this.extraRounds.get(agent) ?? 0) + 1);
      if (this.store.reviews(this.key, agent).at(-1)?.decision === "request-changes") this.fixFirst.add(agent);
    }
    this.wakeUp();
  }

  private readyToMerge(): boolean {
    if (!planFinished(this.schedTasks())) return false;
    return this.authors().every((a) => this.reviewState(a) === "approved");
  }

  private reviewerFor(author: string): AgentRef | undefined {
    const unavailable = this.currentlyUnavailable();
    return (this.cfg.reviewers[author] ?? this.cfg.routing.review).find((r) => !unavailable.has(r.agent));
  }

  private async review(author: string): Promise<void> {
    const round = (this.store.reviews(this.key, author).at(-1)?.round ?? 0) + 1;
    const rows = this.store.tasks(this.key).filter((r) => r.agent === author && r.status === "done" && r.commitSha);
    const tasks = rows.map((r) => this.task(r.id));
    if (this.fixFirst.delete(author)) {
      const last = this.store.reviews(this.key, author).at(-1);
      if (last && last.decision === "request-changes" && tasks.length) {
        await this.reviewFix(author as AgentId, tasks, last.notes);
        if (this.reviewBlocked.has(author)) return;
      }
    }
    const reviewer = this.reviewerFor(author);
    if (!reviewer) return;
    const { diff } = await g.commitsDiff(this.planWorktree, rows.flatMap((r) => this.commitsOf(r.id)).concat(this.fixCommits.get(author) ?? []));
    this.say({ type: "info", message: `${reviewer.agent} is reviewing ${author}'s work (round ${round})` });
    const r = await this.turn(reviewer, { cwd: this.planWorktree, prompt: renderReviewPrompt(author, tasks, diff, reviewer.agent === "opencode", this.skillPaths("reviewer", [])),
      taskId: null, phase: "review", session: "fresh", schema: VERDICT_SCHEMA, readOnly: true });
    if (r.usageLimit) return;
    const verdict = parseVerdict(r.structured);
    if (!verdict) {
      const n = (this.reviewFailures.get(author) ?? 0) + 1;
      this.reviewFailures.set(author, n);
      if (n >= 2) this.blockReview(author, `${reviewer.agent} gave no valid verdict twice`);
      return;
    }
    this.store.addReview({ planId: this.key, agent: author, round, reviewer: reviewer.agent, decision: verdict.decision, notes: verdict.notes });
    this.say({ type: "info", message: `review of ${author}: ${verdict.decision}${verdict.followups.length ? ` (${verdict.followups.length} follow-ups)` : ""}` });
    if (verdict.decision === "approve") return;
    if (round >= this.cfg.maxReviewRounds) return this.blockReview(author, `rejected ${round} times: ${verdict.notes.slice(0, 300)}`);
    await this.reviewFix(author as AgentId, tasks, verdict.notes);
  }

  private readonly fixCommits = new Map<string, string[]>();

  /** Fix review findings in the author's own lane session, then re-review. */
  private async reviewFix(agent: AgentId, tasks: PlanTask[], notes: string): Promise<void> {
    const lane = await this.lane(agent);
    await this.syncLaneDeps(lane);
    const synthetic: PlanTask = {
      id: `review-${agent}`, title: "Review fixes", role: "implement", dependsOn: [], goal: notes, doneWhen: ["every review note is addressed"],
      checks: [...new Set(tasks.flatMap((t) => t.checks))], writeScope: [...new Set(tasks.flatMap((t) => t.writeScope))],
      readFirst: [], skills: [], images: false, deps: [...new Set(tasks.flatMap((t) => t.deps))], done: false, line: -1,
    };
    const ref = this.candidates(tasks[0]).find((c) => c.agent === agent) ?? { agent };
    const r = await this.turn(ref, { cwd: lane.path, prompt: renderFixPrompt(synthetic, "the reviewer requested changes", notes, agent === "opencode"),
      taskId: null, phase: "fix", session: "lane", schema: RESULT_SCHEMA });
    const result = parseWorkerResult(r.structured);
    const failure = result?.status === "done" ? await this.verify(synthetic, lane) : { reason: "fix failed", details: result?.summary ?? r.text.slice(-500) };
    if (failure) {
      await g.stashWip(lane.path, `harnessOrch ${this.id} review fixes (${agent})`);
      return this.blockReview(agent, `${agent} could not fix the findings: ${failure.reason}`);
    }
    const sha = await g.commitAll(lane.path, `Review fixes (${agent})`, agent);
    if (!sha) return this.blockReview(agent, `${agent} made no changes for the review findings`);
    const merged = await this.serialMerge(() => this.mergeLane(synthetic, lane));
    await this.syncLaneDeps(lane);
    if (merged !== true) return this.blockReview(agent, `review fixes did not merge: ${merged.reason}`);
    this.fixCommits.set(agent, [...(this.fixCommits.get(agent) ?? []), sha]);
  }

  // ---- finish --------------------------------------------------------------

  /** One click: merge the plan branch into the base branch in the main checkout. */
  async mergeToBase(): Promise<string> {
    if (!this.planBranch) await this.prepare();
    if (!this.readyToMerge()) throw new Error("plan is not ready: tasks or reviews are still open");
    const branch = await g.currentBranch(this.repo);
    if (branch !== this.baseBranch) throw new Error(`main checkout is on ${branch}; switch to ${this.baseBranch} first`);
    const m = await g.mergeNoFf(this.repo, this.planBranch, `harnessOrch: ${this.plan.header.title}`, "harnessOrch");
    if (!m.merged) {
      await g.abortMerge(this.repo);
      throw new Error(`merge into ${this.baseBranch} conflicts in ${m.conflicts.join(", ")}`);
    }
    this.setStatus("merged", `merged into ${this.baseBranch}`);
    const sha = await g.headSha(this.repo);
    await this.cleanup();
    return sha;
  }

  /** Remove the plan's worktrees and branches once merged. Dirty worktrees are kept (and reported). */
  private async cleanup(): Promise<void> {
    const kept: string[] = [];
    for (const name of ["plan", ...AGENTS]) {
      const path = join(this.wtRoot, name);
      const branch = name === "plan" ? this.planBranch : `${this.planBranch}--${name}`;
      // Unlink shared dependency junctions first: Git for Windows can recurse through them and delete the real folder.
      if (existsSync(path) && !prepareWorktreeRemoval(path)) {
        kept.push(path);
        continue;
      }
      if ((await g.tryGit(this.repo, ["worktree", "remove", path])).code !== 0 && existsSync(path)) kept.push(path);
      await g.tryGit(this.repo, ["branch", "-d", branch]);
    }
    await g.tryGit(this.repo, ["worktree", "prune"]);
    if (kept.length) this.say({ type: "info", message: `kept worktrees with uncommitted work: ${kept.join(", ")}` });
  }

  /** Snapshot for the board. */
  snapshot() {
    const rows = new Map(this.store.tasks(this.key).map((r) => [r.id, r]));
    const runs = this.store.runs(this.key);
    const effective: Record<string, number> = {};
    for (const run of runs) effective[run.agent] = (effective[run.agent] ?? 0) + run.effective;
    return {
      id: this.id, title: this.plan?.header.title ?? this.id, status: this.store.plan(this.key)?.status,
      checks: this.plan?.header.checks ?? [], skills: this.plan?.header.skills ?? [], baseBranch: this.baseBranch || null,
      tasks: (this.plan?.tasks ?? []).map((t) => {
        const r = rows.get(t.id);
        const status: TaskState = r?.status ?? (t.done ? "done" : "queued");
        return { ...t, status, next: STATE_INFO[status].next, phaseStartedAt: r?.phaseStartedAt ?? null, assigned: r?.agent ?? this.candidates(t)[0]?.agent ?? null,
          note: r?.note ?? null, attempts: r?.attempts ?? 0, summary: r?.summary ?? null, decisions: r?.decisions ?? [], commits: this.commitsOf(t.id) };
      }),
      runs,
      agentStates: this.agentStates(),
      effective,
    };
  }
}
