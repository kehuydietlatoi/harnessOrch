#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { DEFAULT_CONFIG, type EngineConfig } from "./config.js";
import { AGENT_IDS, type AgentId } from "./agents/turn.js";
import { IN_FLIGHT, NEEDS_YOU } from "./engine/lifecycle.js";
import { PlanRunner, type RunnerEvent } from "./engine/runner.js";
import { cacheHitRate } from "./ledger/effective.js";
import { orchHome } from "./ledger/telemetry.js";
import { Store } from "./store/store.js";
import { exec } from "./util/exec.js";

const USAGE = `ho — harnessOrch engine

  ho validate <plan.md>                      check a plan file
  ho run <plan.md>                           run the plan until ready, paused or stopped
  ho status <plan.md>                        task board and token spend
  ho resume <plan.md> <task> [--guidance "..."] [--agent codex]
                                             retry a paused task, then run
  ho review <plan.md> <agent> approve|retry  settle a review that needs you
  ho merge <plan.md>                         merge the finished plan into its base branch
  ho doctor                                  check the agent CLIs

Options: --repo <dir> (default: current directory), --config <file.json>`;

function loadConfig(path?: string): EngineConfig {
  if (!path) return DEFAULT_CONFIG;
  const user = JSON.parse(readFileSync(path, "utf8")) as Partial<EngineConfig>;
  return { ...DEFAULT_CONFIG, ...user, routing: { ...DEFAULT_CONFIG.routing, ...user.routing }, reviewers: { ...DEFAULT_CONFIG.reviewers, ...user.reviewers } };
}

function printEvent(e: RunnerEvent): void {
  const time = pc.dim(new Date().toLocaleTimeString());
  switch (e.type) {
    case "task": console.log(`${time} ${pc.bold(e.taskId)} ${e.status}${e.agent ? ` [${e.agent}]` : ""}${e.note ? pc.dim(` — ${e.note}`) : ""}`); break;
    case "run": console.log(`${time} ${pc.dim(`${e.agent} ${e.phase}${e.taskId ? ` ${e.taskId}` : ""}: ${e.outcome}, ${e.effective.toLocaleString()} effective tokens`)}`); break;
    case "needs-you": console.log(`${time} ${pc.yellow(`⏸ needs you: ${e.message}`)}`); break;
    case "plan": console.log(`${time} ${pc.cyan(`plan ${e.status}${e.message ? `: ${e.message}` : ""}`)}`); break;
    case "info": console.log(`${time} ${pc.dim(e.message)}`); break;
    case "line": break;
  }
}

function printStatus(runner: PlanRunner): void {
  const snap = runner.snapshot();
  console.log(pc.bold(`${snap.title} — ${snap.status ?? "not started"}`));
  for (const t of snap.tasks) {
    const icon = t.status === "done" || t.status === "skipped" ? pc.green("✓") : NEEDS_YOU.includes(t.status) ? pc.yellow("⏸")
      : IN_FLIGHT.includes(t.status) ? pc.cyan("▶") : "·";
    console.log(`  ${icon} ${t.id.padEnd(6)} ${t.title.padEnd(40)} ${pc.dim(`${t.status}, ${t.assigned ?? "?"}${t.attempts ? `, attempt ${t.attempts}` : ""}`)}${t.note ? pc.yellow(`  ${t.note}`) : ""}`);
  }
  const runs = runner.store.runs(runner.key);
  if (!runs.length) return;
  console.log(pc.bold("\nTokens (effective = uncached + cache writes×1.25 + cache reads×0.1 + output)"));
  const byAgent = new Map<string, typeof runs>();
  for (const r of runs) byAgent.set(r.agent, [...(byAgent.get(r.agent) ?? []), r]);
  let total = 0;
  for (const [agent, rs] of byAgent) {
    const eff = rs.reduce((n, r) => n + r.effective, 0);
    total += eff;
    const sum = rs.reduce((u, r) => ({ input: u.input + r.usage.input, cacheRead: u.cacheRead + r.usage.cacheRead, cacheWrite: u.cacheWrite + r.usage.cacheWrite }), { input: 0, cacheRead: 0, cacheWrite: 0 });
    const hit = cacheHitRate(sum);
    console.log(`  ${agent.padEnd(9)} ${String(rs.length).padStart(3)} runs  ${eff.toLocaleString().padStart(10)} effective  cache hit ${hit === null ? "—" : `${Math.round(hit * 100)}%`}`);
  }
  const tasks = snap.tasks.filter((t) => t.status === "done").length;
  console.log(`  ${"total".padEnd(9)} ${String(runs.length).padStart(3)} runs  ${total.toLocaleString().padStart(10)} effective${tasks ? `  (${Math.round(total / tasks).toLocaleString()} per done task)` : ""}`);
}

