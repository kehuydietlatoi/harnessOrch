import type { PlanTask } from "../plan/plan.js";

/**
 * Capabilities the engine may switch on for a task without asking you: each is
 * safe (no new code runs outside the task's sandbox, nothing leaves the machine)
 * and only costs tokens the task already needed. Riskier ones, like production
 * dependencies or files outside the write scope, still come to you.
 */
export const SAFE_GRANTS = {
  images: { agent: "codex", describe: "Codex image generation (image_gen)" },
} as const;

export type Grant = keyof typeof SAFE_GRANTS;

export const GRANTS = Object.keys(SAFE_GRANTS) as Grant[];

export function isGrant(value: unknown): value is Grant {
  return typeof value === "string" && (GRANTS as string[]).includes(value);
}

/** Does the task already hold this grant? */
export function hasGrant(task: Pick<PlanTask, "images">, grant: Grant): boolean {
  return grant === "images" ? task.images : false;
}

/** Switch the grant on in memory. Persisting it to the plan file is the runner's job. */
export function applyGrant(task: PlanTask, grant: Grant): void {
  if (grant === "images") task.images = true;
}
