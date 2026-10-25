import type { Budget } from "./ledger/budget.js";
import { DEFAULT_PRICING, type ModelPricing } from "./ledger/pricing.js";

/** What an adapter is told to run. Either field may be omitted to defer to the harness default. */
export interface ModelSpec {
  /** Explicit replacement for the harness's default capabilities. */
  capabilities?: string[];
  /** Harness-specific model id or alias (`claude-sonnet-5-5`, a Codex model id, `opencode/<slug>`). */
  model?: string;
  /** Provider identity, overriding the adapter default. Required for OpenCode. */
  family?: string;
  /** Reasoning/thinking effort handed to the harness (`low|medium|high|xhigh|max`). */
  effort?: string;
}

export const EFFORT_TIERS = ["free", "cheap", "standard", "lead"] as const;
export type EffortTier = typeof EFFORT_TIERS[number];
export interface TierMember extends ModelSpec { agent: string }
export interface CascadeRoute extends TierMember { tier: EffortTier }

export interface AdapterConfig {
  cmd: string;
  /** Inherited variable names to restore after credential stripping (GitHub tokens are always denied). */
  env?: string[];
  family?: string;
  pricingMode?: "api" | "subscription" | "quota";
  models?: Record<EffortTier, ModelSpec>;
  leadModel?: ModelSpec;
  /** What a task pinned to this agent runs on when nothing routes it there (OpenCode cannot run without one). */
  defaultModel?: ModelSpec;
}

/** Models offered in pickers besides the configured ones. Any id can still be typed in. */
export const KNOWN_MODELS: Record<string, string[]> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5-20251001", "opus", "sonnet", "haiku"],
  codex: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  opencode: ["opencode/deepseek-v4.1-flash-free", "opencode/glm-5.3-flash-free"],
};

/** One agent+model choice. Routing lists are ordered: the first available entry wins,
 * later entries are the usage-limit fallbacks. */
export interface AgentRef extends ModelSpec { agent: string }

/**
 * What a task (or a run-time decision) needs done. Opus assigns `implement`, `small` or
 * `hard` per task while planning; the others are engine roles.
 */
export const ROLES = ["implement", "small", "hard", "review", "orchestrator"] as const;
export type Role = typeof ROLES[number];

export interface EngineConfig {
  adapters: Record<string, AdapterConfig>;
  /** Interactive planning session, independent of task routing. Supports Claude and Codex. */
  planner: AgentRef;
  /** Role → ordered agent choices (first available wins; the rest are fallbacks). */
  routing: Record<Role, AgentRef[]>;
  /** Author agent → ordered reviewer choices; a reviewer is never the author's own session. */
  reviewers: Record<string, AgentRef[]>;
  /** Agents writing code at the same time. */
  concurrency: number;
  /** Check-failure attempts on one task before it pauses for the orchestrator. */
  maxAttempts: number;
  /** Fix rounds after a rejecting review before the lane pauses. */
  maxReviewRounds: number;
  /** Lane sessions rotate (fresh session + handoff) once a turn's context passes this. */
  sessionCeilingTokens: number;
  /** Effective-token budget for one task run; runs past it are interrupted. */
  taskTokenBudget: number;
  taskTimeoutMs: number;
  reviewTimeoutMs: number;
  /** Trusted check argv, also allowlisted for OpenCode's bash permission. Set per plan. */
  verify?: string[][];
  budgets?: { default?: Budget; byTier?: Partial<Record<EffortTier, Budget>> };
  pricing: Record<string, ModelPricing>;
  /** Regenerable ignored output that never makes a worktree worth preserving. */
  disposableIgnored: string[];
  /** Ignored dependency folders linked from the main checkout into every worktree (agents may not install packages). */
  sharedDirs: string[];
  /** Extra model ids per agent for the pickers (e.g. a new Codex model), beyond KNOWN_MODELS. */
  extraModels?: Record<string, string[]>;
}

/** Regenerable output that never makes a task worktree worth preserving. */
export const DEFAULT_DISPOSABLE_IGNORED: readonly string[] = ["node_modules/", "dist/", "coverage/", "logs/", "*.log"];

const OPUS: AgentRef = { agent: "claude", model: "claude-opus-5-5", effort: "high" };
const SONNET: AgentRef = { agent: "claude", model: "claude-sonnet-5-5", effort: "medium" };
const CODEX: AgentRef = { agent: "codex", model: "gpt-6.1-sol", effort: "medium" };
const FREE_DEEPSEEK: AgentRef = { agent: "opencode", model: "opencode/deepseek-v4.1-flash-free", family: "deepseek" };
const FREE_GLM: AgentRef = { agent: "opencode", model: "opencode/glm-5.3-flash-free", family: "glm" };

/**
 * Defaults for a Claude Pro + ChatGPT Plus + free-model setup: Claude is the scarce
 * resource, so Opus is reserved for hard tasks and escalations, Codex carries most
 * implementation, and free OpenCode models take small well-defined tasks.
 */
export const DEFAULT_CONFIG: EngineConfig = {
  planner: OPUS,
  adapters: {
    claude: { cmd: "claude", family: "anthropic", pricingMode: "subscription", defaultModel: { model: SONNET.model, effort: SONNET.effort } },
    codex: { cmd: "codex", family: "openai", pricingMode: "subscription", defaultModel: { model: CODEX.model, effort: CODEX.effort } },
    opencode: { cmd: "opencode", pricingMode: "quota", defaultModel: { model: FREE_DEEPSEEK.model, family: FREE_DEEPSEEK.family } },
  },
  routing: {
    implement: [CODEX],
    small: [FREE_DEEPSEEK, FREE_GLM, CODEX],
    hard: [OPUS, CODEX],
    review: [SONNET, CODEX],
    orchestrator: [CODEX, OPUS],
  },
  reviewers: {
    codex: [SONNET],
    claude: [CODEX],
    opencode: [CODEX, SONNET],
  },
  concurrency: 3,
  maxAttempts: 3,
  maxReviewRounds: 2,
  sessionCeilingTokens: 150_000,
  taskTokenBudget: 400_000,
  taskTimeoutMs: 1_800_000,
  reviewTimeoutMs: 900_000,
  pricing: DEFAULT_PRICING,
  disposableIgnored: [...DEFAULT_DISPOSABLE_IGNORED],
  sharedDirs: ["node_modules"],
};

/** Render a spec for telemetry/logs as `model@effort` (either half may be absent). */
export function formatModelSpec(spec: ModelSpec | undefined): string | undefined {
  if (!spec || (!spec.model && !spec.effort)) return undefined;
  return [spec.model ?? "default", spec.effort].filter(Boolean).join("@");
}
