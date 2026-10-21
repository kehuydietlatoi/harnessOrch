# 1DevTool and the multi-CLI-agent orchestration landscape (as of 2026-10-21)

Source tags: "LOCAL" means I inspected the 1DevTool install on this machine read-only (v10 CLI shim, auto-managed skills, config key names, CLI `--help`). No secrets were read or printed. The 1DevTool app was not running, so its MCP tools that need the live app (for example `orchestration_explain`) could not be called.

Local paths referenced:
- Skills: `C:\Users\Hung\.claude\skills\1devtool-orchestrator\SKILL.md` (v41, auto-managed), `C:\Users\Hung\.claude\skills\1devtool-tasks\SKILL.md` (v3)
- CLI shim: `C:\Users\Hung\.1devtool\bin\1devtool-agent-v10.cmd`. It runs `"C:\Program Files\1DevTool\1DevTool.exe"` with `ELECTRON_RUN_AS_NODE=1` against `resources\app.asar.unpacked\dist\cli\1devtool-agent.cjs`, a single bundled CJS file of about 394 KB.
- App data: `%APPDATA%\1devtool\` (`1devtool.json`, `cli-registry.json`, `ai-usage-cache.json`, `tasks\decompose-runs.json`, `agent-changes\`, `hooks-management\`, `mcp-activity.json`, `prompt-history.db`) and `~\.1devtool\` (`ai-pool\epoch-ledger.jsonl`, `orchestration\native-hooks\codex-notify.cjs`, `orchestration\runtime\sessions.json`, `state\cli-registry.json`)
- Updater: `resources\app-update.yml` points to GitHub `stoicsoft/1devtool-releases`. The app also ships `one-devtool-sidecar.exe`.

---

## Q1. What is 1DevTool, and how does its orchestration work?

### Takeaway
1DevTool is a proprietary Electron desktop app from StoicSoft. It costs $29 one-time, with no subscription. It wraps about 19 installed coding-agent CLIs in real PTY terminals, alongside a browser, a DB client, an HTTP client and git. On top of that sit two orchestration layers:
- **App-level layer:** a "Builder" with hierarchy and pipeline org charts, a category→agent routing table, Agent Teams/Swarms, a Markdown task board with human approval gates, and an Accounts & Quota/spend center.
- **Agent-level layer:** an auto-installed skill that teaches any agent (for example Claude Code) to delegate by piping prompts to the `1devtool-agent` CLI, which runs headless or in visible terminals. A `onedevtool` MCP server exposes tasks, browser, DB, HTTP and orchestration-chart tools.

Cost control covers quota and spend visibility, account pools, turn and worker budgets, and per-category model routing. I found no evidence of hard dollar or token caps per delegation.

### Cited Findings

**Product, pricing, platforms (official site)**
- It is described as a unified workspace for running "a team of coding agents" in parallel. It bundles terminals, code editor, browser, DB client (23 SQL/NoSQL engines), HTTP client, and a git client with visual diff, commit, push and worktree support, plus MCP integration. — [1devtool.com](https://1devtool.com/)
- Orchestration features listed on the site: "org charts and pipelines", agent hierarchies with "chain-of-command enforcement", "fallback chains with automatic failover to backup agents", and "Agent Teams & Swarms". — [1devtool.com](https://1devtool.com/)
- Tasks: a Markdown task board stored with the repo, approval gates for implementation and closure, and AI task assignment and decomposition. — [1devtool.com](https://1devtool.com/)
- Sessions persist across app restarts via tmux. You can resume past AI conversations, and a "Conversation mode" shows terminal output as chat. A phone remote pairs by QR over LAN or Cloudflare Tunnel. — [1devtool.com](https://1devtool.com/)
- Pricing:
  - Free: 1 project, 4 terminals, 1 browser tab, 5 AI diffs/day.
  - Pro: $29 one-time.
  - Multi-device: $59 (3 devices) or $89 (5 devices).
  - Terms: "No subscription ever", 7-day refund, 1 year of updates. Users bring their own AI subscriptions with no markup.
  - Source: [1devtool.com](https://1devtool.com/)
- Platforms: macOS (Apple Silicon and Intel), Windows 10/11, Linux (AppImage and .deb). Proprietary, made by StoicSoft. — [1devtool.com](https://1devtool.com/)
- Cost features: a "Spend & Quota Center", per-agent spend tracking, "account pools", a usage pill in the status bar showing remaining quota, and an activity audit log. — [1devtool.com](https://1devtool.com/)
- Release cadence is roughly weekly:
  - v1.81.0 (2026-10-19) added an orchestration "Activity tab" with filters All / Needs you / Links / Teams / Runs, plus an "Auto-approve agent link requests" switch that is on by default.
  - v1.78.0 (2026-10-13) added "Conversations Across Computers" between agents on paired machines, with turn budgets and offline queuing.
  - v1.77.0 added "Accounts & Quota", with "one lane per account" across Claude, Codex, Gemini and others.
  - v1.76.9 added handoff of a project to a VPS running as a systemd unit.
  - Source: [1devtool.com/changelog](https://1devtool.com/changelog)
- The homepage text references v1.71.0, which is older than the changelog's v1.81.0. Treat homepage feature lists as possibly lagging. — [1devtool.com](https://1devtool.com/); [changelog](https://1devtool.com/changelog)

**Supported agent CLIs (LOCAL)**
- The CLI accepts `--to=`: claude, codex, gemini, kimi, agy (Antigravity), cline, amp, opencode, kilocode, qwen, grok, hermes, cursor, pi, omp (Oh My Pi), commandcode, kiro, devin, aider. Custom CLIs can be registered (`customClis` in `cli-registry.json`). — LOCAL `1devtool-orchestrator/SKILL.md`, `%APPDATA%\1devtool\cli-registry.json`
- On this machine it detected `claude` 2.1.285 and `codex` 0.160.1. Gemini, agy, amp, qwen, kimi, grok and cline were not found. — LOCAL `cli-registry.json`
- The model flag is mapped per CLI: `--model=` gives claude sonnet|opus|haiku; codex `gpt-5.6-sol[:xhigh]` (with a reasoning suffix); opencode `provider/model`. This mapping is the main per-delegation cost lever. — LOCAL SKILL.md
- 1devtool-agent injects each CLI's permission-bypass flag itself. The bundle contains `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--dangerously-allow-all`, and `opencode run`. Agents are told never to pass these flags themselves, because duplicates crash codex. — LOCAL SKILL.md and grep of `1devtool-agent.cjs`

**Delegation CLI (`1devtool-agent`) (LOCAL, from `--help` and SKILL.md)**
- Basic call: `run --to=<agent> --prompt-stdin`. The prompt always goes over stdin; there is no `--prompt` flag, which avoids shell-injection and credential leaks.
  - `--timeout` ranges 5..600 s (default 120). Headless output is capped at about 100,000 characters.
  - `--json` returns an envelope.
  - `--category=<slug>` attributes the run to the routing table. The write categories implement|test|debug auto-provision a dedicated git worktree under `--terminal`, unless `--shared-cwd` is passed.
- Two substrates:
  - **Headless:** blocking one-shot. Uses `claude -p` / `codex exec` / `opencode run` style.
  - **`--terminal [--wait]`:** a visible, persistent 1DevTool agent terminal. Required when the work needs slash skills, plugin/MCP tools, user approvals or live steering.
  - The rule is "capability first… must never be silently downgraded".
- Five topologies are taught to the orchestrating agent:
  - **Team:** independent subtasks that the host integrates.
  - **Swarm:** one brief, N≥3 bounded parallel explorers.
  - **Pipeline:** fixed sequence with quality gates. Live-terminal only.
  - **Mesh:** 3–8 peers iterating on one artifact over terminal links.
  - **Hierarchy:** managers pass tasks down and summarize up.
  - The skill explicitly says "Do not over-orchestrate: one agent with tools is usually enough."
- **Team transaction:** `team start --manifest-stdin` takes JSON `{clientRequestId, members:[{role,target,prompt,substrate}]}`.
  - It returns a `teamId`, plus a `memberId` and an immutable `runId` per prompt.
  - `collect --run=` is pollable.
  - Follow-ups use `send --team --member --submission-id=<uuid>`, which is idempotent so retries cannot double-submit.
  - There are also `team status|members|peers|read|screen|notes|peek|ask|reply|messages|recover`.
- **Swarm:** `swarm start` with `{brief,count,targets,poolSize,budget,substrate,sandbox}`. Headless swarm workers must be sandbox-capable CLIs (codex, claude, cursor only). Results are collected with paginated `collect --swarm=`, and there is pause/resume.
- **Terminal links:** a peer-to-peer graph with explicit permissions: send, ask, share-artifact, read-transcript[-full], read-screen, read-artifact.
  - `link read --lines=40`, `link peek --changed-since=<cursor>` (cheap progress check) and `link notes`/`publish` give bounded context pulls, so peers do not have to share full transcripts. This is a token-saving design.
  - Delivery receipts are `delivered` vs `delivery-unconfirmed`. The app never retries automatically.
  - Over confirm-mode links, messages get a "queued (confirmation-required)" exit code 3 and wait for the human to approve each one.
- **Hierarchy and pipeline primitives:**
  - `report` / `handoff --prompt-stdin [--continue=<id>] [--blocked]` reports upward or does a typed forward handoff with bounded gate escalation.
  - `link broadcast --vote --quorum` and `link vote` support decisions.
- **AgentVC (shared working tree without worktrees):** `vc intent`, `vc claim --path --mode=advisory|exclusive`, `vc read --if-changed`, `vc write --candidate-stdin`, `vc run --command-stdin` (serializes shared git/install/test/build), `vc brief` (re-orientation after handoff or compaction), and `vc divergence`/`resolve`. Modes are Off / Watch / Guide / Protect.
- **Raw terminal control:** `onedevtool terminal list|view|submit|status|close`. Submit is keystroke injection into a ready composer and returns exit 3 if the agent looked busy.
- **Workspace (multi-project):** `workspace roster|send|broadcast|collect`. Membership never creates a link.
- **Recovery:** `resolve --run --outcome=done|error|cancelled` re-reads the correlated transcript, and `confirm-submit`. Run results are recovered by correlating with the target CLI's own transcript.

**Routing table (LOCAL, `%APPDATA%\1devtool\1devtool.json` → `preferences.orchestration`)**
- The user's applied policy maps categories to agents: plan→opencode, implement→codex, test→codex, review→claude, browser→codex, docs→codex, research→opencode, debug→codex.
- The policy also sets `mode: "on-generic-delegate"`, `defaultSubstrate: "auto"`, `customCategories`, and a draft/applied split with `appliedPolicyHash`.
- This is a static category→agent router. The orchestrating agent picks a category and the app picks the agent.

**MCP server `onedevtool` (LOCAL, tool list and schemas)**
- **Tasks:** `tasks_next/get/list/create/update/comment/link/complete/request_approval/wait`.
  - `tasks_create` makes tasks unassigned; "a human decides who works on it". No tool assigns tasks, so agents "do not pick [their] own work".
  - `tasks_update` uses `baseHash` optimistic concurrency.
  - Statuses: backlog/ready/in_progress/blocked/in_review/done/cancelled. Priorities p0–p3. `blockedBy` forms a dependency graph with cycles rejected.
  - Approval gates have kinds plan/question/done and return a `gateId`. `tasks_wait` returns open/resolved(approved|changes-requested|declined)/timeout/stale, and "Silence is not approval".
  - Assignee, gates and runs are app-owned, so editing the Markdown task file has no effect on them.
  - Source: LOCAL `1devtool-tasks/SKILL.md`
- **Orchestration chart tools:** `orchestration_explain` (read-only summary plus mermaid), `orchestration_recommend` (picks among hierarchy | pipeline | router | ephemeral-team | none), `orchestration_propose_chart` (mermaid→draft, compare-and-swap on `basePolicyHash/baseRevision`), and `orchestration_chart_op` (add_seat | connect | insert_stage | set_agent | reorder_stages).
  - Agents can only edit a draft. The tools "Never Applies, Activates, or Starts a team", so a human applies it.
- **Dev tools:** browser_* (navigate, click, type, snapshot, screenshot, console logs, tabs), DB (`list_connections`, `describe_schema`, `preview_table`, `query`), and HTTP (`request`, `list_saved_requests`, `run_saved_request`, `list_environments`). — LOCAL tool list
- **Usage tracking:** `ai-usage-cache.json` indexes each CLI's own transcript files (for example `~/.claude/projects/*.jsonl`) and holds per-message token counts, model and request id. Spend is therefore computed by parsing CLI transcripts after the fact, not by intercepting the API. `ai-pool/epoch-ledger.jsonl` records detected accounts per agent (account pools). — LOCAL
- **Hooks:** `orchestration/native-hooks/codex-notify.cjs` registers a Codex notify hook used for completion detection. A `hooks-management` dir exists. — LOCAL
- **Budgets:** I found only *turn budgets* (`turnsUsed`/`turnBudget` for cross-computer conversations) and the swarm `budget`/`count`/`poolSize`. A grep found no dollar or token budget fields in the delegation CLI. — LOCAL grep of `1devtool-agent.cjs`

### Inferences
- The architecture is: Electron UI → PTY terminal per agent (tmux-backed persistence) → per-CLI adapters that know each CLI's headless flag, model flag, permission-bypass flag and transcript location → a local IPC/HTTP control plane used by the CLI shim and the MCP server.
  - The orchestrator is not a separate model. It is whichever agent the user talks to, taught by an injected SKILL.md to call a CLI.
  - This is the closest existing match to what the user wants to build.
- Handoff mechanisms:
  1. Headless one-shot run, whose stdout result returns to the caller.
  2. A visible terminal run whose result is correlated from the target's transcript.
  3. Keystroke injection into a live terminal (`link send`/`terminal submit`) with acknowledgement tracking.
  4. Durable task records with gates.
  5. Bounded "notes"/peek reads, so peers never share full context.
- Token control is mostly *structural*: cheap agents chosen per category, bounded reads instead of full transcripts, a swarm budget and pool size, an "don't over-orchestrate" instruction, and an approval gate before costly implementation. Monitoring is post-hoc via transcript parsing. A hard per-run token or $ ceiling appears absent; this is unverified, since the main app bundle is packed in app.asar and was not inspected.
- The safety posture is notable: permission-bypass flags are auto-injected for delegated runs, so isolation relies on worktrees, CLI sandboxes (swarm), and AgentVC claims.

### Gaps
- The Builder UI semantics (seats, fallback chains, router topology) and Spend & Quota internals live in the packed `app.asar`. They were not inspected and the app was not running. No public docs page on the orchestration chart schema was found.
- I found no independent reviews or HN/Reddit discussion of 1DevTool. Searches returned unrelated tools, so user sentiment about it is unknown.
- I could not determine whether "fallback chains" fail over on rate-limit or quota errors (likely, given account pools) or on general errors.

---

## Q2. Comparable tools: how they orchestrate, hand off work, and control cost

### Takeaway
Most of the field is "conductor-shaped": one worktree plus one terminal per task, and a human doing assignment and review (Conductor, Claude Squad, Emdash, Superset, Nimbalyst, Vibe Kanban, Cursor's agents window). Fewer tools ship a true orchestrator agent that plans and delegates:
- Orchestrator.inc, formerly Composio Agent Orchestrator
- oh-my-opencode / OmO (Sisyphus)
- Ruflo / claude-flow
- Gas Town
- Claude Code Agent Teams
- Superset (via MCP/SDK)
- 1DevTool

Only oh-my-opencode does explicit cheap-model routing by task category in the way the user wants. Cost control elsewhere is mostly absent or limited to a dashboard.

### Cited Findings

**Orchestrator-agent tools (closest to the user's goal)**
- **Orchestrator.inc** (formerly Composio Agent Orchestrator; repo now `OrchestratorInc/agent-orchestrator`)
  - Apache-2.0, Go, about 13.4k stars, active on 2026-10-21. It is a desktop app with a local daemon.
  - A "worker" is one task, one agent, one worktree. A persistent "project orchestrator" agent plans, "break[s] it into focused tasks, spawn[s] or redirect[s] workers, pass[es] each worker the relevant context".
  - A live Kanban derives card state from session, PR, CI and review facts (Working / Needs you / In review / Ready to merge).
  - "Return actionable failures or review comments to the agent that owns the work."
  - Supports 30+ agents. Platforms: macOS, Windows, Linux.
  - Sources: [GitHub README](https://github.com/OrchestratorInc/agent-orchestrator); GitHub API
  - Earlier versions: `ao spawn <project> <issue>` creates a worktree, branch and tmux session, then launches the agent with issue context. "Reactions" auto-send CI failure logs and review comments back to the agent. Supports Claude Code (default), Codex, Cursor, Aider, OpenCode, KimiCode. — [mintlify docs](https://www.mintlify.com/ComposioHQ/agent-orchestrator); [sourcepulse](https://www.sourcepulse.org/projects/25041975)
  - License conflict: the mintlify/sourcepulse summaries say MIT and about 7.5k stars (June 2026), but GitHub now shows Apache-2.0 and about 13.4k stars. Trust GitHub.
- **oh-my-opencode / "oh-my-openagent" (OmO)**
  - A plugin harness for OpenCode, about 70k stars, TypeScript.
  - The "Sisyphus" orchestrator (default model claude-opus-4-6, per mintlify docs) plans and delegates to 11 specialist agents with distinct roles, default models and tool permissions.
  - Delegation picks a *category* (visual-engineering, deep, quick, ultrabrain) rather than a model, and the category maps to a model. Cheaper models are used for research agents such as librarian and explore. It runs in parallel in the background.
  - Sources: [mintlify agents](https://mintlify.com/code-yeongyu/oh-my-opencode/concepts/agents); [glukhov.org deep dive](https://www.glukhov.org/ai-devtools/opencode/oh-my-opencode-agents/)
  - License: the "Sustainable Use License v1.0". Use is allowed only "for your own internal business purposes or for non-commercial or personal use", and redistribution only free of charge. This is **not** OSI open source, so it is unsuitable to fork into a commercial product. — GitHub `code-yeongyu/oh-my-openagent/LICENSE.md`
- **Ruflo** (formerly claude-flow, `ruvnet/ruflo`)
  - MIT, TypeScript (plus WASM), about 78k stars.
  - A "queen-led" hierarchy with strategic, tactical and adaptive coordinators over 100+ specialized agent types. Mesh, hierarchical and adaptive topologies, memory, federation.
  - It self-claims "75% API cost savings vs Claude Code directly" and an 84.8% SWE-bench solve rate. These are unverified vendor claims.
  - The same guide says token consumption is "significant", and third parties ship `ruflo-cost-tracker` plugins (budgets, alerts) to avoid surprise bills.
  - Sources: [pasqualepillitteri.it guide](https://pasqualepillitteri.it/en/news/774/claude-flow-ruflo-multi-agent-orchestration-guide); [claudepluginhub cost tracker](https://www.claudepluginhub.com/plugins/walterp-ruflo-cost-tracker-plugins-ruflo-cost-tracker); GitHub API
- **Gas Town** (`gastownhall/gastown`, formerly steveyegge/gastown)
  - MIT, Go, about 18.5k stars. "Scales to 20-30 agents with coordinator and merge queue".
  - Sources: [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators); GitHub API
- **Claude Code Agent Teams** (native, experimental)
  - Enabled with `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. A team lead coordinates teammates through TeammateTool.
  - Agent teams use about 7x more tokens than standard sessions when teammates run in plan mode, "because each teammate maintains its own context window and runs as a separate Claude instance".
  - Claude Code averages about $6/dev/day, under $12 for 90% of users. `/cost` and Console workspace spend limits exist.
  - Sources: [Claude Code costs docs](https://docs.anthropic.com/en/docs/claude-code/costs); [codex.danielvaughan.com ecosystem post](https://codex.danielvaughan.com/2026/04/09/claude-multi-agent-ecosystem/)
- **Superset** (`superset-sh/superset`)
  - **Elastic License 2.0** (source-available, not OSI), TypeScript, about 15.4k stars, very active.
  - Worktree per unit of work. A terminal daemon keeps sessions alive across app restarts. Fleet view and per-task diff review.
  - Orchestration is exposed via an **MCP server** ("any MCP-capable agent [can] create workspaces, launch agents, and collect results"), a CLI, and a **TypeScript SDK**, plus cron "Automations".
  - Pricing: free for 1 user, Pro $15/user/mo (yearly), Enterprise custom. Agent-provider usage is billed separately.
  - Sources: [superset.sh/agent-orchestration](https://superset.sh/agent-orchestration); [dev.to 2026-07](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8); GitHub LICENSE.md
  - Conflict: superset.sh says macOS with experimental Linux and Windows unavailable, and lists supported agents as Claude Code/Codex/OpenCode. The dev.to and rustman listings claim cross-platform support and more agents.

**Conductor-style (human assigns, one worktree and terminal per task)**
- **Conductor** (Melty Labs; Series A, $22M)
  - Mac-only (Apple Silicon), closed-source, free for now with paid collaboration planned.
  - Worktree per workspace, strong diff/PR review. Supports Claude Code and Codex; later reports add Cursor and OpenCode.
  - Sources: [rustman 2026-04](https://rustman.org/wiki/conductor-parallel-agents/); [dev.to](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8); [agentsroom search snippet](https://agentsroom.dev/blog/best-multi-agent-coding-tools)
- **Claude Squad** (`smtg-ai/claude-squad`)
  - AGPL-3.0, Go, about 8.6k stars, last push 2026-08-20.
  - tmux plus a worktree per instance in a TUI. Supports Claude Code, Codex, Gemini, OpenCode, Amp, Aider.
  - Sources: GitHub API; [dev.to](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8)
- **Emdash** (`generalaction/emdash`, YC W26)
  - Apache-2.0, TypeScript, about 6k stars, active. macOS, Windows and Linux.
  - Worktree per task. Pulls issues from Linear, GitHub, Jira, GitLab, Asana and others into an agent. Diff, PR, CI and merge in-app. Remote projects over SSH/SFTP. Local SQLite state.
  - Installs "marker-tagged" lifecycle hooks into each agent's user config to track status, notifications and resumable sessions.
  - Supports Claude Code, Codex, Cursor, OpenCode, Amp, Devin, Qwen, Droid, Copilot.
  - Sources: [Emdash README](https://github.com/generalaction/emdash); GitHub API
- **Crystal → Nimbalyst**
  - Crystal (MIT, TypeScript) was renamed Nimbalyst. Nimbalyst is MIT for desktop and iOS.
  - Visual workspace with kanban, worktrees and a native iOS app. Supports Claude Code and Codex; OpenCode and Copilot are alpha. Free for individuals, Teams pricing TBD.
  - Sources: GitHub API; [dev.to](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8)
- **Vibe Kanban** (`BloopAI/vibe-kanban`)
  - Apache-2.0, Rust backend with TS frontend, about 28k stars. Kanban issues lead to workspaces where agents execute, with diff review.
  - The README headline reads "Vibe Kanban is sunsetting". The company shut down on 2026-04-10, the paid cloud ended, and it continues community-maintained.
  - Sources: GitHub README; [dev.to](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8)
- **Agent of Empires** (`agent-of-empires/agent-of-empires`): MIT, Rust, about 3.4k stars. TUI plus web view for phone access; manages Claude Code and OpenCode sessions. — GitHub API
- **agent-deck** (MIT, Go): TUI session manager for Claude, Gemini, OpenCode and Codex. — GitHub API
- **Parallel Code** (MIT, TypeScript): runs Claude, Codex and Gemini side by side, each in its own worktree, for A/B comparison. — GitHub API; [rustman](https://rustman.org/wiki/conductor-parallel-agents/)
- **ccswarm** (MIT, Rust, small): role-specialized Claude Code agents (frontend, backend, review) in worktrees. — GitHub API; [rustman](https://rustman.org/wiki/conductor-parallel-agents/)
- **Sculptor** (Imbue): runs agents in Docker containers with a "pairing mode". Earlier listings call it a proprietary research preview; the GitHub repo `imbue-ai/sculptor` now shows MIT, Python, 240 stars. — [dev.to](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8); GitHub API
- **Mux → "xum"** (`coder/xum`, AGPL-3.0, TypeScript): desktop app for isolated parallel development with its own multi-model agent loop, not a CLI wrapper. — GitHub API; [dev.to](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8)
- **Opcode** (`winfunc/opcode`, AGPL-3.0): Claude Code GUI, "no longer actively developed". — [dev.to](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8)
- **Terragon**: its cloud-VM background agents have shut down. — [agentsroom search snippet](https://agentsroom.dev/blog/best-multi-agent-coding-tools)

**IDE and vendor-native**
- **Cursor**: Cursor 2.0 (October 2025) ran up to 8 parallel agents, each in its own git worktree. Background/cloud agents run in Ubuntu VMs. A February 2026 update and the Cursor 3 "agents window" expanded this. "Every major coding tool shipped multi-agent support in the same two-week window in February-March 2026." — [morphllm](https://www.morphllm.com/parallel-coding-agents); [noqta](https://www.noqta.tn/blog/cursor-3-agents-window-parallel-ai-coding-2026). These are secondary sources; Cursor's own changelog was not checked.
- **Codex**: the CLI plus cloud sandboxes, and a Codex macOS app that manages multiple cloud-sandbox agents. — [morphllm codex-vs-cursor](https://morphllm.com/comparisons/codex-vs-cursor)
- **Google Antigravity "Mission Control"**: a closed, incumbent orchestrator. — [rustman](https://rustman.org/wiki/conductor-parallel-agents/)
- **OpenHands**: MIT, about 91k stars. Self-hostable "control center" that runs on schedules or webhooks; an autonomous task runner rather than a multi-CLI wrapper. — GitHub API; [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- **Zed / ACP**: the Agent Client Protocol (`agentclientprotocol/agent-client-protocol`, Apache-2.0, Rust, about 4.5k stars) is "a protocol for connecting any editor to any agent". It is a structured alternative to PTY scraping for controlling heterogeneous agents. Nuphos is one example of a team workspace "via ACP adapters". — GitHub API; [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)

**Ecosystem breadth**
- The `awesome-agent-orchestrators` list (CC0, about 2.2k stars) catalogs more than 150 tools across these categories: terminal TUIs, desktop/web apps, multi-agent swarms, autonomous loop runners, task runners, and infrastructure. Examples relevant to cost and routing:
  - **Claudexor**: "routes threads across harnesses with quota-aware rotation"
  - **MartinLoop**: "caps spend, enforces policy, verifies output, rolls back"
  - **agent-squid**: "realtime quota gauge"
  - **aGiTrack**: commits each turn to git with prompt and token cost
  - **handoff**: delegates a task to DeepSeek, Codex or Claude from a session
  - **AgentBridge / claude_codex_bridge**: keep Claude Code and Codex as live peers
  - **hcom**: agents message, watch and spawn each other
  - **Concord MCP**: agents claim work
  - Source: [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)

### Inferences
- The closest architectural analogues to the user's plan, in order:
  1. 1DevTool: an orchestrator agent delegating to heterogeneous CLIs via a CLI shim, plus category routing.
  2. Orchestrator.inc: a persistent orchestrator agent, worker sessions and a Kanban, under Apache-2.0, so forkable.
  3. oh-my-opencode: category→model routing with cheap models. A good *design* reference, but its license blocks forking.
  4. Superset: MCP server plus SDK for an orchestrator agent to spawn workspaces. ELv2, so it can be studied but not offered as a hosted competing service.
- Only 1DevTool and oh-my-opencode clearly route by task type to cheaper models or agents. Most worktree managers are agent-agnostic launchers with no notion of cost.

### Gaps
- Fetches of conductor.build/compare (404), agentsroom (413), codeagentswarm and morphllm (429) failed, so Conductor's current agent list and pricing, Warp's agent orchestration, and Terragon details are from snippets or secondary sources only.
- Warp (Agents 3.0 / Oz) and Zed's agent panel were not researched in depth. I found no primary source on their multi-agent orchestration in 2026.
- Superset platform and agent support conflicts between sources (see above).

---

## Q3. Common patterns

### Takeaway
The dominant pattern is one task = one git worktree/branch = one PTY/tmux terminal running an unmodified vendor CLI, plus a diff/PR review surface. Layered on top, in increasing autonomy:
- a kanban or task board
- an orchestrator agent that delegates via CLI, MCP or SDK
- CI and review "reactions"

Human-in-the-loop gates (plan approval, merge review) remain standard. The industry-converged *agent* architecture is a single context-owning orchestrator spawning ephemeral, isolated subagents that return compressed summaries.

### Cited Findings
- **Worktree plus terminal per task** is used by Conductor, Claude Squad, Emdash, Superset, Nimbalyst, Vibe Kanban, Parallel Code, Cursor and Orchestrator.inc. — [rustman](https://rustman.org/wiki/conductor-parallel-agents/); [dev.to](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8); [Orchestrator.inc README](https://github.com/OrchestratorInc/agent-orchestrator)
- **Persistent sessions:**
  - Superset uses a terminal daemon that survives app restarts.
  - 1DevTool uses tmux-backed persistence.
  - Herdr offers "reboot survival".
  - Orchestrator.inc's daemon watches agent and source-control state.
  - Sources: [superset.sh](https://superset.sh/agent-orchestration); [1devtool.com](https://1devtool.com/); [awesome list](https://github.com/andyrewlee/awesome-agent-orchestrators)
- **Status detection via agent lifecycle hooks** installed into each CLI's user config:
  - Emdash installs "marker-tagged entries".
  - 1DevTool installs a Codex `notify` hook (LOCAL `codex-notify.cjs`).
  - Source: [Emdash README](https://github.com/generalaction/emdash)
- **Orchestrator exposing control to agents:**
  - Superset: MCP server, CLI and TS SDK.
  - 1DevTool: `1devtool-agent` CLI plus `onedevtool` MCP.
  - Orchestrator.inc: a project orchestrator agent.
  - Sources: [superset.sh](https://superset.sh/agent-orchestration); LOCAL; [Orchestrator.inc README](https://github.com/OrchestratorInc/agent-orchestrator)
- **One-shot vs persistent:** 1DevTool explicitly supports both headless one-shot runs and live terminals, choosing by needed capability. — LOCAL SKILL.md
- **Converged architecture:** "a single orchestrator that owns the full conversation context and spawns ephemeral isolated subagents that return only a compressed summary". This is attributed to Anthropic, Cognition, OpenAI, Microsoft Agent Framework and LangChain. — [flowhunt (search snippet)](https://flowhunt.io/blog/multi-agent-ai-system/). This is a secondary source.
- **Human-in-the-loop gates:**
  - 1DevTool: plan/question/done gates, confirm-mode links, and human-applied charts.
  - Orchestrator.inc: a "Needs you" lane.
  - Conductor: "human-guided merge review".
  - Sources: LOCAL; [Orchestrator.inc README](https://github.com/OrchestratorInc/agent-orchestrator); [rustman](https://rustman.org/wiki/conductor-parallel-agents/)
- **Trend:** the category is moving "from 'conductor' (human-guided task assignment) to 'orchestrator' (autonomous planner)". — [rustman 2026-04-22](https://rustman.org/wiki/conductor-parallel-agents/)

### Inferences
- An app like the user's needs these components:
  1. A PTY/tmux session manager.
  2. Per-CLI adapters covering headless invocation, model flag, permission flag, transcript path for result and usage parsing, and status hooks.
  3. Worktree provisioning.
  4. A control API (CLI and MCP) for the orchestrator agent.
  5. A task store with gates.
  6. A usage ledger built from transcripts.
- 1DevTool already has every one of these.

### Gaps
- I found no rigorous comparison of PTY keystroke-injection reliability vs structured protocols (ACP, Claude Agent SDK, `codex exec --json`) for driving heterogeneous agents.

---

## Q4. What users praise and complain about, especially token and cost blowups

### Takeaway
Users praise worktree isolation, fast diff review and running agents in parallel. The loudest complaint is cost: multi-agent setups multiply tokens by roughly 7–15x, and much of the blowup comes from:
- subagents inheriting the expensive model
- prompt-cache misses from fresh, differently-prefixed subagents
- unbounded fan-out and review loops
- re-ingesting upstream context

Other complaints are tool churn and shutdowns (Vibe Kanban, Terragon, Opcode) and the operator becoming the bottleneck.

### Cited Findings
- **Agent teams:** about 7x the tokens of a standard session in plan mode. — [Claude Code costs docs](https://docs.anthropic.com/en/docs/claude-code/costs)
- **Multi-agent generally:** "up to 15x the tokens of a well-engineered single-agent prompt". 2026 papers reportedly show single-agent systems match or beat multi-agent at equal token budgets. — [flowhunt (search snippet)](https://flowhunt.io/blog/multi-agent-ai-system/); [reddit snapshot 2026-03](https://reddit.sentinel-team.org/posts/1rujflg/snapshots/2026-03-16T22%3A22%3A21.7293Z). Secondary sources; the original papers were not checked.
- **Postmortem (2026-08-04):** a Claude Code orchestrator (Plan → Approve → Execute → Review → Report, fresh subagents per phase) burned 1–2M Opus tokens per task, including trivial diffs. The multipliers:
  - Model inheritance: subagents defaulted to Opus, 1.7x.
  - Prompt-cache misses: fresh tailored subagents created new prefixes, and parallel dispatch prevented cache sharing until the first response streamed, 12x.
  - Unbounded fan-out plus review-until-clean loops, 3–5x.
  - Root cause: "Budget constraints lived in system prompts… rather than enforceable guardrails."
  - Fixes: an explicit model on every dispatch, curated briefs instead of repo dumps, a narrower orchestration trigger, at most 2 review rounds, and a `PreToolUse` hook enforcing hard limits (25 dispatches, 5 concurrent).
  - Source: [dev.to postmortem](https://dev.to/akashy/my-agent-orchestrator-burned-1-2m-opus-tokens-per-task-heres-the-postmortem-2k7g)
- **Hackernoon (2026-08-16):** orchestrators were "designed around task delegation, not resource management". Problems named:
  - Redundant re-ingestion of static context.
  - Context bloat, for example the final agent ingesting "18k tokens from A+B+C to review 20 lines of code".
  - No real-time cumulative spend visibility.
  - Proposed fixes: shared cache-friendly static prefixes, delta-only state passing (diffs/AST), and real-time budget gates in execution logic.
  - Source: [hackernoon](https://hackernoon.com/why-modern-agent-orchestrators-fail-at-cost-control)
- **Enterprise anecdotes:** Microsoft E+D reportedly moved engineers off Claude Code after about $2,000/engineer/month, and Uber's CTO said it burned its 2026 AI budget on coding agents in four months. — [search summary citing finchannel / Niall's diary](https://finchannel.com/how-to-stop-burning-money-on-ai-coding-agents/131847/tech-2/2026/06/). Unverified secondhand reports; treat with caution.
- **Ruflo:** token consumption is "significant", and users install cost-tracker plugins to avoid surprise bills. — [pasqualepillitteri.it](https://pasqualepillitteri.it/en/news/774/claude-flow-ruflo-multi-agent-orchestration-guide)
- **Praise and selection drivers:**
  - Conductor for its "clean local workflow" and fast review.
  - Claude Squad for being terminal-native with "no vendor lock-in".
  - "The bottleneck stops being the model and becomes the operator."
  - Source: [dev.to](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8)
- **Churn:**
  - Vibe Kanban: company shut down 2026-04-10, cloud ended.
  - Opcode: no longer actively developed.
  - Terragon: cloud agents dead.
  - Sources: [dev.to](https://dev.to/stravukarl/best-tools-for-managing-parallel-ai-coding-agents-in-2026-14l8); [agentsroom snippet](https://agentsroom.dev/blog/best-multi-agent-coding-tools)
- **Empirical token studies for Codex CLI budget control** exist ("where do your tokens go"). Not read in full. — [codex.danielvaughan.com 2026-07-03](https://codex.danielvaughan.com/2026/07/03/where-do-your-tokens-go-empirical-token-consumption-coding-agents-codex-cli-budget-control/)

### Inferences
- For the user's design, the highest-leverage cost controls are:
  1. Always set the model and agent explicitly per category; never inherit.
  2. Hand off curated briefs or diffs, never transcripts. 1DevTool's bounded `peek`/`notes`/`read --lines=40` is the right shape.
  3. Hard, code-enforced caps on dispatch count, concurrency and review rounds, not prompt guidance.
  4. Keep stable cache-friendly prefixes per worker. Long-lived sessions reuse cache better than fresh one-shot spawns, at the cost of context growth.
  5. A real-time ledger built from CLI transcripts (as 1DevTool does) or from CLI JSON output.
- Subscription-backed CLIs (Claude Max, ChatGPT Pro for Codex) change the cost model from dollars to quota and rate limits. That is why 1DevTool emphasizes quota lanes and account pools rather than $ budgets.

### Gaps
- I found no user reviews specific to 1DevTool's cost behaviour.
- I did not find direct HN threads in this pass. The Reddit evidence is via a snapshot aggregator.

---

## Q5. Which are open source and forkable (license, stack)?

### Takeaway
Permissively licensed and forkable:
- Orchestrator.inc: Apache-2.0, Go. Has an orchestrator agent and Kanban.
- Emdash: Apache-2.0, TypeScript/Electron-style desktop.
- Vibe Kanban: Apache-2.0, Rust plus TS.
- Nimbalyst/Crystal: MIT, TS.
- Ruflo: MIT, TS.
- Gas Town: MIT, Go.
- Agent of Empires: MIT, Rust.
- agent-deck: MIT, Go.
- Parallel Code: MIT, TS.
- OpenHands: MIT.
- ACP: Apache-2.0.

Copyleft: Claude Squad (AGPL-3.0, Go), xum/Mux (AGPL), Opcode (AGPL).

Source-available, not forkable for a competing product: Superset (ELv2) and oh-my-opencode/OmO (Sustainable Use License).

Closed: 1DevTool, Conductor, Cursor, Antigravity.

### Cited Findings
Licenses, languages, stars and last push come from the GitHub API, queried 2026-10-21.

| Project | License | Stack | Stars | Last push | Notes |
|---|---|---|---|---|---|
| OrchestratorInc/agent-orchestrator | Apache-2.0 | Go | ~13.4k | 2026-10-21 | Orchestrator agent, workers, Kanban, CI/review reactions ([README](https://github.com/OrchestratorInc/agent-orchestrator)) |
| generalaction/emdash | Apache-2.0 | TypeScript | ~6.0k | 2026-10-20 | Worktrees, issue intake, SSH remote, lifecycle hooks ([README](https://github.com/generalaction/emdash)) |
| BloopAI/vibe-kanban | Apache-2.0 | Rust (+TS) | ~28.4k | 2026-09-19 | Sunsetting, community-run |
| nimbalyst/nimbalyst (ex stravu/crystal) | MIT | TypeScript | ~2.0k (Crystal ~3.1k) | 2026-10-21 | Kanban, worktrees, iOS |
| ruvnet/ruflo (ex claude-flow) | MIT | TypeScript (+WASM) | ~78k | 2026-10-21 | Queen/swarm hierarchy, memory |
| gastownhall/gastown | MIT | Go | ~18.5k | 2026-10-21 | Coordinator plus merge queue, 20–30 agents |
| agent-of-empires/agent-of-empires | MIT | Rust | ~3.4k | 2026-10-21 | TUI plus web/mobile |
| asheshgoplani/agent-deck | MIT | Go | ~1.1k | 2026-10-21 | TUI session manager |
| johannesjo/parallel-code | MIT | TypeScript | ~1.1k | 2026-10-21 | Side-by-side A/B |
| nwiizo/ccswarm | MIT | Rust | ~150 | 2026-10-13 | Role-specialized Claude agents |
| imbue-ai/sculptor | MIT | Python | ~240 | 2026-10-21 | Container isolation |
| OpenHands/OpenHands | MIT | TypeScript (+Python) | ~91k | 2026-10-21 | Autonomous runner/control center |
| agentclientprotocol/agent-client-protocol | Apache-2.0 | Rust | ~4.5k | 2026-10-21 | Editor↔agent protocol |
| smtg-ai/claude-squad | AGPL-3.0 | Go | ~8.6k | 2026-08-20 | tmux plus worktrees TUI |
| coder/xum (ex mux) | AGPL-3.0 | TypeScript | ~2.1k | 2026-10-21 | Own agent loop |
| winfunc/opcode | AGPL-3.0 | TypeScript | ~22k | 2026-09-18 | Unmaintained per dev.to |
| superset-sh/superset | Elastic License 2.0 | TypeScript | ~15.4k | 2026-10-21 | MCP, CLI and SDK orchestration ([superset.sh](https://superset.sh/agent-orchestration)) |
| code-yeongyu/oh-my-openagent (oh-my-opencode) | Sustainable Use License 1.0 | TypeScript | ~70k | 2026-10-21 | Category→model routing; non-commercial/internal use only |
| 1DevTool (StoicSoft) | Proprietary | Electron (Node CJS CLI, node-pty, tmux) | n/a | v1.81.0, 2026-10-19 | [1devtool.com](https://1devtool.com/) |
| Conductor (Melty Labs) | Proprietary | Mac app | n/a | — | [rustman](https://rustman.org/wiki/conductor-parallel-agents/) |

### Inferences
- Best fork base for "1DevTool-like with an orchestrator agent": Orchestrator.inc (Apache-2.0). It already has a persistent orchestrator agent, worker sessions and Kanban, and supports 30+ CLIs. Emdash (Apache-2.0) is a strong base if a cross-platform Electron/TS stack with per-CLI provider adapters and lifecycle hooks is preferred.
- Borrow designs, not code:
  - oh-my-opencode: category→model mapping (its license forbids commercial reuse).
  - Superset: MCP/SDK surface (ELv2 forbids offering it as a managed service).
  - 1DevTool: Team/Swarm manifests, bounded peek/notes, task gates, AgentVC claims (proprietary).
- 1DevTool's stack, as observed: Electron, `ELECTRON_RUN_AS_NODE` CLI, a node-pty helper (`terminal ssh-host` "Node + node-pty NDJSON helper"), tmux, and a native sidecar exe. The user's own app could mirror this on Electron or Tauri.

### Gaps
- I did not verify Emdash's exact desktop framework (Electron vs Tauri) or Orchestrator.inc's UI stack beyond the Go daemon.
- The "Untrivial-ai/agent-orchestrator" (Apache-2.0) repo surfaced in search may be a fork or rename of the Composio project. Its relationship to OrchestratorInc was not confirmed.
