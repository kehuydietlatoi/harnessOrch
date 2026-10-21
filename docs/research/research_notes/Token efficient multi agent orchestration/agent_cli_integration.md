# Programmatic Integration Surfaces for Heterogeneous Coding-Agent CLIs (as of Oct 2026)

Scope: how one orchestrator can drive Claude Code, OpenAI Codex CLI, OpenCode (plus Gemini CLI / Cursor CLI) with long-lived/resumable sessions, structured results, and low per-call overhead. Research date: 2026-10-21. Version numbers quoted are those printed in the docs at fetch time. Note: OpenAI's Codex docs now 308-redirect from `developers.openai.com/codex/*` to `learn.chatgpt.com/docs/*` ([redirect observed](https://developers.openai.com/codex/noninteractive)). Old links in blog posts and READMEs may be stale.

## Claude Code: headless CLI, stream-json sessions, Agent SDK, context trimming, subscription vs API key

### Takeaway
Claude Code has the richest integration surface of the three. You get `claude -p` with `--output-format json|stream-json`, `--json-schema` structured output, resume/fork by session ID, and a persistent bidirectional `--input-format stream-json` mode. The TS and Python Agent SDKs wrap that same binary. `--bare` (CLI) and `settingSources: []` (SDK) keep CLAUDE.md, skills, plugins, hooks, and MCP out of a worker's context. The licensing constraint is the big one: an app you build and offer to others must use API-key auth, not claude.ai subscription OAuth.

