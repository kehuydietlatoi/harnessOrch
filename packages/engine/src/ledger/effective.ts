import type { TurnUsage } from "../agents/turn.js";

export interface CacheWeights {
  /** Cache reads relative to uncached input (≈0.1 for Claude and OpenAI caches). */
  read: number;
  /** Cache writes relative to uncached input (1.25 for a 5-minute TTL, 2 for 1 hour). */
  write: number;
}

export const DEFAULT_WEIGHTS: CacheWeights = { read: 0.1, write: 1.25 };

/**
 * One number for "how much of my allowance did this cost": uncached input,
 * cache writes and reads at their relative price, plus output. Raw sums
 * overstate cache-heavy sessions roughly 8x.
 */
export function effectiveTokens(u: Pick<TurnUsage, "input" | "cacheRead" | "cacheWrite" | "output">, w: CacheWeights = DEFAULT_WEIGHTS): number {
  return Math.round(u.input + u.cacheWrite * w.write + u.cacheRead * w.read + u.output);
}

/** Share of input served from cache; a falling rate means unstable prefixes or idle gaps past the TTL. */
export function cacheHitRate(u: Pick<TurnUsage, "input" | "cacheRead" | "cacheWrite">): number | null {
  const total = u.input + u.cacheRead + u.cacheWrite;
  return total === 0 ? null : u.cacheRead / total;
}

export function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage {
  return {
    input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output, requests: a.requests + b.requests, contextTokens: b.contextTokens,
  };
}

/**
 * Live budget guard for a running turn: feeds on the agent's own JSONL and
 * returns a kill reason once effective tokens pass `limit`. Claude reports
 * usage per request; OpenCode per step; Codex only at turn end (so a Codex
 * turn can only be stopped by its timeout).
 */
export function budgetWatcher(agent: string, limit: number, w: CacheWeights = DEFAULT_WEIGHTS): (line: string) => string | undefined {
  // Claude streams one "assistant" event per content block (thinking, text, each tool call),
  // all repeating the same request's usage: count each request once, by message id.
  const perRequest = new Map<string, number>();
  let steps = 0;
  return (line) => {
    if (!line.startsWith("{")) return undefined;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
    let u: Record<string, unknown> | undefined;
    let id: string | undefined;
    if (agent === "claude" && e.type === "assistant") {
      const message = e.message as Record<string, unknown> | undefined;
      u = message?.usage as Record<string, unknown> | undefined;
      id = typeof message?.id === "string" ? message.id : undefined;
    }
    if (agent === "opencode" && e.type === "step_finish") {
      const t = ((e.part as Record<string, unknown> | undefined)?.tokens ?? {}) as Record<string, unknown>;
      const cache = (t.cache ?? {}) as Record<string, unknown>;
      u = { input_tokens: t.input, output_tokens: t.output, cache_read_input_tokens: cache.read, cache_creation_input_tokens: cache.write };
    }
    if (!u) return undefined;
    perRequest.set(id ?? `step-${steps++}`, effectiveTokens(usageFrom(u), w));
    const spent = [...perRequest.values()].reduce((a, b) => a + b, 0);
    return spent > limit ? `token budget exceeded (${spent} > ${limit} effective tokens)` : undefined;
  };
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
function usageFrom(u: Record<string, unknown>): { input: number; cacheRead: number; cacheWrite: number; output: number } {
  return { input: num(u.input_tokens), cacheRead: num(u.cache_read_input_tokens), cacheWrite: num(u.cache_creation_input_tokens), output: num(u.output_tokens) };
}
