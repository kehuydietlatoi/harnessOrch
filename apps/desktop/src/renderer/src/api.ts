import type { HarnessApi } from "../../preload/index";

declare global {
  interface Window { harness: HarnessApi }
}

export const api = window.harness;

export type Agent = "claude" | "codex" | "opencode";
export const AGENTS: Agent[] = ["codex", "claude", "opencode"];

export interface PlanListItem { file: string; title: string; tasks: number; done: number; errors: number; status: string | null }

export interface TaskView {
  id: string;
  title: string;
  role: "implement" | "small" | "hard";
  agent?: string;
  dependsOn: string[];
  goal: string;
  writeScope: string[];
  status: "pending" | "running" | "done" | "paused";
  assigned: string | null;
  note: string | null;
  attempts: number;
}

export interface AgentMeter { agent: Agent; runs: number; effective: number; cacheHit: number | null; active: boolean }

export interface Snapshot {
  id: string;
  title: string;
  status?: string;
  running: boolean;
  tasks: TaskView[];
  errors: string[];
  warnings: string[];
  agents: AgentMeter[];
  reviews: Array<{ agent: string; round: number; reviewer: string; decision: "approve" | "request-changes"; notes: string }>;
  events: Array<{ id: number; ts: string; type: string; data: Record<string, unknown> }>;
}

export type RunnerEvent =
  | { type: "line"; agent: string; taskId: string | null; line: string }
  | { type: "task"; taskId: string; status: string; agent?: string; note?: string }
  | { type: "plan"; status: string; message?: string }
  | { type: "needs-you"; taskId?: string; message: string }
  | { type: "run"; agent: string; taskId: string | null; phase: string; outcome: string; effective: number }
  | { type: "info"; message: string };
