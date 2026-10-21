import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/brief/brief.js";
import { renderPlannerPrompt } from "../src/planner/planner.js";
import { listSkills, selectSkills } from "../src/skills/skills.js";

const library = listSkills();

describe("skills library", () => {
  it("ships the curated role and project skills", () => {
    expect(library.map((s) => `${s.group}/${s.name}`).sort()).toEqual([
      "core/fixer/diagnosing-bugs", "core/fixer/fix-root-causes", "core/implementer/tdd",
      "core/reviewer/blast-radius", "core/reviewer/test-behavior-not-implementation",
      "project/game/game-dev-loop", "project/typescript/typescript-best-practices",
    ]);
  });

  // The budget from the plan: skills are read into worker context, so size is cost.
  it.each(library.map((s) => [s.name, s.path]))("keeps %s under 5k tokens and adapted for unattended runs", (_name, path) => {
    const text = readFileSync(path, "utf8");
    expect(estimateTokens(text)).toBeLessThanOrEqual(5000);
    expect(text).toContain("harnessOrch note:");
  });

  it("keeps each role's descriptions short", () => {
    const groups = new Map<string, number>();
    for (const s of library) groups.set(s.group, (groups.get(s.group) ?? 0) + s.description.length);
    for (const [group, chars] of groups) expect(chars, group).toBeLessThanOrEqual(1500);
  });

  it("selects core skills plus at most two named project skills, as paths", () => {
    const picked = selectSkills(library, "implementer", ["game-dev-loop", "typescript-best-practices", "tdd", "unknown"]);
    expect(picked.map((p) => p.split("/").slice(-2, -1)[0])).toEqual(["tdd", "game-dev-loop", "typescript-best-practices"]);
    expect(selectSkills(library, "reviewer", []).map((p) => p.split("/").slice(-2, -1)[0])).toEqual(["blast-radius", "test-behavior-not-implementation"]);
    expect(selectSkills([], "implementer", ["game-dev-loop"])).toEqual([]);
  });

  it("tells the planner which project skills exist", () => {
    const prompt = renderPlannerPrompt();
    expect(prompt).toContain("`game-dev-loop` (game)");
    expect(prompt).not.toContain("`tdd`");
    expect(estimateTokens(prompt)).toBeLessThan(1500);
  });
});
