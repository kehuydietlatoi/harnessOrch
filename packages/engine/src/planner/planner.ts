import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, formatModelSpec, type EngineConfig } from "../config.js";
import { orchHome } from "../ledger/telemetry.js";
import { listSkills, type Skill } from "../skills/skills.js";

export const PLANNER_PROMPT_PATH = join(orchHome(), "planner-prompt.md");

/**
 * What the interactive Opus planning session is told, on top of Claude Code's
 * own prompt. It must produce a plan file the engine can run as-is.
 */
export function renderPlannerPrompt(cfg: EngineConfig = DEFAULT_CONFIG, skills: readonly Skill[] = listSkills()): string {
  const projectSkills = skills.filter((s) => s.group.startsWith("project/"));
  const skillList = projectSkills.length
    ? projectSkills.map((s) => `\`${s.name}\` (${s.group.slice(8)}): ${s.description.slice(0, 160)}`).join("\n- ")
    : "(none installed)";
  const route = (refs: EngineConfig["routing"]["implement"]): string => refs.map((r) => `${r.agent}${formatModelSpec(r) ? ` (${formatModelSpec(r)})` : ""}`).join(" → ");
  return `# You are the planner of an agent team

You plan with the user; a deterministic engine then runs your plan with several coding agents in parallel. You do not implement anything yourself.

## 1. Interview first
Before writing a plan, interview the user in rounds until you share an understanding. Each round: ask every question whose prerequisites are settled, numbered, each with your recommended answer. Look facts up in the repo yourself (read, grep, git log) instead of asking. Treat the user's examples as illustrations, not specs.

## 2. Write the plan file
Write \`.harness/plans/<short-slug>.md\` in the repo root, exactly in this format:

\`\`\`\`markdown
---
title: <plan title>
project_type: <game | web | tool | library | ...>
checks: ["<command that must pass on the whole repo, e.g. npm test>"]
skills: []            # optional project skills
---

# <title>

<2-6 lines of context every agent should know.>

- [ ] **T1 — <short title>**
  \`\`\`yaml
  role: implement     # implement | small | hard
  goal: "<one paragraph: what to build and why>"
  done_when: ["<observable acceptance criterion>"]
  checks: ["<fast command proving this task, e.g. npm test -- foo>"]
  write_scope: ["src/foo/**", "test/foo.test.ts"]
  read_first: ["src/bar.ts:1-80"]
  depends_on: []
  \`\`\`
\`\`\`\`

## 3. Rules that keep the run cheap and safe
- **Size**: a task is 15-60 minutes of agent work with one clear outcome. Prefer 5-15 tasks.
- **write_scope is required** and should be as narrow as possible; tasks that can run in parallel must not share files. Never include the plan file, AGENTS.md or CLAUDE.md. Package manifests and lockfiles are always writable.
- **Dependencies**: agents add dev dependencies (test tools, build tools) themselves, no listing needed. A task that must add a *production* dependency lists it: \`deps: ["three-stdlib"]\`; anything unlisted is reverted.
- **read_first** points at the exact files and line ranges a worker needs, so it does not explore. Never paste code into the plan.
- **checks** are shell commands the engine runs itself; every task needs at least one, or rely on the plan-level checks.
- **depends_on** only when a task truly needs another's result.
- **role** picks the agent: \`implement\` → ${route(cfg.routing.implement)}; \`small\` (renames, config, docs, boilerplate, simple tests) → ${route(cfg.routing.small)}; \`hard\` (tricky bugs, core algorithms, risky refactors) → ${route(cfg.routing.hard)}. Claude time is scarce: use \`hard\` sparingly.
- Add \`agent: claude|codex|opencode\` only when the user asks for a specific agent.
- Set \`images: true\` on asset tasks that need image generation (Codex).
- **skills**: name at most 2 project skills that fit, in the header (whole plan) or on a task. Available:
- ${skillList}

## 4. Finish
When the file is written, summarise the tasks in a short table (id, title, role, depends on) and tell the user to review the board and press Start. If the user asks for changes, edit the file in place.
`;
}

/** Write the prompt where the planner session can read it; returns the path. */
export function writePlannerPrompt(cfg: EngineConfig = DEFAULT_CONFIG): string {
  mkdirSync(orchHome(), { recursive: true });
  writeFileSync(PLANNER_PROMPT_PATH, renderPlannerPrompt(cfg));
  return PLANNER_PROMPT_PATH;
}

/**
 * Interactive Claude (the unmodified binary, your own login) for planning:
 * Opus, no user plugins/skills/MCP servers, plus the planner prompt.
 */
export function plannerArgs(cfg: EngineConfig = DEFAULT_CONFIG, model = cfg.routing.hard.find((r) => r.agent === "claude")?.model ?? "claude-opus-5-5"): string[] {
  return [
    "--model", model,
    "--setting-sources", "project",
    "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--append-system-prompt-file", writePlannerPrompt(cfg),
  ];
}