### Cited Findings
**Headless basics**
- `claude -p` / `--print` runs non-interactively. Exit code is 0 on success and non-zero on failure. A failure inside the run, such as missing auth, is printed as the result on stdout. — [Claude Code headless](https://code.claude.com/docs/en/headless)
- `--output-format` takes `text` (default), `json`, or `stream-json`. The `json` output carries `result`, `session_id`, usage metadata, `total_cost_usd`, and a per-model cost breakdown. With `--continue`/`--resume`, cost is the whole conversation's total and is a client-side estimate. — [headless](https://code.claude.com/docs/en/headless)
- Structured output: `--output-format json --json-schema '<schema>'` puts validated output in `structured_output`. An invalid schema exits with `Error: --json-schema is not a valid JSON Schema`. If the run ends without valid output (e.g. a refusal), the field is absent, so always check for it. `format` keywords are annotations only. — [headless](https://code.claude.com/docs/en/headless)
- Streaming: `--output-format stream-json --verbose --include-partial-messages`. The last line is a `result` message. The first event is `system/init`, which reports model, tools, `mcp_servers` (with status), `mcp_server_errors`, `plugins`, `plugin_errors`, and a `capabilities` array for feature detection (e.g. `interrupt_receipt_v1`). — [headless](https://code.claude.com/docs/en/headless)
- Retries surface as `system/api_retry` events with `attempt`, `max_retries`, `retry_delay_ms`, and `error` ∈ {`authentication_failed`, `rate_limit`, `overloaded`, `billing_error`, …}. — [headless](https://code.claude.com/docs/en/headless)
- Subagent messages appear in stream-json with `parent_tool_use_id`. Text and thinking blocks are only forwarded with `--forward-subagent-text` (v2.1.211+). — [headless](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference)

**Sessions / long-lived**
- `--continue`/`-c` resumes the most recent conversation in the current directory. `-p --continue` includes `-p`/SDK sessions. `--resume <id|name|abs path to .jsonl>` resumes a specific one. Since v2.1.223, ID lookup searches every project on the machine. `--fork-session` assigns a new session ID on resume. `--session-id <uuid>` presets the ID. `--no-session-persistence` (print mode) disables saving. — [CLI reference](https://code.claude.com/docs/en/cli-reference); [headless](https://code.claude.com/docs/en/headless)
- Recommended pattern: `session_id=$(claude -p "Start" --output-format json | jq -r '.session_id'); claude -p "Continue" --resume "$session_id"`. — [headless](https://code.claude.com/docs/en/headless)
- Persistent process: `--input-format stream-json` (print mode, options `text`/`stream-json`). `--replay-user-messages` echoes stdin user messages, and requires stream-json in and out. With `--max-turns` plus stream-json input, a message still queued when the limit hits starts a new turn. — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- System prompt snapshotting: the system prompt is recorded on the first request and reused on `--resume`/`--continue` until compaction. Changing `--append-system-prompt` on a resumed run has no effect until compaction unless you pass `--system-prompt-snapshot off` (v2.1.257+). In `--bare`, recording is off unless you pass `--system-prompt-snapshot on`. — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- SIGTERM exits 143 and leaves the turn unfinished. To end a turn cleanly, use SIGINT or SDK `interrupt()`. `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` continues an interrupted turn on resume. — [headless](https://code.claude.com/docs/en/headless)
- A `-p` run waits for background subagents and commands after the turn. The idle cap is 10 min by default and is set with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`. — [headless](https://code.claude.com/docs/en/headless)

**Cutting context / startup overhead**
- `--bare` skips auto-discovery of hooks, skills, custom commands, subagents, plugins, MCP servers, auto memory, and CLAUDE.md. Only Bash, file read, and file edit tools remain. MCP connects only from `--mcp-config`. No system reminders are sent (e.g. no skill list, no file-changed notices). No background tasks run. Docs say it "is the recommended mode for scripted and SDK calls, and will become the default for `-p` in a future release." Full bare semantics need v2.1.286+. — [headless](https://code.claude.com/docs/en/headless)
- Bare mode never reads OAuth credentials or the keychain. It needs `ANTHROPIC_API_KEY`, an `apiKeyHelper` via `--settings`, or Bedrock/Vertex/Foundry credentials, so it does not use a subscription login. — [headless](https://code.claude.com/docs/en/headless)
- Context can be re-added selectively with `--append-system-prompt[-file]`, `--settings`, `--mcp-config`, `--agents <json|file>`, and `--plugin-dir`/`--plugin-url`. — [headless](https://code.claude.com/docs/en/headless)
- Other trimming flags:
  - `--tools "Bash,Edit,Read"` or `""` restricts built-in tools. It does not affect MCP tools; use `--disallowedTools "mcp__*"` for those.
  - `--disallowedTools` with a bare name removes the tool from context.
  - `--setting-sources user,project,local`.
  - `--strict-mcp-config`.
  - `--disable-slash-commands` disables all skills and commands.
  - `--safe-mode` disables all customizations but keeps auth.
  - `--restricted` is for eval harnesses on shared machines.
  - `--exclude-dynamic-system-prompt-sections` improves prompt-cache reuse across users and machines.
  - `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` in a custom prompt splits off a cacheable static prefix (v2.1.275+).

  — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- Cost and turn guards: `--max-turns`, `--max-budget-usd` (print only, client-side estimate, includes subagents), `--model`, `--fallback-model sonnet,haiku`, `--effort low|medium|high|xhigh|max|ultracode`. — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- Permissions for unattended runs:
  - Since v2.1.302, `-p` runs start in Manual mode when nothing sets a mode, so calls that need approval are denied unless something approves them.
  - Options: `--allowedTools` (rule syntax, e.g. `Bash(git diff *)`), `--permission-mode acceptEdits|auto|dontAsk|bypassPermissions`, `--permission-prompt-tool mcp__srv__tool`, and `--permission-prompts none` (v2.1.259+).
  - Denials appear as `permission_denied` system messages, and the result lists them in `permission_denials`.
  - Without `--bare`, a `-p` session runs the project's `.claude/settings.json` hooks and `.mcp.json` servers even in untrusted folders. No trust dialog is shown.

  — [headless](https://code.claude.com/docs/en/headless)

**Agent SDK (TS `@anthropic-ai/claude-agent-sdk`, Python `claude_agent_sdk`)**
- The SDK is "a library that runs the Claude Code binary", with built-in tools, hooks, subagents, MCP, permissions, sessions (resume/fork), skills, and plugins. For other languages, run `-p --output-format json` as a subprocess. — [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- Omitting `settingSources` is equivalent to `["user","project","local"]`, meaning it loads CLAUDE.md, rules, skills, agents, commands, and hooks like the CLI. Pass `settingSources: []` (Python `setting_sources=[]`) to limit the agent to programmatic config. — [SDK features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
- `settingSources` does not control these, which load regardless:
  - Managed policy settings.
  - `~/.claude.json`. Relocate it with `CLAUDE_CONFIG_DIR`.
  - Auto memory. Disable with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` or `autoMemoryEnabled:false`.
  - claude.ai MCP connectors when logged in with claude.ai. Disable with `strictMcpConfig: true`, `disableClaudeAiConnectors`, or `ENABLE_CLAUDEAI_MCP_SERVERS=false`. Note that `mcpServers: {}` does not suppress them.

  — [SDK features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
- `skills` option: `"all"`, a list of names, or `[]`. If you pass an explicit `tools` list you must include `"Skill"`. There is no programmatic skill registration; skills must be `.claude/skills/<name>/SKILL.md` files. — [SDK features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
- Subagents: use the `agents` parameter plus `allowedTools: ["Agent"]`. Programmatic hook callbacks (e.g. a `PreToolUse` deny via `hookSpecificOutput.permissionDecision`) also fire inside subagents and carry `agent_id`/`agent_type`. TS has more hook events than Python (`SessionStart`, `SessionEnd`, `TeammateIdle`, `TaskCompleted`). Agent teams are CLI-only and not configurable via SDK options. — [SDK features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
- MCP-as-orchestrator: `claude mcp` configures servers, and `--permission-prompt-tool` lets an MCP tool (e.g. your orchestrator) answer permission prompts. — [CLI reference](https://code.claude.com/docs/en/cli-reference)

**Subscription vs API key**
- SDK docs: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods…" — [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- Legal page:
  - OAuth "is intended exclusively for purchasers of Claude Free, Pro, Max, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  - Developers building products, including with the Agent SDK, "should use API key authentication". Anthropic does not permit them "to route requests through Free, Pro, or Max plan credentials on behalf of their users" or to "collect, store, or intermediate Claude.ai credentials".
  - It does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
  - "Advertised usage limits for Pro and Max plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  - Enforcement may happen "without prior notice."

  — [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- Hosting Claude Code inside your product: the binary must be unmodified, its built-in auth methods must not be removed, and you must not pay for, resell, or intermediate usage. Each end user authenticates with their own key or plan. — [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- `claude setup-token` generates a long-lived OAuth token for CI and scripts (subscription required). `claude auth status` returns JSON with `authMethod` ∈ {`none`,`claude.ai`,`oauth_token`,`api_key`,`api_key_helper`,`third_party`}. — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- Reported timeline (secondary sources): Anthropic clarified on 2026-02-19 that subscription OAuth in third-party tools violates its terms. OpenClaw subscription access was blocked from 2026-04-04. OpenCode had offered Claude subscription login. — [WinBuzzer](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/), [AlternativeTo](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use), [Sovereign Magazine](https://www.sovereignmagazine.com/article/anthropic-blocks-openclaw-claude-subscriptions)

**Windows-relevant**
- On macOS/Linux/WSL the default `--tools` set omits `Glob` and `Grep` (implying native Windows keeps them). — [CLI reference](https://code.claude.com/docs/en/cli-reference)
- Escaped double quotes in npm scripts keep `claude -p` invocations portable to Windows. Piped stdin is capped at 10MB. — [headless](https://code.claude.com/docs/en/headless)
- `--add-dir` rejects most network paths (`\\server\share`). — [CLI reference](https://code.claude.com/docs/en/cli-reference)

### Inferences
- The cheapest Claude worker call is `claude --bare -p --output-format json --json-schema <summary schema> --tools "Read,Edit,Bash" --append-system-prompt-file brief.md --max-turns N --max-budget-usd X`. Capture `session_id` and resume with `--resume` for follow-ups. Use `--fork-session` to branch speculative attempts.
- For a long-lived worker without process restart cost, keep one `claude -p --input-format stream-json --output-format stream-json --verbose` process per worker and write user messages to stdin. Alternatively, use the SDK's streaming-input mode, which uses the same mechanism.
- Because `--bare` ignores subscription OAuth, a subscription-backed orchestrator cannot use bare mode. It would have to use `--setting-sources ""`-style trimming plus `--strict-mcp-config`, `--disable-slash-commands`, and `--tools`. Distributing such an orchestrator to other users is not permitted unless each user signs into the unmodified binary themselves.
- The `--json-schema` result object is a natural "compact summary" channel back to the orchestrator; the transcript stays on disk.

### Gaps
- I did not fetch the SDK sessions page. Exact TS/Python option names (`resume`, `forkSession`, `continue`, `ClaudeSDKClient`, `outputFormat`) are from the SDK overview's capability list and training knowledge, not verified verbatim this session.
- `claude mcp serve` (Claude Code as an MCP server) is not listed in the fetched CLI reference table. Its current status is unverified.
- I found no official statement on whether personal scripting of `claude -p` with your own Max login is within "ordinary, individual usage" beyond the legal-page wording above.

## Codex CLI: exec, resume, JSONL, app-server, mcp-server, SDK

### Takeaway
Codex exposes three surfaces:
- `codex exec` for one-shots, with `--json` JSONL events, `--output-schema`, and `codex exec resume`.
- `codex app-server`, a bidirectional JSON-RPC 2.0 server (stdio/WebSocket) with threads, turns, steer, interrupt, fork, and a per-turn `outputSchema`. This is the deepest integration.
- `codex mcp-server`, which exposes `codex` and `codex-reply(threadId)` as MCP tools.

The TS SDK `@openai/codex-sdk` wraps the CLI with `startThread`/`resumeThread`/`run({outputSchema})`.

### Cited Findings
- `codex exec` flags:
  - `--json` gives a JSONL stdout stream with `thread.started`, `turn.started`, `item.started`, `item.completed`, `turn.completed`, `turn.failed`, and `error`. Items include agent messages, reasoning, command executions, file changes, MCP tool calls, and web searches.
  - Usage fields: `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_output_tokens`.
  - Other flags: `--output-schema <path>` (final response conforms to JSON Schema), `-o/--output-last-message <path>`, `--sandbox workspace-write|danger-full-access`, `--skip-git-repo-check`, `--ephemeral` (no rollout files), `--ignore-user-config` (skips `$CODEX_HOME/config.toml`), `--ignore-rules`.
  - `--full-auto` is deprecated; use `--sandbox workspace-write` or `--approve-for-me`.

  — [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- Resume: `codex exec resume --last "continue…"` or `codex exec resume <SESSION_ID>`. — [non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)
- CI auth: `CODEX_API_KEY=<key> codex exec --json "task"`. Docs advise against job-level key env vars in workflows that check out repo code. — [non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)
- App-server:
  - Transport: JSON-RPC 2.0, bidirectional. `stdio` is the default (JSONL); WebSocket and `--listen unix://` are also supported.
  - WebSocket auth: `--ws-auth capability-token --ws-token-file …` or `signed-bearer-token`.
  - Bounded queues reject with `-32001`.

  — [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- App-server methods:
  - `initialize`, followed by an `initialized` notification.
  - `thread/start`, `thread/resume`, `thread/fork`.
  - `turn/start`, with model/effort/sandbox overrides.
  - `turn/steer`, which appends input to the active turn.
  - `turn/interrupt`, `review/start`.
  - Per-turn `outputSchema`.
  - `mcpServer/tool/call`, `tool/requestUserInput`, the server-initiated `item/permissions/requestApproval`, and `config/mcpServer/reload`.
  - Schema generation: `codex app-server generate-ts --out ./schemas` and `codex app-server generate-json-schema --out ./schemas`.
  - Docs position app-server for "deep integration inside your own product" and the Codex SDK for automated workflows.

  — [Codex app-server](https://learn.chatgpt.com/docs/app-server)
- Codex TS SDK (`npm install @openai/codex-sdk`, Node 18+): `new Codex({env, config, configOverrides})`, `codex.startThread({workingDirectory, skipGitRepoCheck, …})`, `codex.resumeThread(id)` (threads persisted in `~/.codex/sessions`), `thread.run(prompt, {outputSchema})`, `thread.runStreamed()` → `events` (`item.completed`, `turn.completed` with usage). Input can include `{type:"local_image", path}`. — [openai/codex sdk/typescript README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- The SDK spawns the Rust CLI as a child process over JSONL stdin/stdout. — [Daniel Vaughan blog, Apr 2026 (secondary)](https://codex.danielvaughan.com/2026/04/08/codex-typescript-sdk-streaming-multimodal/)
- `codex mcp-server` is a stdio MCP server with two tools:
  - `codex`: `prompt` required; optional `model`, `approval-policy`, `sandbox`, `cwd`, `base-instructions`, `config`, `profile`. Returns a `threadId`.
  - `codex-reply`: `prompt` and `threadId`.

  It can be inspected with `npx @modelcontextprotocol/inspector codex mcp-server`, and OpenAI's Agents SDK guide uses it for multi-agent orchestration. — [OpenAI docs: mcp-server (search result)](https://learn.chatgpt.com/docs/mcp-server); [Vaughan blog (secondary)](https://codex.danielvaughan.com/2026/05/18/codex-cli-as-mcp-server-exposing-agent-capabilities-agents-sdk-multi-agent-delegation/)
- ACP: Codex CLI is listed as ACP-capable "via ACP's adapter". — [ACP agents list](https://agentclientprotocol.com/overview/agents)

### Inferences
- For a long-lived frontend worker, `codex app-server` over stdio is the best fit: one process, many threads, `turn/steer` for mid-turn corrections, per-turn `outputSchema` for compact results, and `thread/fork` for branching. `codex exec --json --output-schema … -o last.json` plus `codex exec resume <id>` is the simpler subprocess path.
- `--ephemeral` and `--ignore-user-config` are Codex's equivalents to Claude's `--no-session-persistence` and `--bare`-style isolation. They are useful for cheap one-shot calls, but ephemeral threads cannot be resumed.
- The MCP-server route is the easiest way for a Claude-based orchestrator to call Codex as a tool. MCP tool calls are synchronous and return full text, so ask for a compact summary in `base-instructions` or the prompt.

### Gaps
- I did not verify these Codex surfaces this session: AGENTS.md discovery rules, the skills (SKILL.md) support details, `--profile`/`-m` profiles syntax, and Windows sandbox behavior. From memory: Codex reads AGENTS.md hierarchically and added Agent Skills support in late 2025. Treat this as unverified.
- Python Codex SDK: not verified.
- I found no official OpenAI statement on whether ChatGPT-subscription login may be used to automate Codex inside third-party orchestrators. OpenCode shipped ChatGPT Plus/Pro (Codex) login in v1.1.11 (~Jan 2026) ([DevGenius (secondary)](https://blog.devgenius.io/jump-ship-in-minutes-codex-oauth-now-works-in-opencode-d2708c32f571); [aiengineerguide](https://aiengineerguide.com/til/chatgpt-subscription-with-opencode/)), which suggests OpenAI tolerates or supports it. That is not confirmed from an OpenAI source.

## OpenCode: serve + SDK, run, sessions, providers, agents

### Takeaway
OpenCode is built server-first. `opencode serve` exposes an OpenAPI 3.1 HTTP API with sessions, sync and async prompts, fork, summarize, abort, and an SSE event stream. `@opencode-ai/sdk` wraps it and supports `format: {type:'json_schema'}` structured output. `opencode run --attach` lets CLI one-shots reuse a warm server, which makes OpenCode the lowest-overhead worker for cheap-model small tasks.

### Cited Findings
- `opencode serve` flags: `--port` (default 4096), `--hostname` (127.0.0.1), `--mdns`, `--mdns-domain`, `--cors`. HTTP basic auth is enabled with `OPENCODE_SERVER_PASSWORD`; the username is `opencode` or `OPENCODE_SERVER_USERNAME`. — [OpenCode server](https://opencode.ai/docs/server/)
- Endpoints:
  - Sessions: `GET/POST /session`, `GET/DELETE /session/:id`, `POST /session/:id/abort`, `POST /session/:id/fork` (branch at a message), `POST /session/:id/summarize`.
  - Messages: `POST /session/:id/message` (send and await), `POST /session/:id/prompt_async` (returns 204), `POST /session/:id/command`, `POST /session/:id/shell`.
  - Other: `GET /event` (SSE), `GET /doc` (OpenAPI 3.1).

  — [OpenCode server](https://opencode.ai/docs/server/)
- SDK `@opencode-ai/sdk`:
  - `createOpencode()` starts a server plus client; `createOpencodeClient({baseUrl})` attaches to an existing one.
  - Methods: `session.create/list/prompt/messages/abort`.
  - `prompt` body: `parts`, `model` (provider and model ID), `agent`, `noReply` (inject context without an AI reply), and `format: { type: 'json_schema', schema }`. The response includes `structured_output`.
  - `event.subscribe()` returns a typed SSE async iterable.

  — [OpenCode SDK](https://opencode.ai/docs/sdk/)
- CLI:
  - `opencode run` flags: `--command`, `-c/--continue`, `-s/--session`, `--fork`, `-m/--model`, `--agent`, `-f/--file`, `--format default|json`, `--title`, `--attach` (to a running server), `-p/--password`, `-u/--username`, `--dir`, `--port`, `--variant`, `--thinking`, `--auto`.
  - `opencode acp` is an ACP server over stdin/stdout nd-JSON.
  - `opencode session list --format json` and `opencode session export [id] --sanitize`.
  - Env vars: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, `OPENCODE_PERMISSION` (inline JSON permissions).

  — [OpenCode CLI](https://opencode.ai/docs/cli/)
- Agents:
  - Two kinds: primary (built-in `build`, `plan`) and subagents (built-in `general`, `explore`, `scout`).
  - Defined under the `"agent"` key in `opencode.json` or as markdown in `.opencode/agents/` or `~/.config/opencode/agents/`.
  - Fields: `mode` (primary/subagent/all), `model` (e.g. `"anthropic/claude-sonnet-4-20250514"`), `prompt`, `permission`, `temperature`, `steps`. `tools` is deprecated in favor of `permission`.

  — [OpenCode agents](https://opencode.ai/docs/agents/)
- The docs nav lists "Agent Skills", but the fetched content had no details. — [OpenCode agents](https://opencode.ai/docs/agents/)
- ChatGPT Plus/Pro (Codex) login via `/connect` in OpenCode since ~v1.1.11. Community plugins (e.g. `opencode-openai-codex-auth`) also exist. — [DevGenius (secondary)](https://blog.devgenius.io/jump-ship-in-minutes-codex-oauth-now-works-in-opencode-d2708c32f571); [jxstanford/opencode-openai-codex-auth](https://github.com/jxstanford/opencode-openai-codex-auth)
- OpenCode had offered Claude subscription login, and that use is now prohibited under Anthropic's 2026 terms clarification. — [WinBuzzer](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/); [Anthropic legal](https://code.claude.com/docs/en/legal-and-compliance)

### Inferences
- Pattern: run one `opencode serve` per repo or worktree.
  - Create a session per task, then `POST /session/:id/message` with `model: {providerID:"openrouter", modelID:…}`, `agent: "<cheap-worker>"`, and `format: json_schema`.
  - Read only `structured_output`.
  - Use `noReply: true` to preload a compact brief without paying for a reply, and `summarize` to compact long sessions.
- `prompt_async` plus `/event` SSE allows fan-out of many concurrent cheap tasks without blocking HTTP calls.

### Gaps
- Provider config specifics (OpenRouter, Ollama/LM Studio local models via `provider` blocks in `opencode.json` and `opencode auth login`) were not fetched this session. Check https://opencode.ai/docs/providers/.
- Skills (SKILL.md) support details are unverified.
- The repo is variously cited as `sst/opencode` and `anomalyco/opencode`. The canonical location was not verified.

## Gemini CLI, Cursor CLI, others: headless modes and session reuse

### Takeaway
Both CLIs follow the Claude Code-style `-p` plus `--output-format json|stream-json` pattern. Gemini CLI has project-scoped resumable sessions (`--resume`). Cursor's `agent` CLI has print mode and a `CURSOR_API_KEY`. Both are listed as ACP agents (Cursor natively).

### Cited Findings
- Gemini CLI headless mode triggers on a non-TTY or `-p/--prompt`. `--output-format json` returns `{response, stats, error?}`. `stream-json` emits JSONL events `init`, `message`, `tool_use`, `tool_result`, `error`, `result`. Exit codes: 0 success, 1 error, 42 input error, 53 turn limit exceeded. — [Gemini CLI headless](https://geminicli.com/docs/cli/headless/)
- Gemini sessions:
  - `--resume`/`-r` resumes the latest session, by index (`--resume 1`), or by UUID. Also `--list-sessions` and `--delete-session <n|id>`.
  - Sessions are stored at `~/.gemini/tmp/<project_hash>/chats/` and are project-specific.
  - Retention defaults: `maxAge "30d"`, `maxCount 50`. `maxSessionTurns: 100`.

  — [Gemini session management](https://geminicli.com/docs/cli/session-management/)
- Cursor CLI: the binary is `agent`. Options are `-p/--print`, `--output-format text|json|stream-json`, `--stream-partial-output`, `--force` (also `--yolo`) for file changes without confirmation, and auth via `CURSOR_API_KEY`. — [Cursor CLI headless](https://cursor.com/docs/cli/headless)
- ACP-listed agents include natively Cline, Cursor, GitHub Copilot (preview), and Junie. Others listed include Gemini CLI, Goose, Kimi CLI, Kiro CLI, Mistral Vibe, OpenHands, Factory Droid, Docker cagent, Qoder CLI, and Pi (via pi-acp). — [ACP agents](https://agentclientprotocol.com/overview/agents)

### Inferences
- Gemini's `--resume` combined with `-p` should allow resumed headless turns, but the docs fetched did not confirm `-p` plus `--resume` together or return a `session_id` in JSON output.

### Gaps
- Gemini: whether JSON output includes a session ID, and the exact ACP flag (`--experimental-acp` per older docs vs `--acp`). Not confirmed.
- Cursor: `--resume`/`create-chat` session IDs, `--model`, and the `agent acp` command were not in the fetched page.
- Subscription ToS for automating Gemini (Google login) or Cursor plans was not researched.

## Cross-agent protocols: ACP, MCP, A2A

### Takeaway
- MCP is the most universal way to make one agent call another as a tool. Codex ships `codex mcp-server`, and every CLI here consumes MCP.
- ACP (Zed's Agent Client Protocol, JSON-RPC over stdio) is the de facto "drive a coding agent from a client" protocol. Claude (via `@agentclientprotocol/claude-agent-acp`), Codex (adapter), OpenCode (`opencode acp`, native), Gemini, and Cursor (native) all speak it, which makes it the closest thing to a uniform session API across all of them.
- A2A (Linux Foundation, which absorbed IBM's other "ACP") targets cross-org agent-to-agent communication and has little native coding-CLI support.

### Cited Findings
- `@agentclientprotocol/claude-agent-acp` is the "ACP adapter for the Claude Agent SDK". Features: sessions with load/resume and replay, client MCP servers, permission prompts, slash commands, @-mentions, images, a diff extension, TODOs, interactive terminals, and subagent transcripts. Apache-2.0, ~2.7k stars, with a `@preview` npm channel. — [GitHub claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp)
- The ACP agents page lists Claude Agent "via Zed's SDK adapter", Codex CLI "via ACP's adapter", native Cline/Cursor/Copilot/Junie, and 50+ others including Gemini CLI. — [ACP agents](https://agentclientprotocol.com/overview/agents)
- `opencode acp` "Starts an ACP server that communicates via stdin/stdout using nd-JSON", with `--cwd` and related flags. — [OpenCode CLI](https://opencode.ai/docs/cli/)
- Codex as MCP: the `codex` and `codex-reply` tools, with `threadId` continuity. — [OpenAI mcp-server docs (search)](https://learn.chatgpt.com/docs/mcp-server)
- A2A: Google donated A2A to the Linux Foundation on 2025-06-23. IBM's Agent Communication Protocol merged into A2A in Aug 2025 and its repo is archived. Note this is a different "ACP" from Zed's Agent Client Protocol. — [Zuplo blog (secondary)](https://zuplo.com/blog/agent-protocol-stack-mcp-a2a-acp-2026); [Daniel Vaughan (secondary)](https://codex.danielvaughan.com/2026/05/29/agent-to-agent-communication-protocols-a2a-vs-acp-vs-mcp-compared/)

### Inferences
- Maturity ranking for this use case:
  1. Native subprocess and SDK surfaces (most complete; structured output and resume everywhere).
  2. ACP (uniform session/prompt/permission semantics across all target agents, but adapters lag native features; structured-output-by-schema is not obviously part of ACP).
  3. MCP-as-tool (simple, but synchronous and text-returning).
  4. A2A (no first-party coding-CLI servers found).
- Name collision: "ACP" means Zed's Agent Client Protocol in the coding-agent world. IBM's Agent Communication Protocol is now part of A2A.

### Gaps
- ACP protocol version, `session/load` vs `session/resume` method names, and whether ACP supports output schemas were not fetched from the spec.
- I found no first-party A2A server for Claude Code, Codex, or OpenCode.

## Orchestrator patterns: compact briefs in, structured summaries out

### Takeaway
Every target agent now supports "prompt in, JSON-schema-validated object out" plus a resumable session handle. The orchestrator should therefore:
1. Send a short brief, via system-prompt append or a file reference.
2. Demand a schema-constrained summary (status, files changed, tests, open questions).
3. Store only the session or thread ID, so it can resume the worker for follow-ups instead of replaying transcripts.

### Cited Findings
- Structured result and handle per agent:

  | Agent | Structured result | Session handle |
  | --- | --- | --- |
  | Claude | `--json-schema` → `structured_output` | `session_id` → `--resume` / `--fork-session` |
  | Codex exec | `--output-schema` + `-o` | `codex exec resume <id>` |
  | Codex app-server | per-turn `outputSchema` | `thread/resume` / `thread/fork` |
  | Codex SDK | `run(..., {outputSchema})` | `resumeThread` |
  | OpenCode | `format: json_schema` → `structured_output` | session IDs, `fork` |

  — [Claude headless](https://code.claude.com/docs/en/headless), [Codex non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode), [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Codex SDK](https://github.com/openai/codex/blob/main/sdk/typescript/README.md), [OpenCode SDK](https://opencode.ai/docs/sdk/), [OpenCode server](https://opencode.ai/docs/server/)
- Token and cost telemetry per call:
  - Claude: `total_cost_usd` and per-model cost in JSON output.
  - Codex: usage including `cached_input_tokens` in `turn.completed`.
  - Gemini: `stats`.

  — [Claude headless](https://code.claude.com/docs/en/headless), [Codex non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode), [Gemini headless](https://geminicli.com/docs/cli/headless/)
- Claude lets you inject a subagent-level policy on all nested subagents with `--append-subagent-system-prompt[-file]` (print mode). — [CLI reference](https://code.claude.com/docs/en/cli-reference)

### Inferences
- Recommended per-agent transport:

  | Agent | Primary transport | Alternative |
  | --- | --- | --- |
  | Claude | Agent SDK with `settingSources: []` (or CLI `--bare`), long-lived via streaming input | `-p --resume` |
  | Codex | app-server stdio (long-lived) | SDK / `exec resume` |
  | OpenCode | `opencode serve` HTTP | — |
  | Gemini/Cursor | `-p --output-format json` subprocess | — |

  ACP is the alternative if you want one client codepath for all of them.
- Keep worker transcripts on the worker side, which all persist sessions. Return only the schema object and the session ID to the orchestrator's context. Use fork for speculative retries.
- Disable per-worker context bloat: `--bare`/`settingSources: []`, `--strict-mcp-config`, and minimal `--tools` for Claude; `--ignore-user-config` for Codex; dedicated minimal `agent` definitions with restricted `permission` for OpenCode.

### Gaps
- No benchmark data was found comparing per-call startup latency or token overhead across the CLIs.

## Practical gotchas: Windows, auth, ToS

### Takeaway
The dominant risk is licensing. Claude subscription OAuth may not be used by an app that serves other users. API keys (or each end user signing into the unmodified binary themselves) are required. OpenCode's Codex/ChatGPT login is tolerated, but I found no OpenAI ToS confirmation. Windows-specific documentation was sparse.

### Cited Findings
- Anthropic's Agent SDK and third-party-auth restrictions are quoted above. — [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- Codex: put `CODEX_API_KEY` inline per command, not as job-level env in workflows that check out untrusted code. — [Codex non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)
- Claude `-p` without `--bare` executes project hooks and `.mcp.json` servers in untrusted folders without a trust dialog, which is a supply-chain risk when workers run in arbitrary repos. — [Claude headless](https://code.claude.com/docs/en/headless)
- Claude multi-tenant isolation: use `settingSources: []` plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, with per-tenant filesystems. — [SDK features](https://code.claude.com/docs/en/agent-sdk/claude-code-features)
- Windows notes: quote escaping in scripts, `Glob`/`Grep` default difference, no UNC network paths for `--add-dir`. — [headless](https://code.claude.com/docs/en/headless), [CLI reference](https://code.claude.com/docs/en/cli-reference)

### Inferences
- On Windows, prefer SDK or HTTP integration (Claude Agent SDK, Codex app-server stdio, OpenCode HTTP) over shell-quoted CLI args. Passing JSON schemas and briefs via files (`--append-system-prompt-file`, `--output-schema <path>`, `--agents <file>`) avoids cmd/PowerShell quoting problems.
- For SIGTERM/SIGINT semantics on Windows (Claude documents exit code 143 on SIGTERM), use SDK `interrupt()` or Codex `turn/interrupt` / OpenCode `abort` instead of process signals.

### Gaps
- Codex's Windows sandbox status (native vs WSL) and OpenCode Windows caveats were not researched this session.
- I found no official OpenAI or Google ToS text on automating subscription-authenticated Codex or Gemini CLIs from a third-party orchestrator.
