# harnessOrch

A personal agent-team app for Windows. You plan with Claude Opus or Codex. A deterministic engine then runs the plan's tasks across Claude Code, Codex and OpenCode in parallel, checks the work itself, merges it, and pulls you in only when something needs a decision.

The design comes from measuring the old `harness_orchestrator`, which averaged about 2.65M tokens per issue. The waste was inside the workers (inherited global config, whole-file reads, full test logs replayed every turn), not in spawning them. See [docs/research/](docs/research/) and the [M0 measurements](docs/m0-spikes.md).

## How a plan runs

For how the engine works inside (the loop, the task state machine, where state lives), see [docs/architecture.md](docs/architecture.md).

1. **Plan.** Your planner writes `.harness/plans/<slug>.md` in your repo: a YAML header plus `- [ ] **T1 — Title**` tasks, each with a YAML block (`role`, optional `agent`, `model` and `effort`, `goal`, `done_when`, `checks`, `write_scope`, `read_first`, `depends_on`, `skills`).
2. **Run.** The engine schedules tasks by dependency, with at most 3 agents at once.
   - Each agent works through its tasks in **one ongoing session** (cache-warm), in its own git worktree.
   - Tasks with overlapping write scopes never run at the same time.
3. **Done means verified.** A task counts as done only when all of these hold:
   - the agent's structured result says so;
   - the engine's own checks pass (run through a failure-only filter);
   - the changed files stay inside the task's write scope (see [Write scope](#write-scope) below);
   - the commit merges into the plan branch `harness/<slug>`.

   The engine is the only writer of the plan file's checkboxes.
4. **Guardrails.** Repeated failures and blocked agents go to the orchestrator: Codex first, then Opus. It can retry with guidance, reassign the task, fix a check that cannot run (for example Unix-only syntax on Windows; it rewrites that check in the plan file and never drops one), or hand it to you. A paused task holds back only the tasks that depend on it. Usage limits fall back to the next agent, or wait for the reset.
5. **Review.** When an agent's tasks are all done, a *different* agent reviews only that agent's diff. Rejections get at most 2 fix rounds.
6. **Merge.** `ho merge` merges the plan branch into the base branch, after you say so. `ho discard` (or **Discard** on the board) throws a plan away instead: its worktrees and branches are removed without merging.

## Write scope

Every task in a plan has a `write_scope`: the list of files (globs allowed) that the task may change. The planner sets it when it writes the plan:

```yaml
write_scope: ["content/items/ultra-split-bow.json"]
```

**Why it exists.**
- **Parallel safety.** Tasks whose scopes overlap never run at the same time, so two agents never edit the same file at once.
- **No drift.** An agent can't wander off and "improve" unrelated code.

Package manifests and lockfiles are always writable, so agents can add dev dependencies. The plan file, `AGENTS.md` and `CLAUDE.md` never are.

**What happens when an agent edits outside its scope.** It depends on whether the agent *meant* to:

| The agent… | The engine… |
|---|---|
| changed a file but didn't list it in its result (`files_changed`) | treats it as a stray edit and reverts it silently; the task carries on |
| changed a file and listed it, so it says it needs it | keeps the edit parked on the stash and pauses the task in **Needs you** |

When a task pauses for this, the card is titled *"The agent needs files outside its write scope"* and lists the files. You have three choices:
- **Allow files and resume.** The files join the task's scope, the edits come back, and the task finishes. The plan file isn't changed; the allowance is stored with the task.
- **Resume without them.** The engine reverts those files and tells the agent to finish inside its scope, or report that it's blocked.
- **Skip task** or **Restart clean**, as for any paused task.

If a *review fix* needs such files, the review card offers the same choices: **Allow files and continue**, or **Revert them and continue**.

**When to allow.** Allow when the goal really can't be met inside the scope. A typical case is content that needs a small engine or sim fix: for example, an item whose effect needs a bug fixed in the code that computes it. If the files look unrelated to the goal, don't allow them.

From the CLI: `ho resume <plan.md> <task> --allow-scope`, or `ho review <plan.md> <agent> retry --allow-scope`.

## Default routing (Claude Pro + ChatGPT Plus + free models)

| Role | Agents (first available wins) |
|---|---|
| `implement` | Codex |
| `small` | OpenCode free DeepSeek → free GLM → Codex |
| `hard` | Claude Opus → Codex |
| orchestrator | Codex → Claude Opus |
| reviewer of Codex / Claude / OpenCode work | Claude Sonnet / Codex / Codex → Sonnet |

