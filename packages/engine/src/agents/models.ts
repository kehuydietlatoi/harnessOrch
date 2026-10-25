import { exec } from "node:child_process";
import { KNOWN_MODELS, type EngineConfig } from "../config.js";

/** `opencode models` prints one `provider/model` id per line. */
export function parseOpencodeModels(out: string): string[] {
  return [...new Set(out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)))];
}

let cached: Promise<string[]> | undefined;
let listed: string[] = [];

/** The models OpenCode can run, listed once per process. Empty when the CLI is missing or slow. */
export function listOpencodeModels(cmd = "opencode"): Promise<string[]> {
  cached ??= new Promise<string[]>((resolve) => {
    // Through a shell: npm installs OpenCode as a .cmd shim on Windows.
    exec(`${cmd} models`, { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      listed = error ? [] : parseOpencodeModels(stdout);
      resolve(listed);
    });
  });
  return cached;
}

/** Models offered per agent: the known ones, the configured ones, your extras and (for OpenCode) what the CLI lists. */
export function modelChoices(cfg: EngineConfig): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (agent: string, model: string | undefined): void => {
    if (model && !(out[agent] ??= []).includes(model)) out[agent].push(model);
  };
  for (const [agent, models] of Object.entries(KNOWN_MODELS)) for (const m of models) add(agent, m);
  for (const [agent, a] of Object.entries(cfg.adapters)) add(agent, a.defaultModel?.model);
  if (cfg.planner) add(cfg.planner.agent, cfg.planner.model);
  for (const r of [...Object.values(cfg.routing).flat(), ...Object.values(cfg.reviewers).flat()]) add(r.agent, r.model);
  for (const [agent, models] of Object.entries(cfg.extraModels ?? {})) for (const m of models) add(agent, m);
  for (const m of opencodeModelsSoFar(cfg.adapters.opencode?.cmd)) add("opencode", m);
  return out;
}

/** What `listOpencodeModels` found so far (empty until its first call finishes); starts the listing if needed. */
export function opencodeModelsSoFar(cmd?: string): string[] {
  void listOpencodeModels(cmd);
  return listed;
}
