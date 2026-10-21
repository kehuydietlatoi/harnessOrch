import type { PlanTask } from "../plan/plan.js";

/** The reviewer's answer. Non-blocking ideas go to followups, never into a rejection. */
export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "request-changes"] },
    notes: { type: "string", description: "For request-changes: each required fix, with file and reason." },
    followups: { type: "array", items: { type: "string" }, description: "Optional improvements that must not block." },
  },
  required: ["decision", "notes", "followups"],
  additionalProperties: false,
} as const;

export interface Verdict {
  decision: "approve" | "request-changes";
  notes: string;
  followups: string[];
}

/** Fail closed: a rejection must say what to fix; anything malformed is no verdict. */
export function parseVerdict(value: unknown): Verdict | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.decision !== "approve" && v.decision !== "request-changes") return null;
  const notes = typeof v.notes === "string" ? v.notes.trim() : "";
  if (v.decision === "request-changes" && !notes) return null;
  const followups = (Array.isArray(v.followups) ? v.followups : [])
    .filter((f): f is string => typeof f === "string")
    .map((f) => f.replace(/\s+/g, " ").trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 10);
  return { decision: v.decision, notes, followups };
}

/** Diff-only review of everything one agent contributed to the plan. */
export function renderReviewPrompt(author: string, tasks: readonly PlanTask[], diff: string, fencedResult: boolean, skills: readonly string[] = []): string {
  const scope = tasks.map((t) => `- ${t.id} ${t.title}: ${t.goal}${t.doneWhen.length ? ` Done when: ${t.doneWhen.join("; ")}` : ""}`).join("\n");
  return [
    `Review the changes ${author} made for these tasks. You see only the diff, on purpose: judge it on its own.`,
    `## Tasks\n${scope}`,
    "## Approve unless\n- a task's goal or done-when is not met\n- there is a bug, data loss, or security problem\n- tests are missing for new logic\n- code changed outside the tasks' purpose",
    "Style preferences and nice-to-haves go in followups and do not block.",
    skills.length ? `## Review guides (read first)\n${skills.map((p) => `- ${p}`).join("\n")}` : "",
    `## Diff\n\`\`\`diff\n${diff}\n\`\`\``,
    fencedResult
      ? 'End with one fenced ```json block: {"decision": "approve|request-changes", "notes": "...", "followups": []}'
      : "End with the structured verdict (decision, notes, followups).",
  ].filter(Boolean).join("\n\n");
}