async function doctor(): Promise<number> {
  let ok = true;
  for (const [agent, args] of [["claude", ["--version"]], ["codex", ["--version"]], ["opencode", ["--version"]], ["git", ["--version"]]] as const) {
    const r = await exec(agent, [...args]);
    const line = (r.stdout || r.stderr).trim().split(/\r?\n/)[0];
    console.log(`${r.code === 0 ? pc.green("✓") : pc.red("✗")} ${agent.padEnd(9)} ${r.code === 0 ? line : pc.red("not found")}`);
    if (r.code !== 0 && agent !== "opencode") ok = false;
  }
  console.log(pc.dim(`state: ${orchHome()}`));
  return ok ? 0 : 1;
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { repo: { type: "string" }, config: { type: "string" }, guidance: { type: "string" }, agent: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [command, planArg, ...rest] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  if (command === "doctor") return doctor();
  if (!planArg) {
    console.error(`ho ${command}: missing <plan.md>\n\n${USAGE}`);
    return 1;
  }
  const repo = resolve(values.repo ?? process.cwd());
  const planFile = resolve(repo, planArg);
  if (!existsSync(planFile)) {
    console.error(`plan file not found: ${planFile}`);
    return 1;
  }
  const store = new Store(join(orchHome(), "harness.db"));
  const runner = new PlanRunner({ repo, planFile, store, config: loadConfig(values.config) });
  runner.on("event", printEvent);
  process.once("SIGINT", () => {
    console.log(pc.yellow("\nstopping after the current turns finish…"));
    runner.stop();
  });
  try {
    switch (command) {
      case "validate": {
        const { plan, errors, warnings } = runner.load();
        for (const w of warnings) console.log(pc.yellow(`warning: ${w}`));
        for (const e of errors) console.log(pc.red(`error: ${e}`));
        if (!errors.length) console.log(pc.green(`✓ ${plan.tasks.length} tasks; agents: ${plan.tasks.map((t) => `${t.id}→${runner.candidates(t)[0]?.agent}`).join(", ")}`));
        return errors.length ? 1 : 0;
      }
      case "run": {
        const status = await runner.run();
        printStatus(runner);
        return status === "ready" ? 0 : 2;
      }
      case "status":
        runner.load();
        printStatus(runner);
        return 0;
      case "resume": {
        const [taskId] = rest;
        if (!taskId) throw new Error("ho resume: missing <task>");
        if (values.agent && !AGENT_IDS.includes(values.agent as AgentId)) throw new Error(`unknown agent ${values.agent}`);
        await runner.prepare();
        runner.resumeTask(taskId, { guidance: values.guidance, agent: values.agent as AgentId | undefined });
        const status = await runner.run();
        printStatus(runner);
        return status === "ready" ? 0 : 2;
      }
      case "review": {
        const [agent, action] = rest;
        if (!agent || (action !== "approve" && action !== "retry")) throw new Error("ho review <plan.md> <agent> approve|retry");
        await runner.prepare();
        runner.resolveReview(agent, action);
        const status = await runner.run();
        printStatus(runner);
        return status === "ready" ? 0 : 2;
      }
      case "merge": {
        await runner.prepare();
        const sha = await runner.mergeToBase();
        console.log(pc.green(`✓ merged (${sha.slice(0, 8)})`));
        return 0;
      }
      default:
        console.error(`unknown command ${command}\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    console.error(pc.red(error instanceof Error ? error.message : String(error)));
    return 1;
  } finally {
    store.close();
  }
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