To change any of this, use the ⚙ **Routing & models** dialog in the desktop app. It edits routing per role, reviewers, and the default model of each agent (what a task pinned to an agent runs on when no route names it), and saves to `~/.harnessorch/config.json`. `ho` reads the same file; `--config <file.json>` reads another one instead. Built-in values live in [packages/engine/src/config.ts](packages/engine/src/config.ts).

The Codex model pickers include GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, GPT-6 Luna, and GPT-5.6 Sol, Terra and Luna, following the [current OpenAI model lineup](https://learn.chatgpt.com/docs/models). Custom model ids can also be entered in the pickers or saved under **Extra model ids**. Availability depends on your Codex account.

The desktop app also has a **Graph** view beside the board: tasks by dependency, then each author's review, then the merge. A task that needs you can have its agent and model changed in the Resume box.

## Desktop app

```
npm install
npm run desktop        # builds the engine, then starts the Electron app (dev mode)
npm run app            # builds release/win-unpacked/harnessOrch.exe (in Claude Code here: /build-app)
```

1. **Open repository…** to pick a git repo.
2. In **Routing & models → Planner**, choose Claude Code (Opus by default) or Codex, then its model and thinking effort. **Start planning session** opens that planner's interactive terminal with the shared plan-format prompt. The planner choice is saved independently of task routing and applies to the next planning session. On a folder it hasn't seen before, the CLI may first ask you to trust it.
3. When the planner writes `.harness/plans/<slug>.md`, the plan appears on the board. Change any task's agent from its dropdown (this edits the plan file), then press **Start**.
4. Each agent tab shows that agent's live headless stream. Use **Take over** to resume that agent's own session in a real terminal while the engine holds its lane, and **Hand back** to return it.
5. Paused tasks land in **Needs you**, with a guidance box and an agent picker; you also get a Windows notification. A task that needs files outside its write scope also gets an **Allow files** button (see [Write scope](#write-scope)). When every task is done and reviewed, **Merge to main** appears.

## Status (2026-10-21)

| Milestone | State |
|---|---|
| M0: CLI spikes | Done. See [docs/m0-spikes.md](docs/m0-spikes.md). |
| M1: engine + `ho` | Done. Live runs average about 27–39k effective tokens per task, against about 229k per issue in the old harness on its sandbox and about 2.65M per issue on a real repo. |
| M2: desktop | Board, planner terminal, live agent streams, notifications and merge all work. A live 4-task run was started from the app. **Take over** is built but not yet exercised live. |
| M3: skills | 8 vendored skills: 5 core (by role) and 3 project. The planner is told which project skills exist. Size limits are enforced by tests. |

**Not built yet:**
- An engine MCP server for the planner. The planner writes the file directly and the app watches it.
- Persistent `codex app-server` / Claude stream-json sessions. Today each task is a resumed one-shot turn.
- Packaging with electron-builder.

Codex's `turn.completed` usage is cumulative per thread. The engine stores each thread's totals with its session and records only the difference.

## Engine CLI (`ho`)

```
npm install
npm run ho -w packages/engine -- doctor
npm run ho -w packages/engine -- validate .harness/plans/x.md --repo <repo>
npm run ho -w packages/engine -- run .harness/plans/x.md --repo <repo>
npm run ho -w packages/engine -- status|merge|discard .harness/plans/x.md --repo <repo>
npm run ho -w packages/engine -- resume .harness/plans/x.md T3 --guidance "..." [--agent codex] [--allow-scope] --repo <repo>
npm run ho -w packages/engine -- review .harness/plans/x.md codex approve|retry [--allow-scope] --repo <repo>
```

State lives in `~/.harnessorch/` (SQLite, logs). Worktrees live in `<repo>/../.harness-wt/`.

## Layout

```
packages/engine   pure Node/TypeScript engine (no Electron), Vitest
  src/agents      one turn of Claude / Codex / OpenCode with lean flags + usage reducers
  src/plan        plan-file parser, validator, checkbox write-back
  src/scheduler   pure dispatch rules
  src/engine      the plan runner and its git operations
  src/checks      check runner, failure filter, scope check (assets/hverify.mjs for workers)
  src/brief       task briefs, result schema, session handoffs
  src/review      diff-only review prompt and verdict
  src/orchestrator decision and conflict prompts
  src/store       node:sqlite state and token ledger
  src/util, src/adapters, src/git, src/ledger   proven modules copied from harness_orchestrator
  src/planner     the Claude/Codex planning session's prompt and lean flags
  src/skills      skill library listing and per-brief selection
apps/desktop      Electron 45 + React + xterm + node-pty: board, planner terminal, agent streams
skills/           vendored, pinned skill library (see skills/README.md)
```

## Development

```
npm test          # engine tests (includes copied suites; real git, no tokens)
npm run typecheck
npm run lint
```
