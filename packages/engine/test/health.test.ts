import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { endpointHealthy, healthPath, HEALTH_TTL_MS } from "../src/ledger/health.js";
import { unavailableUntil } from "../src/ledger/availability.js";

const mocks = vi.hoisted(() => ({ ping: vi.fn(), claim: vi.fn(), next: vi.fn(), edit: vi.fn(), list: vi.fn() }));
vi.mock("../src/adapters/opencode.js", () => ({ OpencodeAdapter: class { pingEndpoint = mocks.ping; } }));

describe("pre-claim endpoint health", () => {
  let cwd: string;
  let time: number;
  const now = () => new Date(time);
  beforeEach(() => {
    vi.clearAllMocks();
    cwd = mkdtempSync(join(tmpdir(), "orch-health-"));
    time = Date.parse("2026-10-18T12:00:00Z");
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("persists a result across dispatches until exactly ten minutes", async () => {
    const ping = vi.fn(async () => true);
    const check = () => endpointHealthy("opencode", "zen/free", cwd, undefined, { now, ping });
    expect(await check()).toBe(true);
    time += HEALTH_TTL_MS - 1;
    expect(await check()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(1);
    time++;
    expect(await check()).toBe(true);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(healthPath(cwd), "utf8"))["zen/free"]).toEqual({ ts: time, ok: true });
  });

  it("coalesces concurrent pings and isolates slugs", async () => {
    const ping = vi.fn(async () => true);
    await Promise.all([1, 2].map(() => endpointHealthy("opencode", "zen/free", cwd, undefined, { now, ping })));
    expect(ping).toHaveBeenCalledTimes(1);
    await endpointHealthy("opencode", "zen/cheap", cwd, undefined, { now, ping });
    expect(ping).toHaveBeenCalledTimes(2);
  });

  it.each(["claude", "codex"])("never pings %s", async agent => {
    const ping = vi.fn();
    expect(await endpointHealthy(agent, "some/model", cwd, undefined, { now, ping })).toBe(true);
    expect(ping).not.toHaveBeenCalled();
  });

  it("treats corrupt cache as a miss and a thrown ping as a cooldown", async () => {
    await endpointHealthy("opencode", "zen/other", cwd, undefined, { now, ping: async () => true });
    writeFileSync(healthPath(cwd), "broken");
    const ping = vi.fn(async () => { throw new Error("spawn failed"); });
    expect(await endpointHealthy("opencode", "zen/free", cwd, undefined, { now, ping })).toBe(false);
    expect(await endpointHealthy("opencode", "zen/free", cwd, undefined, { now, ping })).toBe(false);
    expect(ping).toHaveBeenCalledTimes(1);
    expect(unavailableUntil("opencode:zen/free", cwd, now())).not.toBeNull();
    expect(unavailableUntil("opencode:zen/free", cwd, now())?.getTime()).toBe(time + 10 * 60_000);
    expect(unavailableUntil("opencode:zen/other", cwd, now())).toBeNull();
    time += 10 * 60_000;
    expect(unavailableUntil("opencode:zen/free", cwd, now())).toBeNull();
    expect(await endpointHealthy("opencode", "zen/free", cwd, undefined, { now, ping: async () => true })).toBe(true);
  });

});
