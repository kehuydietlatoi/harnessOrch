import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The vendored library: skills/core/<role>/<name>/SKILL.md and skills/project/<type>/<name>/SKILL.md. */
export const DEFAULT_SKILLS_ROOT = fileURLToPath(new URL("../../../../skills", import.meta.url));

export type SkillRole = "planner" | "implementer" | "reviewer" | "fixer";

export interface Skill {
  name: string;
  /** core/<role> or project/<type> */
  group: string;
  path: string;
  description: string;
}

function frontMatterField(text: string, field: string): string {
  const m = new RegExp(`^${field}:\\s*(.+)$`, "m").exec(text.split(/^---\s*$/m)[1] ?? "");
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
}

const dirs = (p: string): string[] => {
  try { return readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory()); } catch { return []; }
};

/** Every SKILL.md in the library. Missing library → empty (skills are optional).
 * HARNESS_SKILLS_ROOT moves the library: a packaged app keeps it outside the engine package. */
export function listSkills(root = process.env.HARNESS_SKILLS_ROOT || DEFAULT_SKILLS_ROOT): Skill[] {
  const out: Skill[] = [];
  for (const kind of ["core", "project"]) {
    for (const group of dirs(join(root, kind))) {
      for (const name of dirs(join(root, kind, group))) {
        const path = join(root, kind, group, name, "SKILL.md");
        if (!existsSync(path)) continue;
        out.push({ name, group: `${kind}/${group}`, path: path.replaceAll("\\", "/"), description: frontMatterField(readFileSync(path, "utf8"), "description") });
      }
    }
  }
  return out;
}

/**
 * Skills injected into one brief, as paths: the role's core skills plus at most
 * two named ones (task first, then the plan's project skills). Workers never
 * discover skills on their own.
 */
export function selectSkills(library: readonly Skill[], role: SkillRole, named: readonly string[], max = 2): string[] {
  const core = library.filter((s) => s.group === `core/${role}`).map((s) => s.path);
  const extra: string[] = [];
  for (const n of named) {
    const s = library.find((x) => x.name === n && x.group.startsWith("project/")) ?? library.find((x) => x.name === n);
    if (s && !core.includes(s.path) && !extra.includes(s.path)) extra.push(s.path);
    if (extra.length >= max) break;
  }
  return [...core, ...extra];
}
