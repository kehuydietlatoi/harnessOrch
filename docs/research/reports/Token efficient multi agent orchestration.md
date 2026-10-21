# Fix the workers, then add the orchestrator

Your old `orch` did not burn tokens on coordination. It had no LLM coordinator at all. The waste happened inside the workers. On the `studio` branch, **168 runs consumed 153.6M tokens across 58 issues (about 2.65M per issue)**, and **Codex implement and fix sessions accounted for about 88%** of that. Four things drove it. Every agent read a 66–72 KB `AGENTS.md`. Each Claude spawn inherited roughly 24k tokens of your personal MCP servers, skills and plugins. Agents read whole files and full test output, then replayed that context on every turn. And a rule requiring "one AGENTS.md fact line per ticket" caused most of the 30 merge-conflict resolver runs. Adding "one orchestrator agent" on top of that would not fix any of it, and done carelessly it would add a new multiplier. Build a **deterministic engine** instead, with these parts:

- SQLite state.
- The adapters ported from `orch`.
- Budgets enforced in code.
- A **thin Claude orchestrator agent**. It plans with you interactively and is otherwise called only at decision points, with compact state digests.
- **Model-sticky, long-lived lane workers**: Codex over `app-server` for frontend, Claude Sonnet through the Agent SDK for backend, and OpenCode `serve` with cheap models for small tasks. Each gets a brief of about 2k tokens and returns a schema-bound summary. Each runs under a stripped config profile.
- **One diff-only review per ticket at the final head**, capped at two rounds.

For skills, vendor about fifteen from mattpocock/skills and pstack. Assign them per role. The orchestrator injects 0–2 of them into each brief instead of installing them globally. On build versus extend, 1DevTool already gives you terminals, category routing, team manifests and task gates. I found no hard token or dollar caps in it, its delegated runs get permission-bypass flags added automatically, and it is proprietary. So **build the engine as a headless CLI+MCP service that runs inside 1DevTool**, and postpone any desktop shell. Start with a one-week "Phase 0" that applies three fixes to the old repo and confirms the diagnosis. Then aim for **≤1M tokens per issue in Phase 1 and ≤500k by Phase 3**.

## Workers, not coordination, consumed 2.65M tokens per ticket

