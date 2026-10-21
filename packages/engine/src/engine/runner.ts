import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_CONFIG, type AgentRef, type EngineConfig } from "../config.js";
import { runTurn as defaultRunTurn, type AgentId, type TurnRequest, type TurnResult } from "../agents/turn.js";
import { parseWorkerResult, renderBrief, renderFixPrompt, renderHandoff, RESULT_SCHEMA, type WorkerResult } from "../brief/brief.js";
import { changedPaths, checksPassed, formatCheckFailures, runChecks as defaultRunChecks, scopeViolations, type CheckResult } from "../checks/checks.js";
import { lockPathsOverlap } from "../git/path-locks.js";
import { budgetWatcher, effectiveTokens } from "../ledger/effective.js";
import { orchHome, projectId } from "../ledger/telemetry.js";
import { DECISION_SCHEMA, parseDecision, renderConflictPrompt, renderDecisionPrompt, type Decision } from "../orchestrator/orchestrator.js";
import { markTask, parsePlan, validatePlan, type Plan, type PlanTask, type TaskMark } from "../plan/plan.js";
import { parseVerdict, renderReviewPrompt, VERDICT_SCHEMA } from "../review/review.js";
import { blockedBy, nextDispatches, planFinished, type SchedTask } from "../scheduler/scheduler.js";
import { listSkills, selectSkills, type Skill, type SkillRole } from "../skills/skills.js";
import type { PlanStatus, RunPhase, Store } from "../store/store.js";
import * as g from "./git.js";
import { prepareWorktreeRemoval } from "../git/worktree.js";

export interface RunnerDeps {
  runTurn: (req: TurnRequest) => Promise<TurnResult>;
  runChecks: (commands: readonly string[], cwd: string, logDir: string, timeoutMs?: number) => Promise<CheckResult[]>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
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
  | { type: "task"; taskId: string; status: string; agent?: string; note?: string }
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

/** Why a finished task could not be accepted yet. `notMerged`: its commit never reached the plan branch. */
interface MergeFailure {
  reason: string;
  details: string;
  notMerged?: true;
}

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

