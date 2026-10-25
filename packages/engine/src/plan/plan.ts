import { parse as parseYaml } from "yaml";
import { lockPathsOverlap } from "../git/path-locks.js";

/** How hard a task is, which picks its default agent through `routing`. */
export const TASK_ROLES = ["implement", "small", "hard"] as const;
export type TaskRole = typeof TASK_ROLES[number];

/** Thinking levels a task may ask for; each CLI receives it as its own effort flag. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface PlanTask {
  id: string;
  title: string;
  role: TaskRole;
  /** Explicit agent override (`codex`, `claude`, `opencode`). */
  agent?: string;
  /** Explicit model override for that agent. */
  model?: string;
  /** Thinking level override (`low` … `max`). */
  effort?: string;
  dependsOn: string[];
  goal: string;
  /** Plain-language acceptance criteria, for the worker and the reviewer. */
  doneWhen: string[];
  /** Shell commands the engine runs itself; all must exit 0 for the task to be done. */
  checks: string[];
  /** Globs the task may change. Anything else is a scope violation. */
  writeScope: string[];
  /** Files (optionally `path:from-to`) the worker should read first, instead of exploring. */
  readFirst: string[];
  /** Extra skills from the library (0-2). */
  skills: string[];
  /** Codex asset tasks keep image generation enabled. */
  images: boolean;
  /** Production dependencies this task may add (dev dependencies need no listing). */
  deps: string[];
  done: boolean;
  /** 0-based line of the task's checkbox heading. */
  line: number;
}

export interface PlanHeader {
  title: string;
  projectType?: string;
  baseBranch?: string;
  skills: string[];
  /** Plan-level checks, run after every merge into the plan branch. */
  checks: string[];
  concurrency?: number;
}

export interface Plan {
  header: PlanHeader;
  tasks: PlanTask[];
}

export interface ParseResult {
  plan: Plan;
  errors: string[];
}

