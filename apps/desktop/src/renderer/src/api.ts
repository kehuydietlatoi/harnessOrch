import type { HarnessApi } from "../../preload/index";

declare global {
  interface Window { harness: HarnessApi }
}

export const api = window.harness;

export type Agent = "claude" | "codex" | "opencode";
export const AGENTS: Agent[] = ["codex", "claude", "opencode"];

export interface PlanListItem { file: string; title: string; tasks: number; done: number; errors: number; status: string | null }

/** The engine's task lifecycle states (packages/engine/src/engine/lifecycle.ts). */
export type TaskStatus = "queued" | "working" | "checking" | "merging" | "escalating" | "waiting" | "stopped" | "interrupted" | "done" | "skipped";
export const IN_FLIGHT: TaskStatus[] = ["working", "checking", "merging", "escalating"];
export const NEEDS_YOU: TaskStatus[] = ["waiting", "stopped", "interrupted"];
export const FINAL: TaskStatus[] = ["done", "skipped"];
export const STOPPABLE: TaskStatus[] = ["working", "checking", "merging"];
/** Board group of a state; also its CSS tone. */
export const groupOf = (s: TaskStatus): "queued" | "running" | "needs-you" | "done" =>
  IN_FLIGHT.includes(s) ? "running" : NEEDS_YOU.includes(s) ? "needs-you" : FINAL.includes(s) ? "done" : "queued";

/** The facts the Stop confirm shows (engine StopInfo). */
export interface StopInfo {
  taskId: string;
  state: TaskStatus;
  agent: string | null;
  stoppable: boolean;
  deferred: boolean;
  phaseElapsedMs: number | null;
  turnElapsedMs: number | null;
  tokensSoFar: number | null;
  tokensNote: string | null;
  uncommittedFiles: number;
  dependents: string[];
  ifStopped: string;
  afterwards: string[];
}

export interface TaskView {
  id: string;
  title: string;
  role: "implement" | "small" | "hard";
  agent?: string;
  model?: string;
  dependsOn: string[];
  goal: string;
  doneWhen: string[];
  checks: string[];
  writeScope: string[];
  readFirst: string[];
  skills: string[];
  images: boolean;
  status: TaskStatus;
  /** What happens next in this state. */
  next: string;
  phaseStartedAt: string | null;
  assigned: string | null;
  note: string | null;
  attempts: number;
  summary: string | null;
  decisions: string[];
  commits: string[];
}

export interface AgentMeter {
  agent: Agent;
  runs: number;
  effective: number;
  cacheHit: number | null;
  active: boolean;
  state: "working" | "idle" | "limited" | "held";
  task: string | null;
  until: string | null;
}

export interface RunView {
  taskId: string | null;
  agent: string;
  model: string | null;
  phase: string;
  outcome: string;
  effective: number;
  durationMs: number;
  logFile: string | null;
  ts: string;
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number; requests: number; contextTokens: number };
}

export interface EventView { id: number; ts: string; type: string; data: Record<string, unknown> }

export interface Snapshot {
  id: string;
  title: string;
  status?: string;
  running: boolean;
  baseBranch: string | null;
  checks: string[];
  tasks: TaskView[];
  errors: string[];
  warnings: string[];
  agents: AgentMeter[];
  runs: RunView[];
  startedAt: string | null;
  reviews: Array<{ agent: string; round: number; reviewer: string; decision: "approve" | "request-changes"; notes: string }>;
  events: EventView[];
}

export type RunnerEvent =
  | { type: "line"; agent: string; taskId: string | null; line: string }
  | { type: "task"; taskId: string; status: string; agent?: string; note?: string; details?: string }
  | { type: "plan"; status: string; message?: string }
  | { type: "needs-you"; taskId?: string; message: string }
  | { type: "run"; agent: string; taskId: string | null; phase: string; outcome: string; effective: number }
  | { type: "info"; message: string };

export const fmtTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
export const fmtTime = (iso: string): string => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** localStorage is a per-viewer convenience: it can be missing or throw. */
export const prefs = {
  get<T>(key: string, fallback: T): T {
    try { const v = localStorage.getItem(`harness:${key}`); return v === null ? fallback : JSON.parse(v) as T; } catch { return fallback; }
  },
  set(key: string, value: unknown): void {
    try { localStorage.setItem(`harness:${key}`, JSON.stringify(value)); } catch { /* ignore */ }
  },
};
