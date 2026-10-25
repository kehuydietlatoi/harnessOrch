import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { PLANNER_PROMPT_PATH, plannerArgs, plannerLaunch, resolvePlanner } from "../src/planner/planner.js";
import { loadConfig, mergeUserConfig, saveUserConfig, validateUserConfig } from "../src/user-config.js";
import { exec } from "../src/util/exec.js";

vi.mock("../src/util/exec.js", async (original) => ({
  ...await original<typeof import("../src/util/exec.js")>(),
  exec: vi.fn(),
}));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "harness-planner-"));
  vi.mocked(exec).mockReset();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("planner selection", () => {
  it("keeps Opus separate from task routing and existing user config", () => {
    const file = join(dir, "config.json");
    writeFileSync(file, JSON.stringify({ routing: { hard: [{ agent: "codex", model: "gpt-6-astra" }] } }));
    expect(resolvePlanner(loadConfig(file))).toMatchObject({ agent: "claude", model: "claude-opus-5-5", effort: "high" });
    expect(loadConfig(file).routing.hard[0].model).toBe("gpt-6-astra");
  });

  it("saves and reloads a Codex planner without changing task defaults", () => {
    const file = join(dir, "config.json");
    const planner = { agent: "codex", model: "gpt-6-astra", effort: "high" };
    saveUserConfig({ planner }, file);
    const cfg = loadConfig(file);
    expect(resolvePlanner(cfg)).toMatchObject(planner);
    expect(cfg.routing).toEqual(DEFAULT_CONFIG.routing);
    expect(cfg.adapters.codex.defaultModel).toEqual(DEFAULT_CONFIG.adapters.codex.defaultModel);
  });

  it("uses the selected agent's defaults when planner fields are omitted", () => {
    expect(resolvePlanner(mergeUserConfig(DEFAULT_CONFIG, { planner: { agent: "codex" } })))
      .toMatchObject({ agent: "codex", model: "gpt-6.1-sol", effort: "medium" });
  });

  it("rejects unsupported planners and malformed model choices before saving or launching", async () => {
    for (const planner of [{ agent: "opencode", model: "opencode/x" }, { agent: "codex", model: " " },
      { agent: "codex", model: 3 }, { agent: "claude", effort: "" }, null]) {
      expect(validateUserConfig({ planner: planner as never }).length).toBeGreaterThan(0);
      expect(() => saveUserConfig({ planner: planner as never }, join(dir, "bad.json"))).toThrow(/planner/);
    }
    const file = join(dir, "bad.json");
    writeFileSync(file, '{"planner":{"agent":"opencode","model":"opencode/x"}}');
    expect(() => loadConfig(file)).toThrow(/planner/);
    await expect(plannerLaunch({ ...DEFAULT_CONFIG, planner: { agent: "other" } }, dir)).rejects.toThrow(/planner/);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("interactive planner launch", () => {
  const codex = { ...DEFAULT_CONFIG, planner: { agent: "codex", model: "gpt-6-astra", effort: "high" } };

  it("keeps Claude's append prompt contract and legacy model override", async () => {
    const launch = await plannerLaunch(DEFAULT_CONFIG, dir);
    expect(launch.cmd).toBe(DEFAULT_CONFIG.adapters.claude.cmd);
    expect(launch.args).toEqual(expect.arrayContaining(["--model", "claude-opus-5-5", "--effort", "high", "--strict-mcp-config"]));
    expect(launch.args[launch.args.indexOf("--append-system-prompt-file") + 1]).toBe(PLANNER_PROMPT_PATH);
    expect(plannerArgs(DEFAULT_CONFIG, "claude-sonnet-5-5").slice(0, 2)).toEqual(["--model", "claude-sonnet-5-5"]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("launches Codex interactively with the same file contract and no user MCP servers", async () => {
    vi.mocked(exec).mockResolvedValue({ code: 0, stdout: '[{"name":"tools","enabled":true},{"name":"old-tools","enabled":false}]', stderr: "" });
    const cfg = { ...codex, adapters: { ...codex.adapters, codex: { ...codex.adapters.codex, cmd: "custom-codex" } } };
    const launch = await plannerLaunch(cfg, dir);
    expect(launch.cmd).toBe("custom-codex");
    expect(launch.planner).toMatchObject(codex.planner);
    expect(exec).toHaveBeenCalledWith("custom-codex", [...plannerArgs(cfg).slice(0, -1), "mcp", "list", "--json"],
      expect.objectContaining({ cwd: dir, timeoutMs: 10_000 }));
    expect(launch.args).toEqual(expect.arrayContaining(["-m", "gpt-6-astra", "model_reasoning_effort=high",
      "mcp_servers.tools.enabled=false", "mcp_servers.old-tools.enabled=false", "multi_agent", "plugins", "hooks", "skills.include_instructions=false"]));
    expect(launch.args).not.toContain("exec");
    expect(launch.args).not.toContain("--ignore-user-config");
    expect(launch.args.join(" ")).not.toContain("model_instructions_file");
    expect(launch.args.at(-1)).toContain(PLANNER_PROMPT_PATH.replace(/\\/g, "/"));
    expect(launch.args.every((arg) => !/[\r\n]/.test(arg))).toBe(true);
    expect(readFileSync(PLANNER_PROMPT_PATH, "utf8")).toContain(".harness/plans/<short-slug>.md");
  });

  it("accepts no configured MCP servers", async () => {
    vi.mocked(exec).mockResolvedValue({ code: 0, stdout: "[]", stderr: "" });
    expect((await plannerLaunch(codex, dir)).args).toContain("gpt-6-astra");
  });

  it("fails closed without disclosing raw MCP configuration", async () => {
    const secret = "private-provider-token";
    for (const result of [{ code: 1, stdout: "", stderr: secret }, { code: 0, stdout: secret, stderr: "" },
      { code: 0, stdout: JSON.stringify([{ name: "bad.name", token: secret }]), stderr: "" }]) {
      vi.mocked(exec).mockResolvedValue(result);
      await expect(plannerLaunch(codex, dir)).rejects.toThrow(/planning session was not started/);
      await expect(plannerLaunch(codex, dir)).rejects.not.toThrow(secret);
    }
  });
});