const HEADING = /^(\s*)- \[( |x|X)\] \*\*([A-Za-z0-9_.-]+)\s*[—–:-]\s*(.+?)\*\*(.*)$/;
const FENCE = /^(\s*)(```+)\s*(yaml|yml)?\s*$/;

type Json = Record<string, unknown>;
const asObject = (v: unknown): Json => (v !== null && typeof v === "object" && !Array.isArray(v) ? v as Json : {});

function strings(value: unknown, field: string, errors: string[], where: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value as string[];
  errors.push(`${where}: ${field} must be a string or a list of strings`);
  return [];
}

function text(value: unknown, field: string, errors: string[], where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  errors.push(`${where}: ${field} must be a string`);
  return undefined;
}

function splitFrontMatter(lines: string[]): { header: Json; body: number; errors: string[] } {
  if (lines[0]?.trim() !== "---") return { header: {}, body: 0, errors: ["plan must start with a --- YAML header"] };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { header: {}, body: 0, errors: ["plan header is not closed with ---"] };
  try {
    return { header: asObject(parseYaml(lines.slice(1, end).join("\n"))), body: end + 1, errors: [] };
  } catch (error) {
    return { header: {}, body: end + 1, errors: [`plan header is not valid YAML: ${(error as Error).message}`] };
  }
}

/** Read the first fenced block between `from` and `to`, dedented by its fence's indentation. */
function taskBlock(lines: string[], from: number, to: number): { yaml?: string; error?: string } {
  for (let i = from; i < to; i++) {
    const open = FENCE.exec(lines[i]);
    if (!open) continue;
    const indent = open[1].length;
    const body: string[] = [];
    for (let j = i + 1; j < to; j++) {
      const close = FENCE.exec(lines[j]);
      if (close && close[2].length >= open[2].length && close[3] === undefined) return { yaml: body.join("\n") };
      body.push(lines[j].slice(Math.min(indent, lines[j].length - lines[j].trimStart().length)));
    }
    return { error: "task block is not closed" };
  }
  return {};
}

/** Parse a plan file. Never throws; problems come back in `errors`. */
export function parsePlan(markdown: string): ParseResult {
  const lines = markdown.split(/\r?\n/);
  const front = splitFrontMatter(lines);
  const errors = [...front.errors];
  const h = front.header;
  const concurrency = h.concurrency === undefined ? undefined : Number(h.concurrency);
  if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) errors.push("header: concurrency must be a positive integer");
  const header: PlanHeader = {
    title: text(h.title, "title", errors, "header") ?? "Untitled plan",
    projectType: text(h.project_type, "project_type", errors, "header"),
    baseBranch: text(h.base_branch, "base_branch", errors, "header"),
    skills: strings(h.skills, "skills", errors, "header"),
    checks: strings(h.checks, "checks", errors, "header"),
    ...(concurrency !== undefined && Number.isInteger(concurrency) && concurrency >= 1 ? { concurrency } : {}),
  };

  const headings: number[] = [];
  for (let i = front.body; i < lines.length; i++) if (HEADING.test(lines[i])) headings.push(i);
  const tasks: PlanTask[] = [];
  headings.forEach((line, n) => {
    const m = HEADING.exec(lines[line])!;
    const id = m[3];
    const where = `task ${id}`;
    const block = taskBlock(lines, line + 1, headings[n + 1] ?? lines.length);
    if (block.error) errors.push(`${where}: ${block.error}`);
    let fields: Json = {};
    if (block.yaml !== undefined) {
      try { fields = asObject(parseYaml(block.yaml)); } catch (error) { errors.push(`${where}: invalid YAML: ${(error as Error).message}`); }
    } else if (!block.error) errors.push(`${where}: missing fenced yaml block`);
    const role = (text(fields.role, "role", errors, where) ?? "implement") as TaskRole;
    if (!TASK_ROLES.includes(role)) errors.push(`${where}: role must be one of ${TASK_ROLES.join(", ")}`);
    const goal = text(fields.goal, "goal", errors, where);
    if (!goal) errors.push(`${where}: goal is required`);
    tasks.push({
      id, title: m[4].trim(), role,
      agent: text(fields.agent, "agent", errors, where),
      model: text(fields.model, "model", errors, where),
      effort: text(fields.effort, "effort", errors, where),
      dependsOn: strings(fields.depends_on, "depends_on", errors, where),
      goal: goal ?? "",
      doneWhen: strings(fields.done_when, "done_when", errors, where),
      checks: strings(fields.checks, "checks", errors, where),
      writeScope: strings(fields.write_scope, "write_scope", errors, where),
      readFirst: strings(fields.read_first, "read_first", errors, where),
      skills: strings(fields.skills, "skills", errors, where),
      images: fields.images === true,
      deps: strings(fields.deps, "deps", errors, where),
      done: m[2].toLowerCase() === "x",
      line,
    });
  });
  if (tasks.length === 0) errors.push("plan has no tasks (expected `- [ ] **T1 — Title**` lines)");
  return { plan: { header, tasks }, errors };
}

/** Does `a` (transitively) depend on `b`? */
function dependsOn(tasks: Map<string, PlanTask>, a: string, b: string, seen = new Set<string>()): boolean {
  if (seen.has(a)) return false;
  seen.add(a);
  return (tasks.get(a)?.dependsOn ?? []).some((d) => d === b || dependsOn(tasks, d, b, seen));
}

export interface ValidationOptions {
  agents: readonly string[];
  skills?: readonly string[];
  /** Repo-relative paths workers must never touch (the plan file itself, instruction files). */
  protectedPaths?: readonly string[];
}

/**
 * Structural checks the engine needs before a run: errors block the start,
 * warnings are shown on the board.
 */
export function validatePlan(plan: Plan, opts: ValidationOptions): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const byId = new Map<string, PlanTask>();
  for (const t of plan.tasks) {
    if (byId.has(t.id)) errors.push(`duplicate task id ${t.id}`);
    byId.set(t.id, t);
  }
  for (const t of plan.tasks) {
    const where = `task ${t.id}`;
    for (const d of t.dependsOn) if (!byId.has(d)) errors.push(`${where}: depends on unknown task ${d}`);
    if (dependsOn(byId, t.id, t.id)) errors.push(`${where}: dependency cycle`);
    if (t.agent !== undefined && !opts.agents.includes(t.agent)) errors.push(`${where}: unknown agent ${t.agent} (known: ${opts.agents.join(", ")})`);
    if (t.effort !== undefined && !(EFFORTS as readonly string[]).includes(t.effort)) errors.push(`${where}: effort must be one of ${EFFORTS.join(", ")}`);
    if (t.model !== undefined && t.agent === undefined) warnings.push(`${where}: model ${t.model} is ignored without an agent`);
    if (t.writeScope.length === 0) errors.push(`${where}: write_scope is required so parallel agents never collide`);
    if (t.checks.length === 0 && plan.header.checks.length === 0) warnings.push(`${where}: no checks; only the review will verify it`);
    if (t.skills.length > 2) warnings.push(`${where}: more than 2 skills; only the first 2 are injected`);
    for (const s of [...t.skills, ...plan.header.skills]) {
      if (opts.skills && !opts.skills.includes(s)) warnings.push(`${where}: skill ${s} is not in the library`);
    }
    for (const p of opts.protectedPaths ?? []) {
      if (t.writeScope.some((g) => lockPathsOverlap(g, p))) errors.push(`${where}: write_scope covers protected path ${p}`);
    }
  }
  const tasks = plan.tasks;
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const [a, b] = [tasks[i], tasks[j]];
      if (dependsOn(byId, a.id, b.id) || dependsOn(byId, b.id, a.id)) continue;
      if (a.writeScope.some((x) => b.writeScope.some((y) => lockPathsOverlap(x, y)))) {
        warnings.push(`tasks ${a.id} and ${b.id} share write scope; they will not run at the same time`);
      }
    }
  }
  return { errors, warnings: [...new Set(warnings)] };
}

/** Set (or clear) a task's `agent:` line. Used by the board's assignment dropdown. */
export function setTaskAgent(markdown: string, id: string, agent: string | undefined): string {
  return setTaskField(markdown, id, "agent", agent);
}

/** The task fields the board may edit. */
export type EditableField = "agent" | "model" | "effort" | "images";
const FIELD_ORDER: readonly EditableField[] = ["agent", "model", "effort", "images"];

/**
 * Set (or clear, with `undefined`) one `key:` line inside a task's YAML block,
 * leaving every other byte alone. A new line goes after `role:` and the routing fields before it.
 */
export function setTaskField(markdown: string, id: string, key: EditableField, value: string | undefined): string {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => HEADING.exec(l)?.[3] === id);
  if (start < 0) throw new Error(`task ${id} not found in plan`);
  let next = lines.findIndex((l, i) => i > start && HEADING.test(l));
  if (next < 0) next = lines.length;
  const open = lines.findIndex((l, i) => i > start && i < next && FENCE.test(l));
  if (open < 0) throw new Error(`task ${id} has no yaml block`);
  const close = lines.findIndex((l, i) => i > open && i < next && FENCE.test(l));
  if (close < 0) throw new Error(`task ${id} yaml block is not closed`);
  const indent = FENCE.exec(lines[open])![1];
  const lineOf = (k: string): number => lines.findIndex((l, i) => i > open && i < close && new RegExp(`^\\s*${k}\\s*:`).test(l));
  const existing = lineOf(key);
  if (value === undefined) {
    if (existing >= 0) lines.splice(existing, 1);
  } else if (existing >= 0) {
    lines[existing] = lines[existing].replace(new RegExp(`^(\\s*${key}\\s*:\\s*)[^#]*?(\\s*(#.*)?)$`), `$1${value}$2`);
  } else {
    const after = [...FIELD_ORDER.slice(0, FIELD_ORDER.indexOf(key)).reverse(), "role"].map(lineOf).find((i) => i >= 0);
    lines.splice(after !== undefined ? after + 1 : open + 1, 0, `${indent}${key}: ${value}`);
  }
  return lines.join(eol);
}

