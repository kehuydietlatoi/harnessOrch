import type { PlanTask } from "../plan/plan.js";
import { hverifyCommand } from "../checks/checks.js";

/** The structured answer every worker turn must end with. */
export const RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "blocked", "failed"] },
    summary: { type: "string", description: "What you did, at most 150 words." },
    files_changed: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" }, description: "Facts later tasks should know (one line each)." },
    questions: { type: "array", items: { type: "string" }, description: "Only when status is blocked: what you need from a human." },
  },
  required: ["status", "summary", "files_changed", "decisions", "questions"],
  additionalProperties: false,
} as const;

export interface WorkerResult {
  status: "done" | "blocked" | "failed";
  summary: string;
  files_changed: string[];
  decisions: string[];
  questions: string[];
}

/** Accept a structured answer only when it matches the contract; anything else is a failed turn. */
export function parseWorkerResult(value: unknown): WorkerResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (!["done", "blocked", "failed"].includes(v.status as string) || typeof v.summary !== "string") return null;
  const list = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
  return { status: v.status as WorkerResult["status"], summary: v.summary, files_changed: list(v.files_changed), decisions: list(v.decisions), questions: list(v.questions) };
}

/** ~4 characters per token: close enough to keep briefs inside their budget. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export interface BriefContext {
  planTitle: string;
  projectType?: string;
  /** Plan-level checks, run by the engine after merge. */
  planChecks: readonly string[];
  /** Path-filtered facts from earlier tasks. */
  facts: readonly string[];
  /** Absolute SKILL.md paths to read before working (0-2). */
  skills: readonly string[];
  /** Agents without native schema output must end with a fenced JSON block. */
  fencedResult: boolean;
  /** Present when this session was rotated: what the previous session finished. */
  handoff?: string;
}

const RULES = [
  "Work only inside the write scope. Do not edit the plan file, AGENTS.md or CLAUDE.md.",
  "If the goal truly cannot be met without changing a file outside the write scope, change it and list it in files_changed: the engine asks the human to allow it. Unlisted edits outside the scope are reverted.",
  "Read the listed files (and line ranges) first; search with grep/glob instead of reading whole directories.",
  "Run checks only through the hverify command below; it prints just the failures.",
  "Do not commit or push; the engine commits and merges your work.",
  "Dependencies are already installed. If the task needs a new library or tool for development or tests, add it yourself as a dev dependency (e.g. `npm install -D <pkg>`). Never add production dependencies or upgrade, remove or reinstall existing packages: the engine reverts that.",
  "Stay inside your working directory. Never change other folders, other worktrees or node_modules.",
  "If a decision you cannot make blocks you (unclear requirements, conflicting instructions), stop and report status \"blocked\" with your questions.",
  "If a check cannot run at all for a reason you cannot fix inside your write scope (shell syntax for another platform, a missing script or tool, a wrong path), do not work around it with new packages or scripts: report status \"blocked\" with the command and why it cannot run. The engine fixes the check.",
];

const bullets = (items: readonly string[]): string => items.map((i) => `- ${i}`).join("\n");

/** Render the task brief: pointers, not pasted files. Target ≤ 2k tokens. */
export function renderBrief(task: PlanTask, ctx: BriefContext): string {
  const checks = task.checks.length ? task.checks : ctx.planChecks;
  const parts = [
    `# Task ${task.id}: ${task.title}`,
    `Plan: ${ctx.planTitle}${ctx.projectType ? ` (${ctx.projectType})` : ""}`,
    ctx.handoff ? `## Where the previous session left off\n${ctx.handoff}` : "",
    `## Goal\n${task.goal}`,
    task.doneWhen.length ? `## Done when\n${bullets(task.doneWhen)}` : "",
    `## Write scope\n${bullets(task.writeScope)}`,
    task.readFirst.length ? `## Read first\n${bullets(task.readFirst)}` : "",
    ctx.facts.length ? `## Known facts\n${bullets(ctx.facts)}` : "",
    ctx.skills.length ? `## Skills (read before working)\n${bullets(ctx.skills)}` : "",
    checks.length ? `## Checks\n${bullets(checks.map((c) => `\`${hverifyCommand(c)}\``))}` : "",
    `## Rules\n${bullets(RULES)}`,
    ctx.fencedResult
      ? "## Report\nEnd with one fenced ```json block: {\"status\": \"done|blocked|failed\", \"summary\": \"...\", \"files_changed\": [], \"decisions\": [], \"questions\": []}"
      : "## Report\nEnd with the structured result (status, summary, files_changed, decisions, questions).",
  ];
  return parts.filter(Boolean).join("\n\n");
}

/** A retry inside the same session: only the new information. */
export function renderFixPrompt(task: PlanTask, reason: string, details: string, fencedResult: boolean): string {
  return [
    `Task ${task.id} is not done yet: ${reason}.`,
    details,
    "Fix it, re-run the checks with hverify, and report again" + (fencedResult ? " (fenced ```json block)." : "."),
  ].filter(Boolean).join("\n\n");
}

export interface HandoffEntry {
  id: string;
  title: string;
  summary: string;
  decisions: readonly string[];
}

/** What a rotated session inherits: summaries, never transcripts. */
export function renderHandoff(entries: readonly HandoffEntry[], maxTokens = 600): string {
  const lines: string[] = [];
  for (const e of [...entries].reverse()) {
    const line = `- ${e.id} ${e.title}: ${e.summary}${e.decisions.length ? ` Decisions: ${e.decisions.join("; ")}` : ""}`;
    if (estimateTokens([...lines, line].join("\n")) > maxTokens) break;
    lines.unshift(line);
  }
  return lines.join("\n");
}
