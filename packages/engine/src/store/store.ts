import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ThreadTotals, TurnUsage } from "../agents/turn.js";
import { LEGACY_STATES, type TaskState } from "../engine/lifecycle.js";

export type PlanStatus = "running" | "paused" | "reviewing" | "ready" | "merged" | "stopped" | "discarded";
export type RunPhase = "implement" | "fix" | "review" | "orchestrate" | "conflict";

export interface PlanRow {
  id: string;
  repo: string;
  file: string;
  baseBranch: string;
  planBranch: string;
  status: PlanStatus;
  createdAt: string;
}

export interface TaskRow {
  planId: string;
  id: string;
  status: TaskState;
  agent: string | null;
  model: string | null;
  attempts: number;
  note: string | null;
  summary: string | null;
  decisions: string[];
  commitSha: string | null;
  /** Set once the orchestrator has intervened, so it is asked at most once per task. */
  orchestrated: boolean;
  /** When the task entered its current state. */
  phaseStartedAt: string | null;
  /** When its latest agent turn started. */
  turnStartedAt: string | null;
}

export interface SessionRow {
  planId: string;
  agent: string;
  sessionId: string;
  contextTokens: number;
  turns: number;
  /** Codex: the thread's running usage after its last turn. */
  threadTotals?: ThreadTotals;
}

export interface RunRow {
  planId: string;
  taskId: string | null;
  agent: string;
  model: string | null;
  phase: RunPhase;
  outcome: string;
  usage: TurnUsage;
  effective: number;
  durationMs: number;
  logFile: string | null;
  ts: string;
}

export interface ReviewRow {
  planId: string;
  agent: string;
  round: number;
  reviewer: string;
  decision: "approve" | "request-changes";
  notes: string;
}

