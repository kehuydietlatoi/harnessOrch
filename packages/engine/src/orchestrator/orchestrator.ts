import type { PlanTask } from "../plan/plan.js";
import { estimateTokens } from "../brief/brief.js";

/**
 * The orchestrator is never a supervisor: it is asked one question at a
 * decision point, with a compact digest (≤ ~5k tokens), never transcripts.
 */
export const DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["retry", "reassign", "human"] },
    agent: { type: "string", description: "For reassign: claude, codex or opencode." },
    guidance: { type: "string", description: "Concrete instructions for the next attempt, or the question for the human." },
  },
  required: ["action", "agent", "guidance"],
  additionalProperties: false,
} as const;

export interface Decision {
  action: "retry" | "reassign" | "human";
  agent?: string;
  guidance: string;
}

export function parseDecision(value: unknown, agents: readonly string[]): Decision | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const guidance = typeof v.guidance === "string" ? v.guidance.trim() : "";
  if (v.action === "retry" && guidance) return { action: "retry", guidance };
  if (v.action === "reassign" && typeof v.agent === "string" && agents.includes(v.agent)) return { action: "reassign", agent: v.agent, guidance };
  if (v.action === "human") return { action: "human", guidance: guidance || "needs a human decision" };
  return null;
}

export interface Digest {
  planTitle: string;
  task: PlanTask;
  agent: string;
  reason: string;
  /** Filtered check output, worker questions, or scope violations. */
  details: string;
  attempts: number;
  /** Summaries of what the last attempts reported. */
  history: readonly string[];
  availableAgents: readonly string[];
}

function clip(text: string, maxTokens: number): string {
  return estimateTokens(text) <= maxTokens ? text : `${text.slice(0, maxTokens * 4)}\n… (truncated)`;
}

export function renderDecisionPrompt(d: Digest, fencedResult: boolean): string {
  return [
    `You are the orchestrator of an automated plan "${d.planTitle}". One task is stuck; decide what happens next.`,
    `## Task ${d.task.id}: ${d.task.title}\nGoal: ${d.task.goal}\nWrite scope: ${d.task.writeScope.join(", ")}${d.task.doneWhen.length ? `\nDone when: ${d.task.doneWhen.join("; ")}` : ""}`,
    `## Situation\nAgent: ${d.agent}. Attempts: ${d.attempts}. Reason: ${d.reason}.`,
    d.history.length ? `## What the agent reported\n${d.history.map((h) => `- ${h}`).join("\n")}` : "",
    `## Details\n${clip(d.details, 2500)}`,
    "## Options\n- retry: same agent, with your concrete guidance (only if you see a clear fix)\n" +
      `- reassign: another agent (${d.availableAgents.join(", ")}) with guidance (when this agent is the problem)\n` +
      "- human: the task needs a decision only a person can make (requirements, credentials, product choice)",
    "Workers cannot install packages, change the environment or tooling, or edit outside their write scope, and neither can a retry. " +
      "If the blocker is one of those (a missing dependency or tool, network, credentials, or a file outside the scope), choose human.",
    "You may read files in the repository to understand the problem, but do not edit anything.",
    fencedResult ? 'End with one fenced ```json block: {"action": "...", "agent": "", "guidance": "..."}' : "End with the structured decision.",
  ].filter(Boolean).join("\n\n");
}

/** Conflict resolution happens in the plan worktree, by the orchestrator, with both sides' intent. */
export function renderConflictPrompt(files: readonly string[], incoming: PlanTask, alreadyMerged: readonly PlanTask[], checks: readonly string[]): string {
  const merged = alreadyMerged.map((t) => `- ${t.id} ${t.title}: ${t.goal}`).join("\n") || "- (none)";
  return [
    `A merge into the plan branch has conflicts. Resolve them so both sides' intent is kept.`,
    `## Conflicted files\n${files.map((f) => `- ${f}`).join("\n")}`,
    `## Incoming change\n${incoming.id} ${incoming.title}: ${incoming.goal}`,
    `## Already on the plan branch\n${merged}`,
    "Edit only the conflicted files: remove every conflict marker. Do not commit; the engine concludes the merge.",
    checks.length ? `Then make sure these pass: ${checks.join("; ")}` : "",
    'End with a short summary and, if you could not resolve it, say so plainly.',
  ].filter(Boolean).join("\n\n");
}