`orch` is a TypeScript CLI that drives `claude -p`, `codex exec` and `opencode` as child processes. It uses GitHub Issues and labels as its database and git refs as locks, and a pure decision table (`decideStep`) picks every step. Its own ADR-0010 rejected a long-lived supervising "main agent". The reason given: such an agent "re-reads its whole, growing context on every turn at the strongest model's price" ([ADR-0010](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/docs/adr/0010-lead-at-decision-points.md)). The coordinator was therefore never the problem. Per-phase telemetry shows where the tokens actually went ([studio runs.jsonl](file:///C:/Users/Hung/.orch/harness_orchestrator-studio/runs.jsonl)):

| Phase | Agent | Runs | tokensIn | Share | Avg per run |
|---|---|---|---|---|---|
| implement | Codex gpt-6.1-sol@medium | 58 | 110.2M | ~72% | 1.93M (max 5.7M) |
| fix (resumed) | Codex | 9 | 25.1M | ~16% | **2.79M** |
| resolve-conflict | Claude Sonnet | 30 | 11.4M | ~7% | 380k ($7.48 total) |
| review | Claude Sonnet | 66 | 5.1M | ~3% | 88k ($12.54 total) |

The main branch tells the same story: **76 runs, 83.9M tokens, 33 issues, about 2.54M per issue**. Issues #91 and #92 each took 12–13 spawns and about 5M tokens ([main runs.jsonl](file:///C:/Users/Hung/.orch/harness_orchestrator/runs.jsonl)).

The dominant cost is **context replay inside long sessions**. Codex implement run #141 started by reading `AGENTS.md` plus a skill file, **61,678 characters of output before any work**. It then read whole 15–30k-character source files and ran the full test, coverage and e2e suites over 96 commands. Its final usage showed **1,564,547 input tokens, 95% of them cached, against only 7,832 output tokens** ([issue-141.jsonl](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/logs/issue-141.jsonl)). The cache discount means the raw count overstates dollars. Codex also ran on a flat subscription, so about 85% of the token volume has no dollar figure. But on subscriptions, tokens are *capacity*: orch already needed cooldown machinery because Codex kept hitting "You've hit your usage limit" ([usage-limit.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/adapters/usage-limit.ts)). This pattern matches published data. An October 2026 study of SWE-bench agents found input tokens drive cost. It also found that Explore and Fix take about two-thirds of all rounds, and that **expensive failed runs show sharp increases in redundant file viewing** ([arXiv 2604.22750](https://arxiv.org/html/2604.22750v3)).

The second cost is **fixed per-spawn overhead that you never chose**. A Claude reviewer's `system/init` event listed 57 tools, 32 of them MCP tools: a Path of Exile server, Gmail, Drive and Calendar. It also listed 55 skills, 107 slash commands and four plugins, including academic-research-skills. In a tiny repo, the first Claude request already carried **about 23.6k input tokens before any tool call** ([review-239-claude.jsonl](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/logs/review-239-claude.jsonl), [orch-sandbox logs](file:///C:/Users/Hung/Documents/projects/orch-sandbox/logs/)). `--allowedTools` limits what a tool may do, not whether its schema loads. Codex reviews averaged about 18.5k tokens even in the sandbox. Your `~/.codex/config.toml` adds MCP servers, 11 plugins and `model_reasoning_effort = "high"` to every worker ([config.toml](file:///C:/Users/Hung/.codex/config.toml)). Add 16–18k tokens of `AGENTS.md`, and each spawn in the orch repo pays roughly 40k tokens before task content. An independent proxy measurement found the same shape: **Claude Code sends about 33k tokens of preamble versus about 6.9k for OpenCode**, and a 72 KB instruction file adds about 20k tokens per request ([Systima](https://systima.ai/blog/claude-code-vs-opencode-token-overhead)).

The third cost is **two self-inflicted multipliers**:

- **Resumed fix sessions cost more than the original implement.** They averaged 2.79M against 1.93M, because resume replays the whole implement transcript.
- **The AGENTS.md fact log creates merge conflicts.** **22 of 28 resolve logs contain "Merge conflict in AGENTS.md"**. The file changed in 104 of 135 main-branch commits because the plan brief required one fact line per ticket ([plan-brief.md](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/plan-brief.md)). Each conflict cost a cold Claude resolve of about 380k tokens and then a fresh review.

Review loops add spawns (PR #75 drew eleven change requests, per [session summary](file:///C:/Users/Hung/Documents/projects/harness_orchestrator/docs/session-summary-2026-10-06.md)), but reviews were only 3% of tokens.

A rough calculation corrects the framing of the original question. About 40k tokens of fixed overhead × 2.9 spawns per issue ≈ 116k tokens, **only about 4% of the 2.65M per issue**. "An agent per ticket" was the visible symptom. The real cause was that each agent gathered far too much context and then replayed it. The control case shows this. In the toy `orch-sandbox` repo, which has a 509-byte `AGENTS.md`, the same harness averaged about 200k tokens per implement for Codex or Claude. **OpenCode with `deepseek-v4.1-flash-free` averaged 15k** ([sandbox runs.jsonl](file:///C:/Users/Hung/.orch/orch-sandbox/runs.jsonl)). The lesson for the new design is to fix context hygiene first and choose the orchestration topology second.

## Keep the orchestrator thin: an LLM at decision points over a deterministic engine

The evidence argues against a long-lived supervising agent that reads everything:

- **Agent teams.** Claude Code's own docs put them at about 7x the tokens of a normal session ([Claude Code costs](https://code.claude.com/docs/en/costs)).
- **Anthropic's research system.** Multi-agent research used about 15x chat tokens, and Anthropic warns that coding has "fewer truly parallelizable tasks than research" ([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)).
- **A 2026 postmortem.** A Claude orchestrator that spawned fresh subagents per phase burned **1–2M Opus tokens per task, even on trivial diffs**. The multipliers were model inheritance (1.7x), cache misses from freshly tailored prefixes (12x) and review-until-clean loops (3–5x). The root cause: "budget constraints lived in system prompts… rather than enforceable guardrails" ([dev.to postmortem](https://dev.to/akashy/my-agent-orchestrator-burned-1-2m-opus-tokens-per-task-heres-the-postmortem-2k7g)).

Your new app should therefore keep orch's deterministic core and add the LLM orchestrator as a **decision-point service**, not a supervisor.

### The orchestrator agent has two modes, and neither is long-lived

**Planning mode** is an interactive Claude Opus 5.5 session with you. It is the only place where human-in-the-loop skills such as grilling make sense. It ends by emitting a plan and tickets as a schema-validated object that the engine stores. **Decision mode** is a fresh, short call made only when the engine reaches a fork it cannot settle by itself: triage after two failed rounds, re-planning when a ticket turns out larger than estimated, or assigning a category to an ambiguous ticket. Each call gets a **state digest of ≤5k tokens built from SQLite**: ticket, attempts, result summaries and failing-test excerpts. It never gets transcripts.

Routing stays deterministic. The orchestrator picks a *category* and a table picks the agent and model. This is the pattern 1DevTool already uses (your applied policy maps plan→opencode, implement→codex, review→claude) and that oh-my-opencode uses for category→model mapping ([1DevTool config, local](file:///C:/Users/Hung/AppData/Roaming/1devtool/1devtool.json); [oh-my-opencode agents](https://mintlify.com/code-yeongyu/oh-my-opencode/concepts/agents)). Research on lightweight models for bounded coordination decisions reports **45–97% token reductions** ([arXiv 2610.08155](https://arxiv.org/abs/2610.08155v1)). Every dispatch names its model explicitly. Nothing inherits.

### Workers live in model-sticky lanes and batch related tickets

Prompt and KV caches are per model, so **every hop between Claude, Codex and a cheap model pays the prefill again** ([arXiv 2601.12307](https://arxiv.org/html/2601.12307v1)). The same study found that one agent playing several roles in a continuing conversation matched multi-agent quality at **50–90% lower cost**, because prefill grows incrementally instead of starting from scratch. Lanes put that finding into practice. Each lane is a long-lived session bound to one model and one area of the codebase. Related tickets are fed into it one after another, so its codebase knowledge and its cached prefix carry over. Cognition's production rule points the same way: "writes stay single-threaded and additional agents contribute intelligence rather than actions" ([ZenML summary of Cognition](https://www.zenml.io/llmops-database/multi-agent-systems-in-production-code-generation-and-review-at-scale)). Keeping one writer per area also removes most merge conflicts at the source.

| Lane | Agent / model | Session policy | Why |
|---|---|---|---|
| Plan / decide | Claude Opus 5.5 | Interactive session; fresh short calls for decisions | Judgment-heavy, low volume |
| Frontend | Codex (model from config, `medium` effort) | One `app-server` thread per epic/area, rotated at a context ceiling | Codex was your implement workhorse; keep its cache warm |
| Backend | Claude Sonnet 5.5 | One SDK session per area, rotated at a context ceiling | Long-lived context is cheap here: cache reads cost $0.10/MTok |
| Small tasks | OpenCode + cheap model | Fresh session per task on a warm `opencode serve` | Low preamble (~7k) and byte-identical prefixes make fresh sessions cheap |
| Review | Claude Sonnet 5.5 (Codex optional) | Fresh, diff-only | Isolation is the point |

Use explicit rules for when a lane session continues and when it rotates. Continue while the next ticket touches the same area, the idle gap stays under the cache TTL, and accumulated context stays below a ceiling. I recommend starting at about 150k tokens and tuning it from the ledger. At rotation, the lane writes a handoff note to the facts store and starts fresh. The prices favour this approach. On Sonnet 5.5, re-reading 100k of warm context costs about $0.01 per request. A fresh worker paying a 54k cache write costs about $0.135 before doing any work ([Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing); [rulestack measurement](https://dev.to/rulestack/we-said-a-claude-code-subagent-costs-436k-tokens-a-cleaner-measurement-says-54k-here-is-what-37am)).

Fix rounds follow the same logic. **Resume the author's session only while it is under the ceiling and warm.** Otherwise, start a lean session with a compact fix packet: the diff stat, the review findings and the filtered failing-test output. That is the direct remedy for the 2.79M-token resumed fixes. The owning lane resolves merge conflicts in its warm session, instead of a cold resolver that has to rediscover everything.

Parallelism belongs across lanes and across disjoint write scopes. The old `scope-guard.ts` globs can enforce that ([scope-guard.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/scope-guard.ts)). Delegate read-heavy exploration to a separate agent only above the practitioner break-even of about **33–50k tokens of material** ([rulestack](https://dev.to/rulestack/we-said-a-claude-code-subagent-costs-436k-tokens-a-cleaner-measurement-says-54k-here-is-what-37am)).

### State moves from GitHub labels to SQLite, and facts move out of AGENTS.md

Replace "GitHub Issues as the database" with a local SQLite store holding tickets, runs, sessions, gates, facts and the ledger. Emdash uses the same local-SQLite pattern ([Emdash](https://github.com/generalaction/emdash)). Keep the git-ref claim locks from ADR-0002. Treat GitHub as an optional projection: open the PR at review time and nothing more. This removes the label-drift repair work that most of `reconcile.ts`'s 746 lines exist for.

Per-ticket facts go into a `facts` table, written by the engine after merge. Briefs pull only the facts relevant to the ticket's paths. `AGENTS.md` shrinks to a curated file of **under about 200 lines**, the size Claude Code's docs recommend, with workflow detail pushed into on-demand skills ([Claude Code costs](https://code.claude.com/docs/en/costs)). Only the orchestrator regenerates it, in a serialized step. No worker may edit it.

### Treat model names and prices as configuration, not facts

Several model identifiers in the research are volatile:

- **Codex.** Your config uses `gpt-6.1-sol`, 1DevTool's skill maps `gpt-5.6-sol`, and OpenAI's Codex pricing page mentions both GPT-6.x names and "GPT-5.6 Sol" while apparently being mid-update ([Codex pricing](https://learn.chatgpt.com/docs/pricing)).
- **"Haiku 5.5".** The pricing notes list a "Haiku 5.5" at $0.10/MTok input. I could not independently verify that model. The newest Haiku I can confirm is **Haiku 4.5 (`claude-haiku-4-5`, $1/$5 per MTok)**. Plan any cheap-Claude lane on Haiku 4.5 until "Haiku 5.5" is confirmed.
- **Open-model prices.** These come from aggregators, for example DeepSeek V4.1 Flash at $0.07/$0.50 ([TeamDay](https://www.teamday.ai/blog/top-ai-models-openrouter-2026)).

Keep every model ID in the routing table and probe each one at startup. orch's `healthCheck` and OpenCode's `pingEndpoint` "Reply OK" probe already do this.

## Each CLI gets a lean, long-lived, schema-bound channel

Every target agent now supports "prompt in, JSON-schema-validated object out" plus a resumable session handle. The engine can therefore hold only session IDs and summaries, and leave transcripts on disk on the worker side.

| Agent | Transport | Structured result | Session handle | Config isolation | Budget hook |
|---|---|---|---|---|---|
| Claude | TS Agent SDK, streaming input (or `claude -p --input-format stream-json`) | `--json-schema` → `structured_output` | `session_id`, `--resume`, `--fork-session` | `settingSources: []`, `strictMcpConfig`, explicit `skills`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, dedicated `CLAUDE_CONFIG_DIR`; or `--bare` with an API key | `--max-budget-usd`, `--max-turns`, SDK `interrupt()` |
| Codex | `codex app-server` over stdio (JSON-RPC) | per-turn `outputSchema` | `thread/resume`, `thread/fork` | `--ignore-user-config` or a dedicated `CODEX_HOME` | `turn.completed` usage, then `turn/interrupt` |
| OpenCode | `opencode serve` HTTP + `@opencode-ai/sdk` | `format: {type:'json_schema'}` | session IDs, `fork`, `summarize` | per-run `OPENCODE_CONFIG` + `OPENCODE_DISABLE_PROJECT_CONFIG=true` (orch already does this) | `POST /session/:id/abort` |

Sources: [Claude headless](https://code.claude.com/docs/en/headless), [Claude CLI reference](https://code.claude.com/docs/en/cli-reference), [Agent SDK features](https://code.claude.com/docs/en/agent-sdk/claude-code-features), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Codex non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode), [OpenCode server](https://opencode.ai/docs/server/), [OpenCode SDK](https://opencode.ai/docs/sdk/).

### Claude: use the SDK path, and know which isolation switches work under a subscription

`--bare` is the cleanest Claude worker mode. It skips hooks, skills, plugins, MCP, auto memory and CLAUDE.md, leaving only Bash, read and edit, and the docs say it "will become the default for `-p`". But **bare mode never reads OAuth credentials**, so it requires an API key ([headless](https://code.claude.com/docs/en/headless)).

Under your Claude subscription, isolate workers another way. Use the SDK's `settingSources: []`, which by default would load CLAUDE.md, skills, agents, commands and hooks, together with the switches that `settingSources` does not cover: auto memory, `~/.claude.json` (moved via `CLAUDE_CONFIG_DIR`), and claude.ai connectors. Note that **`mcpServers: {}` does not suppress claude.ai connectors** ([SDK features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)). This also closes a supply-chain hole. Without `--bare`, a `-p` run executes the project's `.claude/settings.json` hooks and `.mcp.json` servers even in untrusted folders, with no trust dialog. For keeping the prefix stable, `--exclude-dynamic-system-prompt-sections` and a `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker in a custom prompt make the static prefix cacheable ([CLI reference](https://code.claude.com/docs/en/cli-reference)).

### Codex: app-server for lanes, and keep the sub-agent guard

`codex app-server` provides one process with many threads, `turn/steer` for corrections mid-turn, `turn/interrupt`, per-turn `outputSchema` and `thread/fork`. OpenAI positions it for "deep integration inside your own product" ([app-server](https://learn.chatgpt.com/docs/app-server)). That fits a long-lived frontend lane. `codex exec --json --output-schema … --ignore-user-config` plus `exec resume <id>` remains the simpler fallback. Keep orch's abort guard for Codex `spawn_agent`/`collab_tool_call`. A review once stalled for 71 minutes waiting on Codex's own sub-agents ([codex.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/adapters/codex.ts)).

### OpenCode: a warm server, fresh sessions, and `noReply` to preload briefs

Run one `opencode serve` per repo. For each small task, create a session and preload the brief with `noReply: true`, which injects context without paying for a reply. Send the prompt with an explicit `model` and `agent`, and read only `structured_output`. `prompt_async` plus the `/event` SSE stream lets the engine fan out cheap tasks without blocking ([OpenCode SDK](https://opencode.ai/docs/sdk/)). Port orch's per-run permission map as it is: bash denied by default, an allowlist of git/rg/ls commands and the verify argv, and push and webfetch denied ([opencode.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/adapters/opencode.ts)).

**ACP** (Zed's Agent Client Protocol) is now spoken by Claude (via the Apache-2.0 `claude-agent-acp`), OpenCode (`opencode acp`), Codex (through an adapter), Gemini and Cursor. It is the obvious later route to a single client codepath. Schema-constrained output is not clearly part of ACP, though, so start with the native surfaces ([ACP agents](https://agentclientprotocol.com/overview/agents); [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)). On Windows, pass briefs and schemas as files (`--append-system-prompt-file`, `--output-schema <path>`) to avoid quoting bugs. Use SDK interrupt, `turn/interrupt` or `abort` rather than signals, since Claude exits 143 on SIGTERM mid-turn.

### Licensing decides whether the app can ever leave your machine

Anthropic's terms say OAuth subscription login is "designed to support ordinary use of Claude Code and other native Anthropic applications". Developers building products, including with the Agent SDK, "should use API key authentication" and may not "route requests through Free, Pro, or Max plan credentials on behalf of their users". The terms do **not** prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". They also note that advertised limits "assume ordinary, individual usage", with enforcement possible "without prior notice" ([Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)).

For a personal tool that drives your own unmodified `claude` binary, the wording appears to permit what you are doing. But no official statement addresses heavy personal scripting of `-p`, so treat it as unconfirmed. If you ever distribute the app, each user must either bring an API key or sign into the unmodified binary themselves. The app must never hold or intermediate their claude.ai credentials. I found no OpenAI statement either way on automating ChatGPT-login Codex from a third-party orchestrator.

## Briefs in, short results out, budgets enforced in code

### The handoff format replaces exploration with pointers

Every message from orchestrator to worker should be a brief of **about 2k tokens or less** that names its files instead of inlining them. pstack's delegation rule is "file pointers not inlined context" ([poteto-mode](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md)). mattpocock's `triage/AGENT-BRIEF.md` is a ready template for the content ([mattpocock/skills](https://github.com/mattpocock/skills)). Anthropic's guidance on the return path: subagents may spend "tens of thousands of tokens" but return "a condensed, distilled summary… often 1,000–2,000 tokens" ([context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). A workable pair:

```yaml
# brief (rendered by engine; target <= 2k tokens)
ticket: T-142  lane: backend  model: claude-sonnet-5-5  effort: medium
goal: "Add idempotency key to POST /orders"
done_when: ["tests/orders.idempotency.test.ts passes", "no change outside write_scope"]
write_scope: ["src/orders/**", "tests/orders*"]
read_first: ["src/orders/service.ts:40-120", "docs/adr/0007-idempotency.md"]
facts: ["orders use Postgres advisory locks (#118)"]      # from facts table, path-filtered
verify: "npm run test:focused -- orders"                   # output filtered by wrapper
skills: ["/abs/path/skills/implementer/tdd/SKILL.md"]      # 0-2, routed by orchestrator
budget: {max_turns: 30, max_effective_tokens: 400000}
return: result.schema.json
```

```json
{"status":"done|blocked|failed","summary":"<=150 words","files_changed":["..."],
 "tests":{"command":"...","passed":true,"failures":[]},"decisions":["..."],
 "open_questions":["..."],"followups":["..."],"session_id":"..."}
```

The `verify` wrapper matters as much as the brief. The Claude Code docs show a hook that pipes test runs through `grep -A 5 -E '(FAIL|ERROR|error:)' | head -100`, cutting context "from tens of thousands of tokens to hundreds" ([Claude Code costs](https://code.claude.com/docs/en/costs)). The engine should run every verify command through such a wrapper, whatever the harness. Add a repo-map or "codebase-overview" skill and LSP tools, which the same docs recommend for avoiding exploratory reads.

### Review once per ticket, diff-only, and cap it at two rounds

Cognition's strongest multi-agent pattern is a reviewer that "deliberately gets only the diff and no prior context". Devin Review averages two bugs per PR, 58% of them severe ([ZenML summary](https://www.zenml.io/llmops-database/multi-agent-systems-in-production-code-generation-and-review-at-scale)). Keep orch's review contract: a read-only reviewer, judgment against a Definition of Done, a JSON verdict bound to the head SHA, and non-blocking items routed to `followups` ([review-run.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/board/review-run.ts)). Change three things:

- **Review timing.** Review only at the ticket's final head, not after every push. If a rebase resolves without semantic conflict, re-run the tests rather than the reviewer. This rule is my inference, not something I measured.
- **Round cap.** **Cap review at two rounds**, then escalate to the orchestrator's decision mode. That is the postmortem's fix, and it also bounds the 6–7-review spirals seen on #91 and #92.
- **Reviewer choice by author.** Codex-authored frontend gets a Claude reviewer, which keeps orch's cross-model check. Claude-authored backend gets a fresh-context Claude reviewer, plus an optional read-only Codex review for tickets labelled high-risk. OpenCode small tasks pass on tests plus the scope guard, and get one combined-diff review per batch of small tasks.

### Enforce budgets in code, in cache-weighted units

Self-prediction is useless as a control: models' estimates of their own token use correlate at most **0.39** with actual usage ([arXiv 2604.22750](https://arxiv.org/html/2604.22750v3)). So every limit must sit in the engine. Count budget in **effective tokens**: uncached input, cache writes at 1.25x (5-minute TTL) or 2x (1-hour TTL), cache reads at the model's read rate, and output. Raw sums overstated one subagent's cost about 8x ([rulestack](https://dev.to/rulestack/we-said-a-claude-code-subagent-costs-436k-tokens-a-cleaner-measurement-says-54k-here-is-what-37am)).

Set per-class budgets from the ledger's medians. **Interrupt or escalate any run that passes 2–3x its class median**, since expensive runs correlate with failure. Use each harness's native hook: Claude's `--max-budget-usd`/`--max-turns`, Codex `turn.completed` usage followed by `turn/interrupt`, OpenCode `abort`. Add global caps on dispatches per epic and on concurrency. The postmortem used 25 and 5. Your old `maxConcurrent: 2` is a sensible start.

Reuse orch's `telemetry.ts`, `pricing.ts`, `usage-limit.ts` and `availability.json` cascade for the ledger and for quota windows. Add the field the old `RunRecord` lacked, `cachedInputTokens`, and track the **cache-hit rate per lane**. A falling rate means the prefix is unstable or idle gaps exceed the TTL ([telemetry.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/board/telemetry.ts)).

## Fifteen skills, routed by the orchestrator rather than discovered by workers

Skill descriptions are cheap. mattpocock's plugin exposes only its 11 model-invoked skills, about **570 tokens** in total, and pstack hides all but one of its 56 skills. The real costs are elsewhere:

- **Invoked bodies persist.** Claude Code keeps "rendered SKILL.md content… across later turns" ([Claude Code skills](https://code.claude.com/docs/en/skills)).
- **Large router skills are expensive once loaded.** pstack's `poteto-mode` is about 5k tokens, and `ask-matt` and `wayfinder` are around 3k each.
- **Always-on injectors bypass progressive disclosure.** superpowers uses a SessionStart hook that injects about 800 tokens every session ([superpowers hooks](https://github.com/obra/superpowers/tree/main/hooks)).
- **Wrong-skill invocations happen when descriptions overlap.** For example, both sets ship a `tdd` skill.

Your current Claude workers also list about 40 unrelated personal skills, including academic research, pob2 and artifacts, that a coding worker should never see.

The strategy is therefore **vendor, isolate, route**:

1. **Vendor.** Copy the chosen skills into the app under `skills/<role>/<name>/` with MIT attribution. Pin mattpocock at `5beb35b` (v1.3.1) and pstack at `190d287` (v0.15.29), and diff on every update. Both move fast: mattpocock added and removed skills between v1.2.3 and v1.3.1 in about two months ([CHANGELOG](https://github.com/mattpocock/skills/blob/main/CHANGELOG.md)).
2. **Use one canonical format.** Each skill gets a spec-compliant SKILL.md ([agentskills.io](https://agentskills.io/specification)), with `disable-model-invocation` for Claude, `agents/openai.yaml` `allow_implicit_invocation` for Codex, and `metadata.opencode/autoinvoke` for OpenCode. mattpocock's dual-frontmatter layout is the template.
3. **Isolate.** Workers see only their role's directory.
4. **Route.** The orchestrator classifies the task, picks 0–2 skills, and either inlines a body under about 2k tokens or puts an absolute path with "read before work" into the brief.

Routing by path behaves the same in all three harnesses. It avoids each harness's listing budget: Codex caps its list at 2% of context or 8,000 characters ([Codex skills](https://learn.chatgpt.com/docs/build-skills)). It also avoids Claude Code's refusal to preload `disable-model-invocation` skills into subagents ([sub-agents](https://code.claude.com/docs/en/sub-agents)). pstack's own Claude adapter does the same thing ("`Read` `<pstack>/skills/<name>/SKILL.md`… The `Skill` tool refuses most pstack skills", [claude-code.md](https://github.com/cursor/plugins/blob/main/pstack/docs/harness/claude-code.md)).

| Role (lane) | Visible, model-invoked (≤ 3) | Hidden library, injected by path | Source |
|---|---|---|---|
| Orchestrator, planning | grilling, domain-modeling | to-spec, to-tickets (re-pointed at the SQLite tracker), architect, AGENT-BRIEF template, handoff, show-me-your-work, guard-the-context-window | mattpocock, pstack |
| Implementer (Codex frontend, Claude backend) | tdd (mattpocock's) | "implementer principles" digest (model-the-domain, boundary-discipline, type-system-discipline, laziness-protocol), typescript-best-practices, pr | both |
| Reviewer | code-review, rewritten as a single pass | blast-radius, prove-it-works, test-behavior-not-implementation; interrogate rubric for high-risk escalation only | both |
| Debugger / fix | diagnosing-bugs | fix-root-causes, attack-the-premise, explain-the-number, benchmark-checklist | both |
| Small tasks (OpenCode) | none | none; the brief is the whole instruction | — |

Sources: [mattpocock/skills](https://github.com/mattpocock/skills), [pstack](https://github.com/cursor/plugins/tree/main/pstack).

Several deliberate exclusions protect the token budget:

- **mattpocock's `implement-spec`** runs implementer subagents in worktrees across a task graph ([CHANGELOG 1.3.0](https://github.com/mattpocock/skills/blob/main/CHANGELOG.md)). **pstack's `swarm` and `arena`** do similar fan-out. Inside a worker, these would rebuild the fan-out that the engine is supposed to control.
- **mattpocock's `code-review` fans out to two parallel sub-agents.** Rewrite its Standards-versus-Spec axes as one pass for the reviewer lane.
- **`poteto-mode` as a whole** is too large to serve as a worker preamble. Borrow its router-plus-hidden-leaf pattern, not the file.
- **Human-facing skills stay out:** teach, wait-what, bro, ketchup, sharpen.
- **Cursor-only skills stay out:** benny, make-bot-ui, setup-pstack.
- **superpowers' session-start injection never goes into workers.**

Resolve each overlap once. Ship mattpocock's test-first `tdd` for features and fold pstack's conditional `tdd` guidance into the debugger digest. Use one review entry point.

Neither set covers security, CI fixing or PR-comment handling. OpenAI's curated `security-threat-model`, `gh-fix-ci` and `gh-address-comments` fill those gaps, but `openai/skills` is now deprecated in favour of `openai/plugins`, so pull from the current location ([openai/skills](https://github.com/openai/skills)). Enforce the budget in CI. Fail the build when a role's visible description total exceeds about 1.5k characters or any SKILL.md exceeds about 5k tokens, and evaluate a skill on real tickets before promoting it.

## Extend 1DevTool's surface, own the engine

### 1DevTool already solves the shell, not the token problem

1DevTool is a proprietary $29 Electron app ([1devtool.com](https://1devtool.com/)). On this machine it has detected `claude` 2.1.285 and `codex` 0.160.1. It wraps about 19 CLIs in tmux-backed PTY terminals, alongside a browser, a DB client, an HTTP client and git. Its local delegation CLI already implements much of the coordination vocabulary you want:

- **Team manifests** with idempotent `--submission-id` retries.
- **Bounded peer reads** (`link peek --changed-since`, `link read --lines=40`, `notes`), so peers never trade transcripts.
- A **category→agent routing table**.
- **AgentVC path claims.**
- A **tasks MCP** with plan/question/done gates and `baseHash` concurrency.
- **Quota lanes per account.**

Sources: local [1devtool-orchestrator SKILL.md](file:///C:/Users/Hung/.claude/skills/1devtool-orchestrator/SKILL.md), [1devtool-tasks SKILL.md](file:///C:/Users/Hung/.claude/skills/1devtool-tasks/SKILL.md), [changelog](https://1devtool.com/changelog).

What I did *not* find is the part your problem needs. A grep of its delegation bundle found **turn budgets and swarm pool sizes, but no per-delegation token or dollar caps**. It **injects each CLI's permission-bypass flag itself** (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`). Headless output is capped at about 100k characters. Spend is computed afterwards by parsing CLI transcripts. Whether its headless runs strip your global Claude and Codex config is unknown: the main bundle is packed in `app.asar` and the app was not running during research.

### Build the engine, host it in 1DevTool, and postpone the desktop shell

So the honest answer on build versus extend is that the hard, valuable part is the engine. 1DevTool does not do it, and you cannot modify 1DevTool. Rebuilding its terminals, browser and DB client would duplicate what you already paid for. Build the engine as a **TypeScript headless service with a CLI and an MCP server**, reusing orch's code. Run your Opus planning session as a Claude Code session in a 1DevTool terminal with the engine's MCP attached. The engine drives the worker CLIs directly rather than through `1devtool-agent`, because that is the only way to keep config isolation and budget hooks under your control. It can optionally mirror tickets onto 1DevTool's task board for visibility. orch's existing single-file dashboard (`public/index.html` plus `server.ts`) covers the ledger and board views in the meantime.

There is a reasonable case for a full app: control over the UX, and less exposure to a proprietary dependency in a market that churns. Vibe Kanban's company shut down in April 2026, Opcode is unmaintained, and Terragon's cloud agents are gone ([dev.to roundup](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8)). The engine-first design handles that risk, because 1DevTool is only a host and can be swapped out. If you later need your own shell, for distribution or because 1DevTool's constraints start to bite, **fork Emdash** (Apache-2.0, TypeScript, local SQLite, per-CLI lifecycle hooks, cross-platform) rather than starting from nothing. **Orchestrator.inc** (Apache-2.0) is the closest architectural match, with a persistent project orchestrator, worker sessions, a fact-derived Kanban and CI/review "reactions" routed back to the owning agent. Its Go stack fits poorly with orch's TypeScript, so borrow its design ([Orchestrator.inc](https://github.com/OrchestratorInc/agent-orchestrator); [Emdash](https://github.com/generalaction/emdash)).

### What to carry over from orch, and what to drop

| Keep as-is | Adapt | Replace |
|---|---|---|
| `adapters/*` argv builders, stream reducers, session-ID capture, Codex sub-agent guard; `spawn.ts` (Windows `.cmd` shims, process-tree kill, PWD isolation); `environment.ts` credential scrubbing; `telemetry.ts`, `pricing.ts`, `usage-limit.ts`, availability/cascade; `worktree.ts`, `lock.ts`; `scope-guard.ts`, `budget.ts`; the `decideStep` pure-table pattern; the 94-file test suite | `brief-render.ts` (shrink to the brief above); `review-run.ts` (diff-only, final head, 2 rounds); fix path in `step-exec.ts` (compact packet, ceiling-gated resume); observe gate (once per ticket, optional); dashboard | GitHub Issues/labels as the DB and `reconcile.ts`; AGENTS.md as a fact log; fresh conflict resolvers; implicit inheritance of global harness config; review on every pushed head |

Sources: [orch adapters](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/adapters/), [spawn.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/util/spawn.ts), [environment.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/util/environment.ts), [steps.ts](file:///C:/Users/Hung/Documents/projects/harness_orchestrator-studio/src/tasks/steps.ts).

### What to borrow from other tools, by license

Licenses decide what you can take from each:

- **Apache-2.0 or MIT, so code can be reused with attribution:** Orchestrator.inc, Emdash, Gas Town, Ruflo, ACP and `claude-agent-acp`, plus mattpocock/skills and pstack.
- **Source-available but restricted, so borrow designs only:**
  - **oh-my-opencode**'s category→model routing. Its Sustainable Use License limits use to internal or non-commercial purposes.
  - **Superset**'s MCP/SDK control surface. The Elastic License 2.0 forbids offering it as a managed service.
- **AGPL-3.0, so keep its code out unless you accept copyleft:** Claude Squad.
- **Proprietary, so imitate interaction patterns only:** 1DevTool's manifests, bounded peeks and gates.

## Five phases, each gated on measured tokens

The targets below are my recommendations, derived from the baseline above. They are not measured results. Each phase must hit its gate on a studio-like workload before the next one starts. Phase 0 deliberately changes the *old* repo. If three cheap fixes recover a large share of the waste, that confirms the diagnosis before you rewrite anything.

| Phase | Scope | Token gate (baseline: 2.65M tokens/issue, 2.9 spawns/issue) |
|---|---|---|
| 0 (≈1 week) | In orch: lean worker profiles (Claude SDK/flags, `--ignore-user-config`), per-ticket facts out of AGENTS.md and the file trimmed to ≤200 lines, filtered verify output, `cachedInputTokens` in `RunRecord` | Claude spawn preamble ≤10k (from `system/init`); ≤1 conflict-resolve per 10 issues; ≤1.5M/issue |
| 1 | Engine core: SQLite store, ported adapters, brief/result schemas, effective-token ledger, code-enforced budgets, single final-head review capped at 2 rounds | ≤1M/issue median; ≤2.2 spawns/issue; every run above 3x class median interrupted |
| 2 | Lanes: Codex app-server, Claude SDK streaming, OpenCode serve; ceiling-gated resume and compact fix packets; small-task routing with escalate-on-test-failure | Fix rounds ≤300k median; ≥90% cache-hit in lane sessions; ≥30% of tickets on the OpenCode lane; ≤700k/issue |
| 3 | Orchestrator agent: Opus planning session, decision-mode calls on ≤5k digests; vendored skills with orchestrator routing and the CI size check | Orchestrator ≤10% of total tokens; ≤500k/issue |
| 4 | Surface: engine MCP inside 1DevTool, dashboard; decide on an Emdash fork; optional ACP client | No regression against Phase 3 |

The ≤500k end state is plausible, not proven. The same harnesses averaged about **229k tokens per issue on the small sandbox repo**, and OpenCode tickets cost 15k each there. The remaining uncertainty is how far briefs, facts and filtered output can close the gap between a toy repo and a 17.5k-line codebase. No published study measures "batched lane sessions versus spawn-per-ticket" directly, so Phase 2 doubles as that experiment.

## Conclusion

The intuitive fix for "an agent per ticket burns tokens" is a smarter coordinator. Your own telemetry shows the wrong layer would get the attention. The orchestration pattern cost about 4% of the waste; the context each worker gathered and replayed cost most of the rest. That changes the design priority. **The orchestrator agent is the component most likely to recreate the problem, so it must be the smallest and most constrained part of the system.** Its job is to decide; the engine's job is to make every worker read less. On subscription plans, the engine's job is also to treat tokens as capacity: a 5-hour window spent on preamble and replay is lost work, even when the dollar figure looks small.

The broader implication is that most token savings here come from discipline, not topology: stable prefixes, path-filtered facts, filtered output, explicit models, caps enforced in code, and skills that are routed rather than ambiently loaded. All of these work in any shell, which is why the engine can live inside 1DevTool now and move later. Your 1DevTool routing table already expresses category routing. What it lacks is enforcement, and enforcement is what your new app should add.