export interface EventRow {
  id: number;
  planId: string;
  ts: string;
  type: string;
  data: Record<string, unknown>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, file TEXT NOT NULL, base_branch TEXT NOT NULL,
  plan_branch TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (
  plan_id TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, agent TEXT, model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, note TEXT, summary TEXT, decisions TEXT NOT NULL DEFAULT '[]',
  commit_sha TEXT, orchestrated INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (plan_id, id));
CREATE TABLE IF NOT EXISTS sessions (
  plan_id TEXT NOT NULL, agent TEXT NOT NULL, session_id TEXT NOT NULL,
  context_tokens INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, thread_totals TEXT,
  PRIMARY KEY (plan_id, agent));
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, task_id TEXT, agent TEXT NOT NULL, model TEXT,
  phase TEXT NOT NULL, outcome TEXT NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL, output INTEGER NOT NULL, requests INTEGER NOT NULL, context_tokens INTEGER NOT NULL,
  effective INTEGER NOT NULL, duration_ms INTEGER NOT NULL, log_file TEXT, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reviews (
  plan_id TEXT NOT NULL, agent TEXT NOT NULL, round INTEGER NOT NULL, reviewer TEXT NOT NULL,
  decision TEXT NOT NULL, notes TEXT NOT NULL, PRIMARY KEY (plan_id, agent, round));
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id TEXT NOT NULL, ts TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);
`;

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Engine state in one local SQLite file. Synchronous (node:sqlite), so callers never interleave writes. */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as Row[];
    if (!sessionColumns.some((c) => c.name === "thread_totals")) this.db.exec("ALTER TABLE sessions ADD COLUMN thread_totals TEXT");
    const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all() as Row[];
    for (const col of ["phase_started_at", "turn_started_at"]) {
      if (!taskColumns.some((c) => c.name === col)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col} TEXT`);
    }
    // Statuses from before the task lifecycle. A row left "running" belonged to a process that is gone.
    const legacy = this.db.prepare("UPDATE tasks SET status = ? WHERE status = ?");
    for (const [from, to] of Object.entries(LEGACY_STATES)) legacy.run(to, from);
  }

  close(): void { this.db.close(); }

  now(): string { return new Date().toISOString(); }

  upsertPlan(p: Omit<PlanRow, "createdAt"> & { createdAt?: string }): void {
    this.db.prepare(`INSERT INTO plans (id, repo, file, base_branch, plan_branch, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET repo = excluded.repo, file = excluded.file, base_branch = excluded.base_branch,
      plan_branch = excluded.plan_branch, status = excluded.status`)
      .run(p.id, p.repo, p.file, p.baseBranch, p.planBranch, p.status, p.createdAt ?? this.now());
  }

  plan(id: string): PlanRow | undefined {
    const r = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as Row | undefined;
    return r && this.toPlan(r);
  }

  plans(): PlanRow[] {
    return (this.db.prepare("SELECT * FROM plans ORDER BY created_at DESC").all() as Row[]).map((r) => this.toPlan(r));
  }

  setPlanStatus(id: string, status: PlanStatus): void {
    this.db.prepare("UPDATE plans SET status = ? WHERE id = ?").run(status, id);
  }

  private toPlan(r: Row): PlanRow {
    return { id: r.id as string, repo: r.repo as string, file: r.file as string, baseBranch: r.base_branch as string,
      planBranch: r.plan_branch as string, status: r.status as PlanStatus, createdAt: r.created_at as string };
  }

  /** Insert tasks that are new; existing rows keep their run state. */
  syncTasks(planId: string, tasks: readonly { id: string; done: boolean }[]): void {
    const stmt = this.db.prepare("INSERT OR IGNORE INTO tasks (plan_id, id, status) VALUES (?, ?, ?)");
    for (const t of tasks) stmt.run(planId, t.id, t.done ? "done" : "queued");
  }

  tasks(planId: string): TaskRow[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE plan_id = ?").all(planId) as Row[]).map((r) => ({
      planId, id: r.id as string, status: r.status as TaskState, agent: str(r.agent), model: str(r.model),
      attempts: Number(r.attempts), note: str(r.note), summary: str(r.summary),
      decisions: JSON.parse((r.decisions as string) || "[]") as string[], commitSha: str(r.commit_sha), orchestrated: Number(r.orchestrated) === 1,
      phaseStartedAt: str(r.phase_started_at), turnStartedAt: str(r.turn_started_at),
    }));
  }

  task(planId: string, id: string): TaskRow | undefined {
    return this.tasks(planId).find((t) => t.id === id);
  }

  updateTask(planId: string, id: string, patch: Partial<Omit<TaskRow, "planId" | "id">>): void {
    const encode: { [K in keyof typeof patch]-?: [string, (v: NonNullable<(typeof patch)[K]> | null) => string | number | null] } = {
      status: ["status", (v) => v], agent: ["agent", (v) => v], model: ["model", (v) => v], attempts: ["attempts", (v) => v],
      note: ["note", (v) => v], summary: ["summary", (v) => v], decisions: ["decisions", (v) => JSON.stringify(v ?? [])],
      commitSha: ["commit_sha", (v) => v], orchestrated: ["orchestrated", (v) => (v ? 1 : 0)],
      phaseStartedAt: ["phase_started_at", (v) => v], turnStartedAt: ["turn_started_at", (v) => v],
    };
    const set = (Object.keys(patch) as (keyof typeof patch)[]).filter((k) => patch[k] !== undefined && k in encode);
    if (!set.length) return;
    const values = set.map((k) => (encode[k][1] as (v: unknown) => string | number | null)(patch[k] ?? null));
    this.db.prepare(`UPDATE tasks SET ${set.map((k) => `${encode[k][0]} = ?`).join(", ")} WHERE plan_id = ? AND id = ?`)
      .run(...values, planId, id);
  }

  session(planId: string, agent: string): SessionRow | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE plan_id = ? AND agent = ?").get(planId, agent) as Row | undefined;
    const totals = str(r?.thread_totals);
    return r && {
      planId, agent, sessionId: r.session_id as string, contextTokens: Number(r.context_tokens), turns: Number(r.turns),
      ...(totals ? { threadTotals: JSON.parse(totals) as ThreadTotals } : {}),
    };
  }

  saveSession(s: SessionRow): void {
    this.db.prepare(`INSERT INTO sessions (plan_id, agent, session_id, context_tokens, turns, thread_totals) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(plan_id, agent) DO UPDATE SET session_id = excluded.session_id, context_tokens = excluded.context_tokens,
        turns = excluded.turns, thread_totals = excluded.thread_totals`)
      .run(s.planId, s.agent, s.sessionId, s.contextTokens, s.turns, s.threadTotals ? JSON.stringify(s.threadTotals) : null);
  }

  dropSession(planId: string, agent: string): void {
    this.db.prepare("DELETE FROM sessions WHERE plan_id = ? AND agent = ?").run(planId, agent);
  }

  addRun(r: Omit<RunRow, "ts">): void {
    this.db.prepare(`INSERT INTO runs (plan_id, task_id, agent, model, phase, outcome, input, cache_read, cache_write, output,
      requests, context_tokens, effective, duration_ms, log_file, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.planId, r.taskId, r.agent, r.model, r.phase, r.outcome, r.usage.input, r.usage.cacheRead, r.usage.cacheWrite,
        r.usage.output, r.usage.requests, r.usage.contextTokens, r.effective, r.durationMs, r.logFile, this.now());
  }

  runs(planId: string): RunRow[] {
    return (this.db.prepare("SELECT * FROM runs WHERE plan_id = ? ORDER BY id").all(planId) as Row[]).map((r) => ({
      planId, taskId: str(r.task_id), agent: r.agent as string, model: str(r.model), phase: r.phase as RunPhase,
      outcome: r.outcome as string, effective: Number(r.effective), durationMs: Number(r.duration_ms), logFile: str(r.log_file),
      ts: r.ts as string,
      usage: { input: Number(r.input), cacheRead: Number(r.cache_read), cacheWrite: Number(r.cache_write), output: Number(r.output),
        requests: Number(r.requests), contextTokens: Number(r.context_tokens) },
    }));
  }

  /** Median effective tokens of finished runs of one phase/agent: the baseline for runaway detection. */
  medianEffective(agent: string, phase: RunPhase): number | null {
    const values = (this.db.prepare("SELECT effective FROM runs WHERE agent = ? AND phase = ? AND outcome = 'done' ORDER BY effective")
      .all(agent, phase) as Row[]).map((r) => Number(r.effective));
    if (values.length < 3) return null;
    return values[Math.floor(values.length / 2)];
  }

  addReview(r: ReviewRow): void {
    this.db.prepare(`INSERT OR REPLACE INTO reviews (plan_id, agent, round, reviewer, decision, notes) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.planId, r.agent, r.round, r.reviewer, r.decision, r.notes);
  }

  reviews(planId: string, agent?: string): ReviewRow[] {
    const rows = (agent === undefined
      ? this.db.prepare("SELECT * FROM reviews WHERE plan_id = ? ORDER BY agent, round").all(planId)
      : this.db.prepare("SELECT * FROM reviews WHERE plan_id = ? AND agent = ? ORDER BY round").all(planId, agent)) as Row[];
    return rows.map((r) => ({ planId, agent: r.agent as string, round: Number(r.round), reviewer: r.reviewer as string,
      decision: r.decision as ReviewRow["decision"], notes: r.notes as string }));
  }

  addEvent(planId: string, type: string, data: Record<string, unknown> = {}): EventRow {
    const ts = this.now();
    const r = this.db.prepare("INSERT INTO events (plan_id, ts, type, data) VALUES (?, ?, ?, ?)").run(planId, ts, type, JSON.stringify(data));
    return { id: Number(r.lastInsertRowid), planId, ts, type, data };
  }

  events(planId: string, sinceId = 0): EventRow[] {
    return (this.db.prepare("SELECT * FROM events WHERE plan_id = ? AND id > ? ORDER BY id").all(planId, sinceId) as Row[]).map((r) => ({
      id: Number(r.id), planId, ts: r.ts as string, type: r.type as string, data: JSON.parse(r.data as string) as Record<string, unknown>,
    }));
  }
}
