import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, formatModelSpec, type AgentRef, type EngineConfig } from "../config.js";
import { CODEX_DISABLED_FEATURES } from "../agents/turn.js";
import { orchHome } from "../ledger/telemetry.js";
import { listSkills, type Skill } from "../skills/skills.js";
import { exec } from "../util/exec.js";
import { validateUserConfig } from "../user-config.js";

export const PLANNER_PROMPT_PATH = join(orchHome(), "planner-prompt.md");

/**
 * Shared contract for an interactive planning session. It must produce a plan
 * file the engine can run as-is.
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
- Add \`agent: claude|codex|opencode\` (and optionally \`model:\`) only when the user asks for a specific agent or model. \`effort: low|medium|high|xhigh|max\` sets the thinking level; leave it out unless the user asks.
- Set \`images: true\` on every task that creates or redraws image files (icons, sprites, textures, effect sheets), including tasks that follow a repo art doc or the generate2dsprite / sprite-assets skill. Without it Codex's image tool is off and the task blocks. Such tasks run on Codex.
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

/** The planner has its own model choice; changing a task route never changes it. */
export function resolvePlanner(cfg: EngineConfig = DEFAULT_CONFIG): AgentRef {
  const selected = cfg.planner ?? DEFAULT_CONFIG.planner;
  const errors = validateUserConfig({ planner: selected });
  if (errors.length) throw new Error(errors.join("; "));
  const adapter = cfg.adapters[selected.agent];
  if (!adapter) throw new Error(`planner: no adapter configured for ${selected.agent}`);
  const planner = { ...adapter.defaultModel, ...selected };
  if (!planner.model?.trim()) throw new Error("planner: choose a model or configure the agent's default model");
  return planner;
}

/** Interactive argv only. A string preserves the legacy Claude model override. */
export function plannerArgs(cfg: EngineConfig = DEFAULT_CONFIG, selection?: AgentRef | string): string[] {
  const planner = resolvePlanner(selection === undefined ? cfg : {
    ...cfg, planner: typeof selection === "string" ? { agent: "claude", model: selection } : selection,
  });
  const prompt = writePlannerPrompt(cfg);
  if (planner.agent === "claude") {
    return [
      "--model", planner.model!,
      ...(planner.effort ? ["--effort", planner.effort] : []),
      "--setting-sources", "project",
      "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      "--append-system-prompt-file", prompt,
    ];
  }
  // The TUI has no --ignore-user-config flag. Disable unused features and the
  // automatic skills catalog while preserving the user's own login and base prompt.
  const args = ["--no-daemon", "-m", planner.model!];
  if (planner.effort) args.push("-c", `model_reasoning_effort=${planner.effort}`);
  for (const feature of [...CODEX_DISABLED_FEATURES, "hooks", "memories"]) args.push("--disable", feature);
  args.push("-c", "skills.include_instructions=false", "-c", "skills.bundled.enabled=false");
  args.push(`Read and follow the planning contract in ${prompt.replace(/\\/g, "/")} before planning. Then ask the user what they want to plan.`);
  return args;
}

/** Prepare an interactive launch without starting a model or any MCP server. */
export async function plannerLaunch(cfg: EngineConfig = DEFAULT_CONFIG, cwd = process.cwd()): Promise<{
  cmd: string; args: string[]; planner: AgentRef;
}> {
  const planner = resolvePlanner(cfg);
  const cmd = cfg.adapters[planner.agent].cmd;
  const args = plannerArgs(cfg, planner);
  if (planner.agent === "codex") {
    // Config tables merge, so `-c mcp_servers={}` leaves user servers enabled.
    // Enumerate names locally and explicitly disable each one for this session.
    // Apply the same feature settings to discovery: disabled plugins may remove
    // their servers, and overriding a removed server would create an invalid stub.
    const result = await exec(cmd, [...args.slice(0, -1), "mcp", "list", "--json"], { cwd, timeoutMs: 10_000, maxBuffer: 1_048_576 });
    if (result.code !== 0) throw new Error("Could not inspect Codex MCP settings; planning session was not started");
    let servers: unknown;
    try { servers = JSON.parse(result.stdout); } catch { /* report only the contract failure, never server credentials */ }
    if (!Array.isArray(servers) || servers.some((s: unknown) => !s || typeof s !== "object" ||
      typeof (s as { name?: unknown }).name !== "string" || !/^[a-zA-Z0-9_-]+$/.test((s as { name: string }).name))) {
      throw new Error("Could not read Codex MCP server names; planning session was not started");
    }
    const overrides = [...new Set(servers.map((s: { name: string }) => s.name))]
      .flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`]);
    args.unshift(...overrides);
  }
  return { cmd, args, planner };
}
