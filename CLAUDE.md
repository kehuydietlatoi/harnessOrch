# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

harnessOrch is a personal Windows desktop app. Opus writes a markdown plan, and a deterministic engine runs its tasks across Claude Code, Codex and OpenCode in parallel, in git worktrees. See README.md for the user-facing flow and routing defaults.

## Commands

```
npm install
npm test                    # engine tests (Vitest; real git, no tokens)
npm run typecheck           # engine only
npm run lint                # eslint, whole repo
npm run desktop             # build engine, then start Electron in dev mode
npm run ho -- <cmd> ...     # engine CLI: doctor | validate | run | status | merge | resume (see README)

# one file / one test (from packages/engine)
npx vitest run test/runner.test.ts
npx vitest run test/units.test.ts -t "reads Codex usage"
```

- The desktop app imports `@harnessorch/engine` from its `dist/`. After changing the engine, run `npm run build -w packages/engine` before typechecking or running the desktop app (`npm run typecheck -w apps/desktop`).
- `test/runner.test.ts` drives full plans against a temporary real git repo with a scripted fake `runTurn`. It is slow (about 30–40s). Tests that need live CLIs are skipped unless an env var opts in, e.g. `ORCH_OPENCODE_LIVE=1`.

## Architecture

**Two packages.** `packages/engine` is pure Node/TypeScript with no Electron, so the `ho` CLI and the desktop app share it. `apps/desktop` (Electron + React + xterm + node-pty) is a thin host: `src/main/index.ts` creates one `PlanRunner`, exposes it over `ipcMain.handle`, and forwards its `"event"` emissions to the renderer. The public engine API is `packages/engine/src/index.ts`.

**`PlanRunner` (`src/engine/runner.ts`) is the core.** It reads the plan file and schedules tasks with the pure rules in `src/scheduler`. For each task it runs a turn, runs the plan's checks, reverts stray out-of-scope files (or pauses for you when the agent lists them as needed; allowed paths are stored per task in `extra_scope`), merges into the plan branch `harness/<slug>`, and ticks the checkbox. The runner is the only writer of plan checkboxes. On failure or a blocked task it escalates to an orchestrator turn (`src/orchestrator`), which can retry, reassign, amend a check that cannot run (`setTaskChecks` rewrites it in the plan file), or pause for a human. When an author's tasks are all done, a different agent reviews its diff (`src/review`). Host actions are methods on the runner: `resumeTask`, `skipTask`, `resolveReview`, `hold`/`release` (take over and hand back), `mergeToBase`.

**Config** is `DEFAULT_CONFIG` (`src/config.ts`) overlaid with `~/.harnessorch/config.json` by `loadConfig` (`src/user-config.ts`); the desktop Settings dialog writes that file and calls `PlanRunner.setConfig`. A task pinned to an agent gets its model from `refFor` in the runner (routes, then `adapters[agent].defaultModel`), because OpenCode cannot run without one.

**All agent I/O goes through `runTurn` (`src/agents/turn.ts`).** It is one headless turn of one CLI with lean flags: no user config, MCP, plugins or skills, and a restricted tool list. It parses the JSONL log with a per-agent reducer into `TurnResult` (text, structured result, session id, usage). The runner gets `runTurn` through `deps`, which is how tests fake agents. Each agent keeps one session per plan ("lane"), resumed across tasks to keep the cache warm, and rotated with a handoff when context passes `sessionCeilingTokens`.

**Usage reporting differs by CLI. Getting this wrong has caused real bugs:**
- Claude streams one `assistant` event per content block, each repeating the request's usage, so count once per `message.id`.
- Codex's `turn.completed` is cumulative per thread. The session stores `threadTotals`, and a resumed turn records the difference.
- OpenCode reports per `step_finish`.

`budgetWatcher` (`src/ledger/effective.ts`) kills turns live on Claude and OpenCode streams. Effective tokens weight cache reads and writes (`ledger/`).

**State.** Everything lives in SQLite through `node:sqlite` (`src/store/store.ts`, `~/.harnessorch/harness.db`): plans, tasks, lane sessions, runs (the token ledger), reviews and events. The schema is `CREATE TABLE IF NOT EXISTS`. To add a column to an existing table, add an `ALTER TABLE` guarded by `PRAGMA table_info` in the `Store` constructor. Logs and check output go under `~/.harnessorch/<repo>/<plan>/`. Worktrees go in `<repo>/../.harness-wt/`.

**Worker context is deliberately lean.** This is the reason the project exists: the old harness wasted tokens on replayed context. Briefs (`src/brief`) stay at or under 2k tokens. Check output is filtered to failures (`src/checks`). Skills are passed as file paths chosen per role (`src/skills`, `skills/`; tests enforce size limits). Don't add always-on LLM supervision or broaden worker flags without measuring the token cost.

**Dependencies.** Agents may add dev dependencies themselves. `src/engine/deps.ts` reverts production-dependency changes and upgrades or removals unless the task lists the package in `deps:`. After a lockfile changes, the engine installs in that worktree.

`src/util`, `src/adapters`, `src/git` and `src/ledger` were copied from the older `harness_orchestrator` along with their tests.

**Plan format.** The planner prompt is `src/planner`. It is parsed and validated by `src/plan/plan.ts`: a YAML header, then `- [ ] **T1 — Title**` tasks, each followed by a YAML block.
