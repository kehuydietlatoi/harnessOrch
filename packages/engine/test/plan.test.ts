import { describe, expect, it } from "vitest";
import { markTask, parsePlan, setTaskAgent, validatePlan } from "../src/plan/plan.js";

const PLAN = `---
title: Enemy AI
project_type: game
skills: [game-dev-loop]
checks: ["npm test"]
---

# Enemy AI

Some context for humans.

- [ ] **T1 — Grid model**
  \`\`\`yaml
  role: implement
  goal: "Walkable grid"
  write_scope: ["src/world/**"]
  checks: ["npm test -- grid"]
  \`\`\`
- [x] **T2 — Pathfinding** ⏸ needs you
  \`\`\`yaml
  role: hard
  agent: claude
  depends_on: [T1]
  goal: "A* over the grid"
  done_when: ["enemies avoid walls"]
  write_scope: ["src/ai/**"]
  read_first: ["src/world/grid.ts:1-80"]
  \`\`\`
`;

describe("plan file", () => {
  it("parses header and tasks", () => {
    const { plan, errors } = parsePlan(PLAN);
    expect(errors).toEqual([]);
    expect(plan.header).toMatchObject({ title: "Enemy AI", projectType: "game", skills: ["game-dev-loop"], checks: ["npm test"] });
    expect(plan.tasks.map((t) => [t.id, t.title, t.role, t.done])).toEqual([["T1", "Grid model", "implement", false], ["T2", "Pathfinding", "hard", true]]);
    expect(plan.tasks[1]).toMatchObject({ agent: "claude", dependsOn: ["T1"], readFirst: ["src/world/grid.ts:1-80"], doneWhen: ["enemies avoid walls"] });
  });

  it("reports missing header, blocks and bad roles without throwing", () => {
    expect(parsePlan("- [ ] **T1 — x**\n").errors).toEqual(expect.arrayContaining([expect.stringMatching(/--- YAML header/), expect.stringMatching(/missing fenced yaml/)]));
    const bad = parsePlan("---\ntitle: x\n---\n- [ ] **T1 — x**\n```yaml\nrole: huge\n```\n");
    expect(bad.errors).toEqual(expect.arrayContaining([expect.stringMatching(/role must be one of/), expect.stringMatching(/goal is required/)]));
  });

  it("validates deps, cycles, agents, scopes and protected paths", () => {
    const { plan } = parsePlan(PLAN.replace("depends_on: [T1]", "depends_on: [T9]").replace("agent: claude", "agent: gemini"));
    const { errors } = validatePlan(plan, { agents: ["claude", "codex", "opencode"] });
    expect(errors).toEqual(expect.arrayContaining(["task T2: depends on unknown task T9", expect.stringMatching(/unknown agent gemini/)]));

    const cyc = parsePlan(PLAN.replace("role: implement", "role: implement\n  depends_on: [T2]")).plan;
    expect(validatePlan(cyc, { agents: ["claude"] }).errors).toEqual(expect.arrayContaining(["task T1: dependency cycle"]));

    const prot = validatePlan(parsePlan(PLAN.replace('["src/ai/**"]', '["**"]')).plan, { agents: ["claude"], protectedPaths: [".harness/plans/x.md"] });
    expect(prot.errors).toEqual(["task T2: write_scope covers protected path .harness/plans/x.md"]);
  });

  it("warns when independent tasks share a write scope", () => {
    const shared = parsePlan(PLAN.replace("depends_on: [T1]", "depends_on: []").replace('["src/ai/**"]', '["src/**"]')).plan;
    expect(validatePlan(shared, { agents: ["claude"] }).warnings).toContain("tasks T1 and T2 share write scope; they will not run at the same time");
  });

  it("marks a task in place, keeping everything else byte-identical", () => {
    const done = markTask(PLAN, "T1", { done: true });
    expect(done).toContain("- [x] **T1 — Grid model**");
    expect(done.replace("- [x] **T1", "- [ ] **T1")).toBe(PLAN);
    const paused = markTask(PLAN, "T2", { done: false, note: "⏸ needs you: checks failed" });
    expect(paused).toContain("- [ ] **T2 — Pathfinding** ⏸ needs you: checks failed\n");
    expect(markTask(paused, "T2", { done: true })).toContain("- [x] **T2 — Pathfinding**\n");
    expect(() => markTask(PLAN, "T7", { done: true })).toThrow(/T7 not found/);
  });

  it("sets, replaces and clears a task's agent without touching anything else", () => {
    const set = setTaskAgent(PLAN, "T1", "opencode");
    expect(set).toContain("  role: implement\n  agent: opencode\n  goal:");
    expect(parsePlan(set).plan.tasks[0].agent).toBe("opencode");
    const replaced = setTaskAgent(PLAN, "T2", "codex");
    expect(replaced).toBe(PLAN.replace("agent: claude", "agent: codex"));
    expect(setTaskAgent(replaced, "T2", undefined)).toBe(PLAN.replace("  agent: claude\n", ""));
    expect(() => setTaskAgent(PLAN, "T9", "codex")).toThrow(/T9 not found/);
  });

  it("keeps CRLF line endings", () => {
    const crlf = PLAN.replace(/\n/g, "\r\n");
    expect(parsePlan(crlf).errors).toEqual([]);
    expect(markTask(crlf, "T1", { done: true })).toBe(crlf.replace("- [ ] **T1", "- [x] **T1"));
  });
});