/**
 * Replace a task's `checks:` with a flow list (JSON is valid YAML), including a
 * block-style list's item lines. Used when the orchestrator amends a check that
 * cannot run. A task without `checks:` gets the line at the end of its block.
 */
export function setTaskChecks(markdown: string, id: string, checks: readonly string[]): string {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => HEADING.exec(l)?.[3] === id);
  if (start < 0) throw new Error(`task ${id} not found in plan`);
  let next = lines.findIndex((l, i) => i > start && HEADING.test(l));
  if (next < 0) next = lines.length;
  const open = lines.findIndex((l, i) => i > start && i < next && FENCE.test(l));
  if (open < 0) throw new Error(`task ${id} has no yaml block`);
  const close = lines.findIndex((l, i) => i > open && i < next && FENCE.test(l));
  if (close < 0) throw new Error(`task ${id} yaml block is not closed`);
  const indent = FENCE.exec(lines[open])![1];
  const line = `${indent}checks: ${JSON.stringify(checks)}`;
  const existing = lines.findIndex((l, i) => i > open && i < close && /^\s*checks\s*:/.test(l));
  if (existing < 0) {
    lines.splice(close, 0, line);
    return lines.join(eol);
  }
  const depth = /^\s*/.exec(lines[existing])![0].length;
  let end = existing + 1;
  while (end < close && (/^\s*/.exec(lines[end])![0].length > depth || /^\s*- /.test(lines[end]))) end++;
  lines.splice(existing, end - existing, line);
  return lines.join(eol);
}

export type TaskMark = { done: true } | { done: false; note?: string };

/**
 * Rewrite one task's checkbox (and trailing status note) in place. The engine is
 * the only writer, so the plan file never becomes a merge conflict.
 */
export function markTask(markdown: string, id: string, mark: TaskMark): string {
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const i = lines.findIndex((l) => HEADING.exec(l)?.[3] === id);
  if (i < 0) throw new Error(`task ${id} not found in plan`);
  const m = HEADING.exec(lines[i])!;
  const head = lines[i].slice(0, lines[i].length - m[5].length).replace(/- \[( |x|X)\]/, mark.done ? "- [x]" : "- [ ]");
  const note = !mark.done && mark.note ? ` ${mark.note}` : "";
  lines[i] = head + note;
  return lines.join(eol);
}