  constructor(opts: RunnerOptions) {
    super();
    this.repo = resolve(opts.repo);
    this.planPath = isAbsolute(opts.planFile) ? opts.planFile : join(this.repo, opts.planFile);
    this.planRel = relative(this.repo, this.planPath).replaceAll("\\", "/");
    this.id = basename(this.planPath).replace(/\.md$/i, "");
    this.key = planKey(this.repo, this.planPath);
    this.cfg = opts.config ?? DEFAULT_CONFIG;
    this.store = opts.store;
    this.deps = { runTurn: defaultRunTurn, runChecks: defaultRunChecks, now: () => new Date(), sleep, ...opts.deps };
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
    // A previous app session that died mid-run leaves rows "running"; this process has nothing in flight yet.
    for (const t of this.store.tasks(this.key)) if (t.status === "running") this.store.updateTask(this.key, t.id, { status: "pending" });
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

  private async linkShared(worktree: string): Promise<void> {
    const linked = await g.provideSharedDirs(this.repo, worktree, this.cfg.sharedDirs);
    if (linked.length) this.say({ type: "info", message: `provided ${linked.join(", ")} to the ${basename(worktree)} worktree (hard-linked copy)` });
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
        const paused = [...this.store.tasks(this.key).filter((t) => t.status === "paused").map((t) => t.id), ...[...this.reviewBlocked].map((a) => `review of ${a}`)];
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

  private track(agent: string, key: string, work: Promise<void>): void {
    this.busy.add(agent);
    const p = work.catch((error: unknown) => {
      this.say({ type: "info", message: `${key} crashed: ${error instanceof Error ? error.message : String(error)}` });
      const taskId = key.startsWith("task:") ? key.slice(5) : null;
      if (taskId) this.pause(taskId, `engine error: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.inflight.delete(key);
      this.busy.delete(agent);
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
      status: rows.get(t.id)?.status ?? (t.done ? "done" : "pending"),
    }));
  }

  private currentlyUnavailable(): Set<string> {
    const now = this.deps.now().getTime();
    return new Set([...this.unavailableUntil].filter(([, until]) => until > now).map(([a]) => a));
  }

  /** When pending work is blocked only by usage limits, how long until the first one lifts. */
  private waitForLimits(sched: readonly SchedTask[], unavailable: ReadonlySet<string>): number | null {
    const blocked = blockedBy(sched);
    const waiting = sched.filter((t) => t.status === "pending" && !blocked.has(t.id) && t.candidates.every((c) => unavailable.has(c.agent)));
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
    schema?: object; readOnly?: boolean; images?: boolean;
  }): Promise<TurnResult> {
    const agent = ref.agent as AgentId;
    const prior = opts.session === "lane" && !this.rotate.has(agent) ? this.store.session(this.key, agent) : undefined;
    const logFile = this.logFile(`${opts.taskId ?? opts.phase}-${agent}`);
    const result = await this.deps.runTurn({
      agent, model: ref, cwd: opts.cwd, prompt: opts.prompt, logFile,
      ...(prior ? { resumeSession: prior.sessionId } : {}),
      ...(opts.schema && agent !== "opencode" ? { schema: opts.schema } : {}),
      readOnly: opts.readOnly, imageGeneration: opts.images, adapter: this.cfg.adapters[agent],
      checkCommands: [...new Set([...this.plan.header.checks, ...this.plan.tasks.flatMap((t) => t.checks)])],
      timeoutMs: opts.phase === "review" ? this.cfg.reviewTimeoutMs : this.cfg.taskTimeoutMs,
      onLine: (line) => this.emit("event", { type: "line", agent, taskId: opts.taskId, line }),
      abortOn: budgetWatcher(agent, this.budgetFor(agent, opts.phase)),
    });
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
      } else this.store.saveSession({ planId: this.key, agent, sessionId: result.sessionId, contextTokens: result.usage.contextTokens, turns });
    }
    if (result.usageLimit) this.markLimited(agent, result.usageLimit.resetAt);
    // Workers must stay in their own worktree. The plan worktree is the integration branch: undo stray edits there.
    if (opts.cwd !== this.planWorktree) await this.serialMerge(() => this.guardPlanWorktree(agent, opts.taskId));
    return result;
  }

  private async runTask(t: PlanTask, ref: AgentRef): Promise<void> {
    const agent = ref.agent as AgentId;
    this.store.updateTask(this.key, t.id, { status: "running", agent, model: ref.model ?? null, note: null });
    this.say({ type: "task", taskId: t.id, status: "running", agent });
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
      await g.syncLane(lane.path, this.planBranch);
      // A human resume puts the paused attempt's work back instead of redoing it from scratch.
      const parked = resumedByHuman ? await g.findStash(lane.path, this.parkLabel(t)) : null;
      if (parked && await g.applyStash(lane.path, parked)) {
        this.say({ type: "info", message: `${t.id}: restored the paused attempt's work` });
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
      if (this.stopped) {
        this.store.updateTask(this.key, t.id, { status: "pending" });
        return;
      }
      const r = await this.turn(ref, { cwd: lane.path, prompt, taskId: t.id, phase: attempts ? "fix" : "implement", session: "lane", schema: RESULT_SCHEMA, images: t.images });
      if (r.usageLimit) {
        await g.discardChanges(lane.path);
        this.store.dropSession(this.key, agent);
        this.store.updateTask(this.key, t.id, { status: "pending", agent: null });
        this.say({ type: "task", taskId: t.id, status: "pending", note: `${agent} at usage limit` });
        return;
      }
      const result = parseWorkerResult(r.structured);
      if (result) history.push(`${result.status}: ${result.summary}`);
      let failure: { reason: string; details: string } | null = null;
      if (!result) failure = { reason: r.aborted ?? (r.timedOut ? "the run timed out" : `no valid result (exit ${r.code})`), details: r.text.slice(-1500) };
      else if (result.status === "blocked") return this.escalate(t, lane, "the agent is blocked", result.questions.join("\n") || result.summary, attempts, history);
      else if (result.status === "failed") failure = { reason: "the agent reported failure", details: result.summary };
      else failure = await this.verify(t, lane);

      if (!failure) {
        const merged = await this.complete(t, lane, result as WorkerResult);
        if (merged === true) return;
        failure = merged;
      }
      attempts++;
      this.store.updateTask(this.key, t.id, { attempts });
      if (attempts >= this.cfg.maxAttempts) return this.escalate(t, lane, failure.reason, failure.details, attempts, history);
      this.say({ type: "task", taskId: t.id, status: "running", agent, note: `attempt ${attempts + 1}: ${failure.reason}` });
      prompt = renderFixPrompt(t, failure.reason, failure.details, fenced);
    }
  }

  /** Keep a stuck task's work recoverable on the stash and give the lane back clean. */
  private async park(t: PlanTask, lane: Lane): Promise<void> {
    if (await g.stashWip(lane.path, this.parkLabel(t))) {
      this.say({ type: "info", message: `${t.id}: unfinished work kept on the stash in ${lane.path}; Resume restores it` });
    }
  }

  private parkLabel(t: PlanTask): string {
    return `harnessOrch ${this.id} ${t.id} (paused)`;
  }

  /** Paused tasks a human resumed on the same agent: restore their parked work. */
  private readonly resumed = new Set<string>();

  /** The engine's own definition of done: scope, then checks. */
  private async verify(t: PlanTask, lane: Lane): Promise<{ reason: string; details: string } | null> {
    const paths = await changedPaths(lane.path);
    const violations = scopeViolations(paths, t.writeScope, this.protectedPaths);
    // Revert out-of-scope edits ourselves instead of spending a turn asking the worker to.
    let reverted = "";
    if (violations.length) {
      await g.revertPaths(lane.path, violations.map((v) => v.path));
      reverted = `The engine reverted changes outside your write scope (${t.writeScope.join(", ")}): ${violations.map((v) => `${v.path} (${v.reason})`).join(", ")}.`;
      this.say({ type: "info", message: `${t.id}: ${reverted}` });
    }
    const checks = t.checks.length ? t.checks : this.plan.header.checks;
    if (!checks.length) return null;
    const results = await this.deps.runChecks(checks, lane.path, join(this.stateDir, "checks"));
    if (checksPassed(results)) return null;
    return { reason: "checks failed", details: [reverted, formatCheckFailures(results)].filter(Boolean).join("\n\n") };
  }

  /** Commit in the lane, merge into the plan branch, run plan checks, tick the box. */
  private async complete(t: PlanTask, lane: Lane, result: WorkerResult): Promise<true | { reason: string; details: string }> {
    const sha = await g.commitAll(lane.path, `${t.id}: ${t.title}`, lane.agent);
    const prior = this.commitsOf(t.id);
    let outcome: true | MergeFailure = true;
    if (sha) {
      outcome = await this.serialMerge(() => this.mergeLane(t, lane));
      // Merged (or kept despite failing plan checks): the lane fast-forwards onto the plan branch.
      await g.syncLane(lane.path, this.planBranch);
      // Every commit that reached the plan branch belongs to the task and to its author's review.
      if (outcome === true || !outcome.notMerged) this.store.updateTask(this.key, t.id, { commitSha: [...prior, sha].join(" ") });
    } else if (prior.length) {
      // Nothing new to merge, but an earlier merge of this task failed the plan checks: they must pass now.
      outcome = await this.serialMerge(() => this.planChecks());
    }
    if (outcome !== true) return outcome;
    this.store.updateTask(this.key, t.id, { status: "done", summary: result.summary, decisions: result.decisions, note: null });
    this.mark(t.id, { done: true });
    this.say({ type: "task", taskId: t.id, status: "done", agent: lane.agent });
    return true;
  }

  private serialMerge<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mergeChain.then(fn, fn);
    this.mergeChain = next.catch(() => undefined);
    return next;
  }

  private async mergeLane(t: PlanTask, lane: Lane): Promise<true | MergeFailure> {
    const m = await g.mergeNoFf(this.planWorktree, lane.branch, `Merge ${t.id}: ${t.title}`, lane.agent);
    if (!m.merged) {
      const resolved = await this.resolveConflict(t, m.conflicts);
      if (!resolved) {
        await g.abortMerge(this.planWorktree);
        // Uncommit in the lane so the worker can rebuild on top of the plan branch.
        await g.git(lane.path, ["reset", "-q", "--mixed", "HEAD~1"]);
        await g.discardChanges(lane.path);
        await g.syncLane(lane.path, this.planBranch);
        return { reason: "merge conflict the orchestrator could not resolve", notMerged: true,
          details: `Conflicted files: ${m.conflicts.join(", ")}. Redo the task on top of the latest plan branch.` };
      }
    }
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
  private async escalate(t: PlanTask, lane: Lane, reason: string, details: string, attempts: number, history: string[]): Promise<void> {
    const agent = lane.agent;
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
        this.store.updateTask(this.key, t.id, { status: "pending", attempts: 0 });
        this.say({ type: "task", taskId: t.id, status: "pending", note: `orchestrator: ${decision.action}${decision.agent ? ` → ${decision.agent}` : ""}` });
        return;
      }
      if (decision) details = `${decision.guidance}\n\n${details}`;
    }
    await this.park(t, lane);
    this.pause(t.id, `${reason}: ${details.split("\n")[0].slice(0, 200)}`);
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

  private pause(taskId: string, note: string): void {
    this.store.updateTask(this.key, taskId, { status: "paused", note });
    this.mark(taskId, { done: false, note: `⏸ needs you: ${note.slice(0, 120)}` });
    this.say({ type: "task", taskId, status: "paused", note });
    this.say({ type: "needs-you", taskId, message: `${taskId} paused: ${note}` });
  }

  /** The human answered: retry the task, optionally with guidance or a different agent. */
  resumeTask(taskId: string, opts: { guidance?: string; agent?: AgentId } = {}): void {
    const t = this.task(taskId);
    if (opts.guidance) this.guidance.set(taskId, opts.guidance);
    const current = this.store.task(this.key, taskId)?.agent;
    if (opts.agent && opts.agent !== current) this.reassign(t, opts.agent);
    else this.resumed.add(taskId);
    // The orchestrator is not asked again: a human already looked, so a repeat failure comes straight back to you.
    this.store.updateTask(this.key, taskId, { status: "pending", attempts: 0, note: null });
    this.mark(taskId, { done: false });
    this.say({ type: "task", taskId, status: "pending", note: "resumed by you" });
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
      if (row?.status === "done") return false;
      return row?.agent === agent || this.candidates(t)[0]?.agent === agent;
    });
    return !pendingForAgent;
  }

  private reviewState(agent: string): "approved" | "rejected" | "pending" | "exhausted" {
    const last = this.store.reviews(this.key, agent).at(-1);
    if (!last) return "pending";
    if (last.decision === "approve") return "approved";
    return last.round >= this.cfg.maxReviewRounds ? "exhausted" : "rejected";
  }

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
    await g.syncLane(lane.path, this.planBranch);
    const synthetic: PlanTask = {
      id: `review-${agent}`, title: "Review fixes", role: "implement", dependsOn: [], goal: notes, doneWhen: ["every review note is addressed"],
      checks: [...new Set(tasks.flatMap((t) => t.checks))], writeScope: [...new Set(tasks.flatMap((t) => t.writeScope))],
      readFirst: [], skills: [], images: false, done: false, line: -1,
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
    await g.syncLane(lane.path, this.planBranch);
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
  snapshot(): { id: string; title: string; status: PlanStatus | undefined; tasks: Array<PlanTask & { status: string; assigned: string | null; note: string | null; attempts: number }>; effective: Record<string, number> } {
    const rows = new Map(this.store.tasks(this.key).map((r) => [r.id, r]));
    const effective: Record<string, number> = {};
    for (const run of this.store.runs(this.key)) effective[run.agent] = (effective[run.agent] ?? 0) + run.effective;
    return {
      id: this.id, title: this.plan?.header.title ?? this.id, status: this.store.plan(this.key)?.status,
      tasks: (this.plan?.tasks ?? []).map((t) => {
        const r = rows.get(t.id);
        return { ...t, status: r?.status ?? "pending", assigned: r?.agent ?? this.candidates(t)[0]?.agent ?? null, note: r?.note ?? null, attempts: r?.attempts ?? 0 };
      }),
      effective,
    };
  }
}
