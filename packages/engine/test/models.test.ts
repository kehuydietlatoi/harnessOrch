import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseOpencodeModels } from "../src/agents/models.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { PlanRunner } from "../src/engine/runner.js";
import { parsePlan } from "../src/plan/plan.js";
import { Store } from "../src/store/store.js";
import { loadConfig, mergeUserConfig, saveUserConfig, validateUserConfig } from "../src/user-config.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "harness-models-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const plan = (yaml: string) => parsePlan(`---\ntitle: T\nchecks: ['node -e "0"']\n---\n\n- [ ] **T1 — One**\n\`\`\`yaml\n${yaml}\n\`\`\`\n`).plan.tasks[0];
const runnerWith = (config = DEFAULT_CONFIG) => {
  const planFile = join(dir, "demo.md");
  writeFileSync(planFile, "x");
  return new PlanRunner({ repo: dir, planFile, store: new Store(":memory:"), config });
};

describe("pinned agents", () => {
  it("gives an implement task pinned to OpenCode the OpenCode default model", () => {
    const [c] = runnerWith().candidates(plan("agent: opencode\ngoal: g\nwrite_scope: [src/a.txt]"));
    expect(c).toMatchObject({ agent: "opencode", model: "opencode/deepseek-v4.1-flash-free" });
  });

  it("keeps an explicit task model over the routed one", () => {
    const [c] = runnerWith().candidates(plan("agent: claude\nmodel: claude-haiku-4-5-20251001\ngoal: g\nwrite_scope: [src/a.txt]"));
    expect(c).toMatchObject({ agent: "claude", model: "claude-haiku-4-5-20251001" });
  });

  it("lists Sonnet, Haiku and the CLI's OpenCode models as choices", () => {
    const choices = runnerWith().modelChoices();
    expect(choices.claude).toEqual(expect.arrayContaining(["claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-opus-5-5"]));
    expect(choices.opencode).toContain("opencode/glm-5.3-flash-free");
  });

  it("offers every current Codex model while preserving the default", () => {
    expect(runnerWith().modelChoices().codex).toEqual(expect.arrayContaining([
      "gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna",
      "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    ]));
    expect(DEFAULT_CONFIG.adapters.codex.defaultModel?.model).toBe("gpt-6.1-sol");
  });

  it("keeps custom Codex ids from defaults, routes and extras in the choices", () => {
    const cfg = mergeUserConfig(DEFAULT_CONFIG, {
      defaults: { codex: { model: "custom-codex-default" } },
      routing: { implement: [{ agent: "codex", model: "custom-codex-route" }] },
      extraModels: { codex: ["custom-codex-extra", "gpt-6-astra"] },
    });
    const choices = runnerWith(cfg).modelChoices().codex;
    expect(choices).toEqual(expect.arrayContaining([
      "gpt-6-astra", "custom-codex-default", "custom-codex-route", "custom-codex-extra",
    ]));
    expect(choices.filter((m) => m === "gpt-6-astra")).toHaveLength(1);
  });

  it("keeps the configured planner's custom model in the choices", () => {
    const cfg = { ...DEFAULT_CONFIG, planner: { agent: "codex", model: "custom-codex-planner" } };
    expect(runnerWith(cfg).modelChoices().codex).toContain("custom-codex-planner");
  });
});

describe("opencode model list", () => {
  it("keeps provider/model lines and drops noise", () => {
    expect(parseOpencodeModels("opencode/big-pickle\r\nwarning: update available\n\nopencode/big-pickle\nanthropic/claude-x\n"))
      .toEqual(["opencode/big-pickle", "anthropic/claude-x"]);
  });
});

describe("user config", () => {
  it("overlays routing and defaults on the built-ins", () => {
    const cfg = mergeUserConfig(DEFAULT_CONFIG, {
      routing: { implement: [{ agent: "claude", model: "claude-sonnet-5-5" }] },
      defaults: { opencode: { model: "opencode/big-pickle" } },
    });
    expect(cfg.routing.implement[0].agent).toBe("claude");
    expect(cfg.routing.hard).toEqual(DEFAULT_CONFIG.routing.hard);
    expect(cfg.adapters.opencode.defaultModel?.model).toBe("opencode/big-pickle");
  });

  it("rejects an OpenCode route without a model and an unknown agent", () => {
    expect(validateUserConfig({ routing: { small: [{ agent: "opencode" }] } })).toHaveLength(1);
    expect(validateUserConfig({ reviewers: { codex: [{ agent: "gemini" }] } })[0]).toContain("unknown agent");
    expect(validateUserConfig({ routing: { small: [{ agent: "codex" }] } })).toEqual([]);
  });

  it("saves and loads through the file", () => {
    const file = join(dir, "config.json");
    saveUserConfig({ routing: { review: [{ agent: "codex", model: "gpt-6.1-sol" }] } }, file);
    expect(loadConfig(file).routing.review).toEqual([{ agent: "codex", model: "gpt-6.1-sol" }]);
    expect(() => saveUserConfig({ routing: { small: [] } }, file)).toThrow(/at least one agent/);
  });
});
