import { lockPathsOverlap } from "../git/path-locks.js";
import type { AgentRef } from "../config.js";

export type TaskStatus = "pending" | "running" | "done" | "paused";

export interface SchedTask {
  id: string;
  dependsOn: readonly string[];
  status: TaskStatus;
  writeScope: readonly string[];
  /** Ordered choices: the task's override, else its role's routing list. */
  candidates: readonly AgentRef[];
}

export interface SchedState {
  tasks: readonly SchedTask[];
  concurrency: number;
  /** Agents with a turn in flight (one session per agent, so one task at a time). */
  busyAgents: ReadonlySet<string>;
  /** Agents at their usage limit right now. */
  unavailable: ReadonlySet<string>;
}

export interface Dispatch {
  taskId: string;
  ref: AgentRef;
}

/**
 * Pure: which tasks may start now, in plan order.
 *
 * - every dependency is done (a paused task holds back its dependents only);
 * - one task per agent at a time, at most `concurrency` in flight;
 * - never two in-flight tasks with overlapping write scopes;
 * - the first candidate agent wins; a later one is used only while every
 *   earlier one is at its usage limit (busy is not a reason to switch).
 */
export function nextDispatches(state: SchedState): Dispatch[] {
  const status = new Map(state.tasks.map((t) => [t.id, t.status]));
  const running = state.tasks.filter((t) => t.status === "running");
  const busy = new Set(state.busyAgents);
  const scopes: (readonly string[])[] = running.map((t) => t.writeScope);
  let slots = state.concurrency - running.length;
  const out: Dispatch[] = [];
  for (const t of state.tasks) {
    if (slots <= 0) break;
    if (t.status !== "pending") continue;
    if (!t.dependsOn.every((d) => status.get(d) === "done")) continue;
    const ref = t.candidates.find((c) => !state.unavailable.has(c.agent));
    if (!ref || busy.has(ref.agent)) continue;
    if (scopes.some((s) => s.some((a) => t.writeScope.some((b) => lockPathsOverlap(a, b))))) continue;
    out.push({ taskId: t.id, ref });
    busy.add(ref.agent);
    scopes.push(t.writeScope);
    slots--;
  }
  return out;
}

/** Tasks that can never start because something they depend on is paused. */
export function blockedBy(tasks: readonly SchedTask[]): Map<string, string> {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const out = new Map<string, string>();
  const root = (id: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(id)) return undefined;
    seen.add(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      const dep = byId.get(d);
      if (dep?.status === "paused") return d;
      const r = root(d, seen);
      if (r) return r;
    }
    return undefined;
  };
  for (const t of tasks) {
    if (t.status !== "pending") continue;
    const r = root(t.id);
    if (r) out.set(t.id, r);
  }
  return out;
}

export function planFinished(tasks: readonly SchedTask[]): boolean {
  return tasks.every((t) => t.status === "done");
}
