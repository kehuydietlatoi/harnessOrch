import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_IDS } from "./agents/turn.js";
import { DEFAULT_CONFIG, ROLES, type AdapterConfig, type AgentRef, type EngineConfig } from "./config.js";
import { orchHome } from "./ledger/telemetry.js";

/** The slice of the config a person edits; everything else keeps the built-in value. */
export interface UserConfig {
  /** Interactive planner; omitted keeps the built-in Opus session. */
  planner?: AgentRef;
  routing?: Partial<Record<string, AgentRef[]>>;
  reviewers?: Record<string, AgentRef[]>;
  /** Per agent: the default model a task pinned to that agent runs on. */
  defaults?: Record<string, { model?: string; effort?: string; family?: string }>;
  extraModels?: Record<string, string[]>;
}

export const userConfigPath = (): string => join(orchHome(), "config.json");

export function readUserConfig(path = userConfigPath()): UserConfig {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as UserConfig;
}

/** Problems that would make a run fail later; empty when the config is usable. */
export function validateUserConfig(user: UserConfig): string[] {
  const errors: string[] = [];
  if (user.planner !== undefined) {
    const planner = user.planner;
    if (!planner || typeof planner !== "object" || Array.isArray(planner) || !["claude", "codex"].includes(planner.agent)) {
      errors.push("planner: choose claude or codex");
    } else {
      for (const field of ["model", "effort"] as const) {
        if (planner[field] !== undefined && (typeof planner[field] !== "string" || !planner[field]!.trim())) {
          errors.push(`planner: ${field} must be a non-empty string`);
        }
      }
    }
  }
  const check = (where: string, refs: AgentRef[] | undefined): void => {
    if (!Array.isArray(refs) || !refs.length) { errors.push(`${where}: needs at least one agent`); return; }
    refs.forEach((r, i) => {
      if (!AGENT_IDS.includes(r.agent as never)) errors.push(`${where} #${i + 1}: unknown agent ${String(r.agent)}`);
      else if (r.agent === "opencode" && !r.model) errors.push(`${where} #${i + 1}: OpenCode needs a provider/model`);
    });
  };
  for (const [role, refs] of Object.entries(user.routing ?? {})) {
    if (!(ROLES as readonly string[]).includes(role)) errors.push(`unknown role ${role}`);
    else check(`routing ${role}`, refs);
  }
  for (const [agent, refs] of Object.entries(user.reviewers ?? {})) check(`reviewers ${agent}`, refs);
  for (const [agent, d] of Object.entries(user.defaults ?? {})) {
    if (!AGENT_IDS.includes(agent as never)) errors.push(`defaults: unknown agent ${agent}`);
    else if (agent === "opencode" && !d.model) errors.push("defaults opencode: needs a provider/model");
  }
  return errors;
}

/** Built-in config with the user's edits laid over it, key by key. */
export function mergeUserConfig(base: EngineConfig, user: UserConfig): EngineConfig {
  const adapters: Record<string, AdapterConfig> = { ...base.adapters };
  for (const [agent, d] of Object.entries(user.defaults ?? {})) {
    if (adapters[agent]) adapters[agent] = { ...adapters[agent], defaultModel: { ...d } };
  }
  return {
    ...base,
    ...(user.planner !== undefined ? { planner: { ...user.planner } } : {}),
    adapters,
    routing: { ...base.routing, ...(user.routing as EngineConfig["routing"] | undefined) },
    reviewers: { ...base.reviewers, ...user.reviewers },
    ...(user.extraModels ? { extraModels: user.extraModels } : {}),
  };
}

/** The config the app and `ho` run with: built-ins plus ~/.harnessorch/config.json. */
export function loadConfig(path?: string): EngineConfig {
  const file = path ?? userConfigPath();
  if (path && !existsSync(path)) throw new Error(`config file not found: ${path}`);
  const raw = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as UserConfig & Partial<EngineConfig>) : {};
  // A --config file may also carry full engine keys (concurrency, budgets...): those replace the built-ins.
  const { planner, routing, reviewers, defaults, extraModels, ...engine } = raw as UserConfig & Record<string, unknown>;
  if (planner !== undefined) {
    const errors = validateUserConfig({ planner });
    if (errors.length) throw new Error(errors.join("; "));
  }
  return mergeUserConfig({ ...DEFAULT_CONFIG, ...(engine as Partial<EngineConfig>) }, { planner, routing, reviewers, defaults, extraModels });
}

export function saveUserConfig(user: UserConfig, path = userConfigPath()): void {
  const errors = validateUserConfig(user);
  if (errors.length) throw new Error(errors.join("; "));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(user, null, 2));
}
