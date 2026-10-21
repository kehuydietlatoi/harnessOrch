# Existing repo audit: `harness_orchestrator` (`orch`) and why it uses so many tokens

Sources here are local files on this machine. Links use `file:///` paths. "Studio" means the `studio` branch worktree, the most recent code. Abbreviations: `HO` = `C:/Users/Hung/Documents/projects/harness_orchestrator`, `HOS` = `C:/Users/Hung/Documents/projects/harness_orchestrator-studio`, `ORCH` = `C:/Users/Hung/.orch`. All token numbers come from orch's own telemetry (`runs.jsonl`) or from raw harness JSONL logs. I aggregated them with a throwaway script.

## Where is the repo, and what other candidates exist?

### Takeaway
The old app is **`C:\Users\Hung\Documents\projects\harness_orchestrator`**. It is a TypeScript/Node CLI named `orch`, with GitHub remote `kehuydietlatoi/harness_orchestrator`. Its newest code lives on the `studio` branch, which is checked out as a linked git worktree at `C:\Users\Hung\Documents\projects\harness_orchestrator-studio`. Runtime state lives in `C:\Users\Hung\.orch\<project>\`.

### Cited Findings
- The package name is `harness-orchestrator` v0.1.0, with bin `orch` and description "Run Claude Code + Codex as parallel coding agents with atomic task-claim, git-worktree isolation, and mandatory cross-harness review before merge". Its only runtime dependencies are `commander` and `picocolors`. — [HO/package.json](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/package.json)
- The remote is `https://github.com/kehuydietlatoi/harness_orchestrator.git`. The main branch has 135 commits, starting 2026-08-20 ("Initial core: parallel Claude Code + Codex orchestrator (P0-P3)"). The last commit is `5460cad` (#242). — `git log` in HO
- `harness_orchestrator-studio/.git` is a gitdir pointer to `HO/.git/worktrees/harness_orchestrator-studio`, so it is the same repo on branch `studio`. It has 148 commits, the last on 2026-10-21 ("re-observe once and never cascade (#239)"). It holds about 17.5k lines of `src` TypeScript and about 16.5k lines of tests. — [HOS/.git](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/.git), `git log` in HOS
- Other related folders:
  - `C:\Users\Hung\Documents\projects\orch-sandbox` is a toy target repo used for live autopilot tests. It contains small JS helpers, `.studio` domain pack, `opencode.json` and `orch.config.json` with claude/codex/opencode.
  - `C:\Users\Hung\Documents\projects\wt\` is the `worktreeRoot` that holds the per-issue worktrees.
  - `C:\Users\Hung\.orch\` holds per-project state: `runs.jsonl`, `events.jsonl`, `sessions/`, `briefs/`, `availability.json`, and `issue-N` dirs.
  - `C:\Users\Hung\Documents\projects\DummyMultiAgenticProject` is empty.
  
  — directory listings; [orch-sandbox/orch.config.json](file:///C:/Users/Hung/Documents/projects/orch-sandbox/orch.config.json)
- The project's own description: "One gate, then hands-off… `orch plan` opens an interactive session with the lead (Claude on Opus by default)… creates the issues… runs `orch autopilot`". — [HO/README.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/README.md)

### Inferences
- "Each issue is a ticket and an agent is spawned per ticket" describes this repo exactly. Tickets are GitHub Issues, and every lifecycle step spawns a fresh or resumed harness process.

### Gaps
- `plan-brief.md` names a related repo, "agenticGamedevSkills `docs/HANDOFF-phase3-observe.md`". I did not locate it.
- I did not inspect `C:\Users\Hung\game-agent-workflow-template`.

## Stack, entry points, data model and agent-spawn mechanism

### Takeaway
Stack:
- **Node ≥20, TypeScript, commander.**
- **GitHub Issues/PRs as the database**, through the `gh` CLI. Labels project the state.
- **Git refs as locks**, with one git worktree per issue.
- **Child processes** for each harness CLI: `claude -p`, `codex exec`, `opencode`.
- A pure decision table (`decideStep`) drives an autopilot loop.

There is no orchestrating LLM. The coordinator is deterministic code, and LLMs are only called as stateless workers, reviewers or judges.

### Cited Findings
- Glossary terms:
  - Board: "There is no separate database; views and labels are derived projections."
  - Claim: "acquire a git-ref lock (`refs/orch/lock/issue-<n>`), label it `status:claimed` + `agent:<me>`, cut a worktree".
  - Worktree: `../wt/issue-<n>`.
  - Telemetry: "one `RunRecord` appended to `~/.orch/<project>/runs.jsonl` per completed run (tokens, cost, duration, outcome)".
  
  — [HO/CONTEXT.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/CONTEXT.md)
- The CLI surface is `orch init/doctor/plan/assign/run/dispatch/autopilot/review-run/review-approve/merge/repair/abandon/board/serve/report/memory`. The entry point is `src/cli.ts`, built to `dist/cli.js`. — [HO/README.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/README.md), [HO/src/cli.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/src/cli.ts)
- The adapter interface (`HarnessAdapter`) has these methods:
  - `runTask(ctx)`: prompt on stdin, worktree as cwd, optional `resumeSession`, `maxBudgetUsd`, `timeoutMs`.
  - `runHeadless(ctx)`: planner, judge, reviewer, observe and triage; `readOnly` for reviewers.
  - `runInteractivePlan`.
  - `healthCheck`.
  
  — [HOS/src/adapters/types.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/adapters/types.ts)
- Exact CLI invocations:
  - Claude task: `claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools Read,Edit,Write,Bash [--max-budget-usd N] (--session-id <new uuid> | --resume <id>) [--model M] [--effort E]`.
  - Claude reviewer: `-p --output-format stream-json --verbose --allowedTools Read,Grep,Glob --disallowedTools Edit,Write,Bash,NotebookEdit`.
  - Claude interactive plan: `--append-system-prompt <seed> --allowedTools Read Grep Glob Write`.
  - On Windows all of these spawn with `shell: true`.
  
  — [HOS/src/adapters/claude.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/adapters/claude.ts)
- Codex invocations:
  - Task: `codex exec --approve-for-me --json [-m M] [-c model_reasoning_effort=E] [resume <thread_id> -]`.
  - Reviewer: `codex exec --json -s read-only`.
  - The session id is parsed from the `thread.started` event.
  - There is an abort guard for when Codex starts `spawn_agent`/`collab_tool_call` sub-agents. A review once stalled for 71 minutes waiting on Codex's own sub-agents (PR #75).
  
  — [HOS/src/adapters/codex.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/adapters/codex.ts)
- The OpenCode adapter works like this:
  - It runs the native `opencode.exe` without a shell.
  - It writes a per-run temporary `config.json` with a permission map: deny-by-default bash, an allowlist of git status/diff/log, rg and ls, the verify argv, `git push` denied, and webfetch denied.
  - It sets `OPENCODE_CONFIG` and `OPENCODE_DISABLE_PROJECT_CONFIG=true`, and blanks `OPENCODE_CONFIG_CONTENT/DIR/PERMISSION`.
  - `pingEndpoint` sends "Reply OK" to probe the model before a claim.
  
  — [HOS/src/adapters/opencode.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/adapters/opencode.ts)
- Worker environment: `cleanEnvironment` strips `ANTHROPIC_*`, `OPENAI_*`, `OPENCODE_*`, `CODEX_*` and any `*TOKEN/API_KEY/AUTH/PASSWORD/SECRET*` variables. It then restores only names on the per-adapter allowlist (Codex keeps `CODEX_HOME`). GitHub tokens are never passed to workers. — [HOS/src/util/environment.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/util/environment.ts)
- Autopilot step kinds come from the pure decision table: `cascade | none | review | observe | fix(review|ci|observe) | resolve-conflict | merge | await-human | wait | triage | escalate`. The table re-derives the next step from GitHub/Git facts on every wake-up. — [HOS/src/tasks/steps.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/steps.ts)
- Every place that spawns a harness:
  - `runner.ts` (implement).
  - `step-exec.ts` (fix and resolve-conflict through `runAgent`, plus lead triage through `runHeadlessAgent`).
  - `board/review-run.ts` (review).
  - `tasks/observe-judge.ts` (observe gate, studio only).
  - `routing/judge.ts` (routing judge).
  - `tasks/planner.ts` (draft and interactive plan).
  - `commands/report.ts` (`--summarize`).
  
  — grep over [HO/src](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/src)
- Example config: the main repo's `orch.config.json` uses `agents: [claude, codex]`, `lead: claude`, `requireCrossReview: true`, `maxConcurrent: 2`, `taskTimeoutMs: 1800000` and `baseBranch: studio`. The README's default models are `claude-sonnet-5-5`@medium for both easy and hard tiers, a Claude lead of `claude-opus-5-5`@high, and Codex `gpt-6.1-sol`. — [HO/orch.config.json](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/orch.config.json), [HO/README.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/README.md)
- The user-level Codex config (`~/.codex/config.toml`) sets `model = "gpt-6.1-sol"` and `model_reasoning_effort = "high"`. It declares MCP servers `node_repl` and `pob2-ai` and about 11 plugins (documents, presentations, spreadsheets, browser, computer-use, code-review, …). orch passes no flag to suppress them. — [~/.codex/config.toml](file:///C:/Users/Hung/.codex/config.toml) (secrets not read), [HOS/src/adapters/codex.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/adapters/codex.ts)

### Inferences
- The architecture deliberately avoids a central LLM. The repo's own ADR-0010 rejected a long-lived supervising "main agent" over cost, crash-safety and safety-boundary concerns. The token cost therefore comes from the workers, not from coordination.
- The planned 1DevTool-style design (one orchestrator agent coordinating a team) is the very alternative ADR-0010 rejected. The new design should keep orch's lesson: the orchestrator's own context must stay small and durable, for example through summaries or a facts store. Otherwise it "re-reads its whole, growing context on every turn at the strongest model's price" ([ADR-0010](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/docs/adr/0010-lead-at-decision-points.md)).

### Gaps
- I did not read `reconcile.ts` (746 lines), `coordinator.ts` or `github.ts` in full. The concurrency and polling details are summarized from the docs and grep only.

## What goes into each spawned agent's context, and the fixed per-spawn overhead

### Takeaway
Each spawn carries four layers of context:
1. **The harness's own global baggage**: system prompt, about 57 tool schemas including 32 user-level MCP tools, 55 skills, 107 slash commands and 4 plugins. In a tiny repo this is about **23.6k tokens for Claude before the first tool call**.
2. **The project memory, `AGENTS.md`**: about 66–72 KB, roughly 16–18k tokens. Claude auto-loads it through `CLAUDE.md` → `@AGENTS.md`, and the brief also tells agents to read it.
3. **The issue body**, with the plan brief embedded in each issue.
4. **Whatever the agent then reads**: whole files and full test or coverage output.

Each tool turn then replays the entire accumulated context.

### Cited Findings
- **Implement brief (legacy path).** It contains the title, agent, worktree and branch, `## Spec` (the full issue body), verify argv, and the line "Read AGENTS.md at the repo root before starting; record durable facts there", followed by "When done: `orch submit …`". — [HOS/src/tasks/brief.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/brief.ts)
- **Pack brief (studio path).** It is rendered from `briefs/brief.md.tmpl` and contains:
  - the role prompt;
  - the `## Conventions` section of AGENTS.md, re-inlined;
  - protected paths, the goal, allowed files and locks;
  - design-anchor sections, capped at 6000 chars;
  - the definition of done, verify argv, the budget and the forbidden list.
  
  Every brief is stored under `~/.orch/<proj>/briefs/issue-N-k.md`. — [HOS/src/tasks/brief-render.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/brief-render.ts)
- **Plan context in every issue.** "orch embeds [the plan brief] in every created issue as a collapsed 'Plan context' block". The issue body is the spec every worker and reviewer reads. — [HO/docs/adr/0010-lead-at-decision-points.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/docs/adr/0010-lead-at-decision-points.md)
- **Memory files.**
  - `CLAUDE.md` is just `@AGENTS.md` (a redirect).
  - `AGENTS.md` is 66,144 bytes on main and 71,611 bytes on studio.
  - Its `## Conventions` section is a long list of per-ticket fact bullets such as "(#207)", "(#205)" and "(#180)".
  
  — [HO/CLAUDE.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/CLAUDE.md), [HO/AGENTS.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/AGENTS.md)
- **Claude's global baggage, measured.** The `system/init` event of a reviewer spawn (log `review-239-claude.jsonl`) shows:
  - `tools` = 57, of which 32 are `mcp__*`;
  - MCP servers `pob2-ai` (a Path of Exile tool), `token-sidekick` (failed), and claude.ai Claude Docs, Google Drive, Calendar and Gmail;
  - 55 skills and 107 slash commands;
  - plugins `academic-research-skills`, `mattpocock-skills`, `cc-plugin-agents-md` and `cc-plugin-telemetry`;
  - a SessionStart hook that injects about 2 KB.
  
  — [HOS/logs/review-239-claude.jsonl](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/logs/review-239-claude.jsonl), [orch-sandbox/logs/observe-42-claude-*.jsonl](file:///C:/Users/Hung/Documents/projects/orch-sandbox/logs/)
- **Claude fixed overhead in a tiny repo.** The first API call of a Claude observe run in `orch-sandbox` (a 509-byte AGENTS.md and a short prompt) reported `cache_read 8,158 + cache_creation 15,433` ≈ **23.6k input tokens** before any tool result. Thirteen Claude observe runs there averaged 48,399 tokens in (max 48,474), over 5 turns at about $0.077 each. The near-zero variance shows the cost is dominated by fixed overhead. — [orch-sandbox/logs/observe-42-claude-c5d703d7-….jsonl](file:///C:/Users/Hung/Documents/projects/orch-sandbox/logs/), [ORCH/orch-sandbox/runs.jsonl](file:///C:/Users/Hung/.orch/orch-sandbox/runs.jsonl)
- **Claude overhead in the orch repo.** A 1-turn Claude review there cost `input 2 + cache_read 8,158 + cache_creation 54,142` = 62.3k tokens, $0.23. The cache creation was all `ephemeral_1h_input_tokens`. — [HOS/logs/review-239-claude.jsonl](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/logs/review-239-claude.jsonl)
- **Codex fixed overhead.** Three Codex reviews in `orch-sandbox` averaged 18,574 tokens in (max 18,611), which also points to near-constant fixed overhead. — [ORCH/orch-sandbox/runs.jsonl](file:///C:/Users/Hung/.orch/orch-sandbox/runs.jsonl)
- **What a Codex worker reads first.** The first command of a Codex implement run (issue #141) was `Get-Content AGENTS.md; Get-Content C:/Users/Hung/.agents/skills/diagnosing-bugs/SKILL.md; git status --short`, with **61,678 chars of output**. It then read whole source files of about 15–30k chars each (`runner.ts`, `service.ts`, `observe.ts`, `coordinator.ts`), ran the full test, coverage and e2e suites, and executed 96 commands across about 70 completed items. — [HOS/logs/issue-141.jsonl](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/logs/issue-141.jsonl)
- **Reviewer prompt.** It inlines the full issue body, the changed-files list and the **entire diff**, never truncated. Above `MAX_DIFF_CHARS` the diff is staged as a file the reviewer must "Read ALL of it, in chunks". — [HOS/src/board/review-run.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/board/review-run.ts)
- **Fix prompt.** When the session resumes, it says only "You wrote this change earlier in this conversation" plus the notes. On a cold start it re-includes the original spec and tells the agent to read `git diff base...HEAD`. — [HOS/src/tasks/step-prompts.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/step-prompts.ts)
- **Pricing table.** orch's built-in table lists `claude-sonnet-5-5` at input $2/M, cached $0.1/M, output $10/M, and `claude-opus-5-5` at $4/$0.2/$20. Codex is treated as flat-rate subscription with null cost. — [HOS/src/board/pricing.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/board/pricing.ts)

### Inferences
- **Fixed per-spawn overhead estimate:**
  - Claude: about 23–25k tokens from global config alone, plus about 16–18k for AGENTS.md when working on the orch repo (66–72 KB at roughly 4 chars/token). That is about **40k+ tokens before any task-specific content**.
  - Codex: about 18k baseline, plus the AGENTS.md and skill reads it does voluntarily (about 15k+).
  
  These figures are approximations derived from the logs above.
- Every spawn starts in a different cwd: a per-issue worktree, or a `mkdtemp` review checkout. Only the roughly 8k global system-prompt prefix gets a cache read across spawns. The rest is cache *creation*, which the API bills at a premium for 1-hour TTL writes. That premium is my understanding of API pricing; it is not stated in the repo.
- The user's global Claude and Codex configs are tuned for interactive personal use: PoE tools, Google Drive, academic-paper skills, office plugins. Headless workers inherit all of it. orch's Claude argv uses `--allowedTools`, but that only restricts *permission*. Tool schemas, skills and MCP servers still load (57 tools were listed in init).

### Gaps
- I could not measure Codex's per-turn breakdown of system prompt versus AGENTS.md versus tools. Codex JSONL gives only cumulative `turn.completed` usage.
- I did not verify which Claude Code or Codex flags would strip user-level MCP, skills and plugins for headless runs (for example `--strict-mcp-config`, `--setting-sources`, `--bare`, `--disable-slash-commands`, or a Codex profile/`CODEX_HOME`). Other researchers should confirm these against current CLI docs.

## Session reuse, prompt caching, and loops that multiply spawns

### Takeaway
- Implement runs always **cold-start**.
- Fix rounds **resume** the author's session, which replays its entire prior transcript. A failed resume falls back to a new cold run.
- Reviews, observe judges, conflict resolutions, triage, routing and planning are **always fresh** sessions.
- **Every push of a new head requires a fresh review.**
- There is no explicit prompt caching; orch relies on the CLIs' automatic caching.

The multipliers are review→fix rounds (up to `maxReviewRounds` 3, plus triage), merge-conflict resolution, observe, and retries.

### Cited Findings
- The session store `~/.orch/<proj>/sessions/issue-N.json` is described this way: "Resume is an optimisation only: if the record is missing, stale, or the harness refuses it, callers fall back to a fresh session". — [HOS/src/tasks/sessions.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/sessions.ts)
- **Implement.** The Claude adapter starts each implement run with `--session-id <randomUUID()>` unless `resumeSession` is set. `runner.ts` never passes `resumeSession` for implement. — [HOS/src/adapters/claude.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/adapters/claude.ts), [HOS/src/tasks/runner.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/runner.ts)
- **Fix.** It reads the saved session and resumes it if the agent matches. On failure it records a `fix-resume-failed` run and re-runs cold with the `fix${round}-cold` log. — [HOS/src/tasks/step-exec.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/step-exec.ts)
- **Resolve-conflict.** The conflict prompt has no `resumeSession`, so it always runs in a fresh session. The resolver comes from `conflictResolvers`, default `["claude","<author>"]`. After pushing, the task goes back to review (`pushAndRequeueReview`). — [HOS/src/tasks/step-exec.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/step-exec.ts), [HO/README.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/README.md)
- **Re-review on every head.** "pushing a new head requires a fresh review". The merge gate requires a commit-bound review naming the other harness. — [HO/README.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/README.md)
- **Escalation limits.** Autopilot escalates "after `maxReviewRounds` fix rounds or two failed attempts at a step". The lead (Opus@high) triages once before escalating (`maxLeadTriage` 1). — [HO/README.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/README.md)
- **Observe gate (studio).** It adds an evidence command (a screenshot plus a state dump) and a vision-capable judge spawn per head before review. A `not-verified` verdict sends the task back to a fix. — [HOS/src/tasks/observe-judge.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/observe-judge.ts), [HOS/docs/adr/0015-observe-gate.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/docs/adr/0015-observe-gate.md)
- **Telemetry, main repo** (`ORCH/harness_orchestrator/runs.jsonl`, 2026-08-23 to 2026-10-07):
  - 76 runs, **83.9M tokens** across 33 issues, about **2.54M tokens per issue**, 2.3 spawns per issue, $27.67 known Claude cost.
  - Issues #91 and #92 each took 12–13 spawns (6–7 reviews, 4 fixes and 1 triage) and about 5M tokens.
  - Codex implement averaged **2.85M tokensIn per run** (max 4.7M).
  
  — [ORCH/harness_orchestrator/runs.jsonl](file:///C:/Users/Hung/.orch/harness_orchestrator/runs.jsonl)
- **Telemetry, studio** (2026-10-18 to 2026-10-21): 168 runs, **153.6M tokens** across 58 issues, about **2.65M per issue**, 2.9 spawns per issue.

  | Phase | Agent / model | Runs | tokensIn | Share | Avg tokensIn | Notes |
  |---|---|---|---|---|---|---|
  | implement | Codex gpt-6.1-sol@medium | 58 | 110.2M | **≈72%** | 1.93M | max 5.7M |
  | fix | Codex | 9 | 25.1M | ≈16% | **2.79M** | above the implement average, because resume replays the whole implement transcript |
  | resolve-conflict | Claude Sonnet | 30 | 11.4M | ≈7% | 380k | $7.48 |
  | review | Claude Sonnet | 66 | 5.1M | ≈3% | 88k | $12.54 |
  | review | Codex | 4 | 0.95M | | | |

  — [ORCH/harness_orchestrator-studio/runs.jsonl](file:///C:/Users/Hung/.orch/harness_orchestrator-studio/runs.jsonl)
- **How much of it is cache replay.** In Codex implement run #141, the final usage was `input_tokens 1,564,547, cached_input_tokens 1,482,752` (**≈95% cached**), with output of only 7,832. The log holds two `thread.started` events: a retried run that re-read AGENTS.md and the same files from scratch. — [HOS/logs/issue-141.jsonl](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/logs/issue-141.jsonl)
- **What causes the merge conflicts.** Of 28 studio resolve logs, **22 contain "CONFLICT (content): Merge conflict in AGENTS.md"**. AGENTS.md is the most-conflicted file by far (44 hits, versus 8 for `runner.ts`). AGENTS.md was changed in 104 of 135 main-branch commits, and the plan brief requires "One AGENTS.md fact line per ticket." — [HOS/logs/issue-*-resolve*.jsonl](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/logs/), `git log -- AGENTS.md`, [HOS/plan-brief.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/plan-brief.md)
- **Same harness, small repo.** In the toy `orch-sandbox` repo, implement averaged:
  - Codex: 194k tokens;
  - Claude: 200k tokens;
  - **OpenCode `deepseek-v4.1-flash-free`: 15k tokens** (14 runs);
  - about 229k tokens per issue overall.
  
  In other words, the same harness costs about 10× less on a small repo with a 509-byte AGENTS.md. — [ORCH/orch-sandbox/runs.jsonl](file:///C:/Users/Hung/.orch/orch-sandbox/runs.jsonl)
- **Review loops in practice.** Codex cross-review of PR #75 "requested changes eleven times", and that PR's diff was 360 KB across 61 files. — [HO/docs/session-summary-2026-10-06.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/docs/session-summary-2026-10-06.md)

### Inferences — where the tokens go, ranked
1. **Agentic context replay in long Codex implement and fix sessions** (≈88% of studio tokens). Each tool turn re-sends the whole conversation. Three things inflate the conversation:
   - a 60k-char opening read of AGENTS.md and a skill;
   - whole-file `Get-Content` reads of 15–30k-char files;
   - full test, coverage and e2e output.
   
   About 95% of this is cache hits, so the dollar or quota cost is much lower than the raw count. But usage limits still bite: orch has cooldown machinery because Codex hit "You've hit your usage limit".
2. **Resumed fix sessions are not cheaper than cold ones here.** Resuming carries the whole implement transcript (avg 2.79M per fix versus 1.93M per implement). A *compact* hand-off would likely be cheaper for small fixes: a summary of the diff plus the review notes.
3. **A self-inflicted conflict loop.** The rule "record durable facts in AGENTS.md, one line per ticket", combined with 2 parallel workers, makes almost every second PR conflict on AGENTS.md. Each conflict costs a cold Claude resolve (about 380k tokens), then a fresh review, and sometimes an observe run. Moving per-ticket facts out of AGENTS.md (an append-only fragments dir, or a DB written by the orchestrator after merge) would remove most of the 30 resolve runs.
4. **AGENTS.md is too big and is read by every spawn.** At 66–72 KB it is loaded or read by every implement, fix, conflict, review and observe spawn, across both harnesses.
5. **Inherited global harness config.** For Claude that means 32 MCP tools, 55 skills and academic plugins; for Codex, the MCP servers and 11 plugins, plus a default effort of `high` in config.toml. This adds about 18–25k tokens to every spawn, and the overhead is paid again for every reviewer, judge and observe spawn.
6. **Cross-review per head and fix rounds.** These multiply spawns: up to `maxReviewRounds` × (fix + review [+ observe]) + triage. Their per-spawn cost is moderate (Claude reviews about 60–90k tokens), but they add up.
7. **Retries re-do everything cold.** When a run fails or is requeued, the next attempt re-reads the same context, as the two threads in the #141 log show.

### Gaps
- `runs.jsonl` records do not keep `cachedInputTokens`; it is only in the raw logs. So I computed the cache share for one sample run, not across all runs.
- Codex runs on a flat subscription, so there is no dollar figure for about 85% of the token volume.

## Reusable components for the new design

### Takeaway
Worth reusing:
- the **adapter layer** (argv builders, stream parsers, session-id capture, usage-limit detection);
- the **process runner** (`spawnLogged`, with Windows `.cmd` shims, PWD isolation and process-tree kill);
- **credential-scrubbed worker environments**;
- **git worktree and claim handling**;
- **telemetry and pricing parsing**;
- the **OpenCode permission sandboxing**;
- the **pure decision-table pattern**.

Less worth reusing: the GitHub-Issues-and-labels-as-database coupling, the reconciliation machinery, and the demo scenario engine.

### Cited Findings
- **Adapters.**
  - Pure argv builders: `buildClaudeTaskArgs`, `buildClaudeReviewArgs`, `buildCodexTaskArgs`, `buildCodexReviewArgs`, `buildOpencodeArgv`.
  - Output reducers: `resultTextFromClaudeStreamJson`, `resultTextFromCodexJson`, `reduceOpencode`.
  - Session-id capture: `sessionIdFromCodexJson`, plus Claude's pre-chosen `--session-id`.
  - The `codexDelegation` stall guard.
  - `lastFencedBlock` for parsing JSON verdicts.
  
  — [HOS/src/adapters/](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/adapters/)
- **Usage-limit detection.** It works from real log shapes ("Codex's 'You've hit your usage limit', Claude's rejected rate-limit event") and records per-agent/model cooldowns in `availability.json`. Cascade hops to the next tier member when a model is unavailable. — [HO/README.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/README.md), [HOS/src/adapters/usage-limit.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/adapters/usage-limit.ts), [HOS/src/tasks/cascade.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/cascade.ts)
- **Hardened process runner.** "Kill every process a worker, verify or evidence run started when the run ends (#236)". "Run trusted argv whose first word is a Windows .cmd/.bat shim, with literal arguments (#238)". `spawnLogged` sets `PWD` to the spawn cwd (#188). — `git log` in HOS, [HO/AGENTS.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/AGENTS.md), [HOS/src/util/spawn.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/util/spawn.ts)
- **Git handling.**
  - Atomic claims via git refs (ADR-0002).
  - Link-safe worktree cleanup that does not follow junctions (#201/#202).
  - Re-claimed branch refresh (#203).
  - Coalesced concurrent fetches (#207).
  - An external-link guard (#205).
  
  — [HOS/src/git/worktree.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/git/worktree.ts), [HOS/src/git/lock.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/git/lock.ts), [HO/docs/adr/0002-atomic-claim-via-git-ref.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/docs/adr/0002-atomic-claim-via-git-ref.md)
- **Telemetry.** `extractUsage` handles Claude stream-json, Codex JSONL and OpenCode, folds cache reads and creation into tokensIn, and records the cached share separately. The `RunRecord` includes phase and round. `orch report` computes rounds to approval, escalation rate and cost per merged task. — [HOS/src/board/telemetry.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/board/telemetry.ts), [HOS/src/board/pricing.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/board/pricing.ts), [HOS/src/board/report.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/board/report.ts)
- **Scope and budget enforcement.**
  - `scope-guard.ts` checks the `write_scope`/`forbidden` globs.
  - `budget.ts` handles per-ticket USD, time and request caps.
  - `--max-budget-usd` is passed to Claude.
  
  — [HOS/src/tasks/scope-guard.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/scope-guard.ts), [HOS/src/tasks/budget.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/budget.ts)
- **Review contract.** The read-only reviewer prompt follows the untrusted-data convention, judges against a Definition of Done, and puts non-blocking items in `followups` to stop review loops from diverging. A JSON verdict is bound to the head SHA. — [HOS/src/board/review-run.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/board/review-run.ts)
- **Dashboard.** A single-file `public/index.html` (98.5 KB) and `src/server/server.ts` (17.5 KB) serve a localhost board with Suggest → edit → Apply routing, dispatch, and an in-memory demo mode. — [HOS/public/index.html](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/public/index.html), [HOS/src/server/server.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/server/server.ts)
- **Test suite.** There are 94 test files and a coverage ratchet; the unit test count went "from 387 to 695" in one session. — [HO/docs/session-summary-2026-10-06.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/docs/session-summary-2026-10-06.md)

### Inferences
- **Reuse almost as-is:**
  - the adapters, `spawn.ts`, `environment.ts`, `telemetry.ts`, `pricing.ts`, `usage-limit.ts`, `availability`, `cascade` and the OpenCode permission config. These map directly onto "Codex does frontend, OpenCode does small tasks";
  - the worktree and lock modules;
  - the review-verdict contract.
- **Rethink:**
  - The GitHub Issues/labels state store: every transition is a `gh` call, and `reconcile.ts` (746 lines) exists mainly to repair label drift.
  - The "fresh reviewer per head" and "fresh conflict resolver" policies.
  - AGENTS.md as an append-only fact log.
  - Implicit inheritance of the user's global harness config.
- **Design levers the data supports:**
  - A lean, dedicated worker profile per CLI (no personal MCP servers, skills or plugins).
  - A small curated AGENTS.md, with per-ticket facts stored elsewhere.
  - Targeted context packs instead of "read AGENTS.md and explore".
  - Capped tool-output sizes and focused test commands.
  - Compact hand-offs (diff plus notes) instead of resuming multi-million-token sessions.
  - Serialized or orchestrator-owned edits to shared docs.
  - Routing small tasks to OpenCode or cheap models, which measured 15k versus about 200k tokens per implement on the sandbox.

### Gaps
- I did not assess UI quality beyond file sizes and the README description. I also did not run the test suite, because this audit was read-only.
