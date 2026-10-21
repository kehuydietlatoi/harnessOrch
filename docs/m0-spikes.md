# M0 spike results (2026-10-21)

Measured on this machine with the installed CLIs: Claude Code 2.1.285, Codex CLI 0.160.1, OpenCode 1.19.3. Each spike ran in an empty temp git repo.

## Claude: a lean worker profile without a separate login

**Command:**

```
ENABLE_CLAUDEAI_MCP_SERVERS=false CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 \
claude -p … --output-format stream-json --verbose \
  --setting-sources project --strict-mcp-config --mcp-config '{"mcpServers":{}}' \
  --disable-slash-commands --tools "Read,Edit,Write,Bash,Grep,Glob" --model claude-sonnet-5-5
```

**What the session loads (from `system/init`):**

| Item | Old orch worker | Lean worker |
|---|---|---|
| Tools | 57, 32 of them MCP | 6 |
| MCP servers | several | none |
| Skills | 55 | 0 |
| Slash commands | 107 | 0 |
| User plugins | academic-research and others | none (only built-in plugins remain) |

**Preamble on "Reply OK":** about **6.6k tokens** in total (1,801 cache write + 4,821 cache read). The old orch worker used about 23.6k.

**Auth:** the lean worker uses the normal login. `--setting-sources project` already drops user plugins and skills, so **no dedicated `CLAUDE_CONFIG_DIR` and no second login are needed**.

**Structured output:** `--json-schema '<schema>'` returns the validated object in `structured_output` on the `result` event.

**Session resume:** `--session-id <uuid>` on the first call and `--resume <uuid>` on the next keep the same session. The second task read **14,164 tokens from cache and wrote only 414 new ones, a 97% cache hit**. This confirms the "one session per agent" design.

**Opus on Pro:** `claude-opus-5-5` works headless on the Pro plan. With `--tools ""`, the preamble is about 1.9k tokens.

## Codex: works, but its baseline is the heaviest of the three

**Command:**

```
codex exec --json --ignore-user-config --output-schema <file> \
  -m gpt-6.1-sol -c model_reasoning_effort=medium --approve-for-me [resume <thread_id>] -
```

- **Structured output and resume:** `--output-schema` makes the final `agent_message` the schema JSON. `exec resume <thread_id>` continues the same thread; the ID comes from the `thread.started` event.
- **Token use on a trivial task** ("create hello.txt", about 3 model requests):

  | Setup | Input tokens | Cached |
  |---|---|---|
  | Default features | 49,427 | 32,384 |
  | Unused features disabled (list below) | 26,860 | 13,184 |

  Disabling the unused features roughly halves the baseline. The engine disables these by default: `apps browser_use browser_use_external computer_use multi_agent plugins remote_plugin skill_search tool_suggest goals image_generation in_app_browser sleep_tool`. `image_generation` is re-enabled only for asset tasks.
- **Open question:** a resumed second turn reported 105k input tokens. This needs one more probe to tell whether `turn.completed` usage is per-turn or cumulative per thread. The ledger must not double-count either way.

## OpenCode free models: both work headless

**Command:**

```
OPENCODE_DISABLE_PROJECT_CONFIG=true opencode run --pure --format json -m <model> "<prompt>"
```

**Models tested:**
- `opencode/deepseek-v4.1-flash-free`: works.
- `opencode/glm-5.3-flash-free`: works.

**Token use:** about 13k tokens per request (a free tier, so it costs nothing). The second request in a turn hits the cache.

**Session ID:** `sessionID` appears on every event and can be resumed with `-s`.

## Not yet run (belong to M2, the desktop shell)

- `node:sqlite` inside the Electron main process. It already works in plain Node 25, which the engine uses.
- node-pty + xterm running interactive `claude` on Windows.

## M1 live smoke run (2026-10-21)

**The plan:** 3 tasks on a tiny ESM repo (`node --test` checks).

| Task | Role | Agent | Depends on |
|---|---|---|---|
| T1 slugify | implement | Codex | — |
| T2 clamp | small | OpenCode, free DeepSeek | — |
| T3 kebab title | implement | Codex | T1 |

**Run:** `ho run` → ready in 80 seconds → `ho merge` → all 10 tests pass on `main`.

**What happened:**
- **Scheduling:** T1 and T2 ran in parallel, and T3 waited for T1.
- **Session reuse:** Codex resumed its T1 session for T3.
- **Reviews:** Codex reviewed OpenCode's work and Claude Sonnet reviewed Codex's work, diff only. Both approved, and Claude added 2 non-blocking follow-ups.
- **Plan file:** the engine ticked all boxes.

**Token use** (effective = uncached + cache writes×1.25 + cache reads×0.1 + output):

| Agent | Runs | Effective tokens | Cache hit |
|---|---|---|---|
| Codex | 3 (2 implement + 1 review) | 62,373 | 76% |
| OpenCode | 1 | 44,731 (free) | 44% |
| Claude | 1 review | 10,340 | 48% |
| **Total** | 5 | **117,444** (about **39k per task**) | |

The M1 target was ≤100k per task. The old harness averaged about 229k per issue on its sandbox and about 2.65M per issue on a real repo.

**What the first attempt caught:** a broken test script (`node --test test/` fails on Node 25). Both workers correctly reported `blocked` instead of editing `package.json`, which was outside their write scope. That attempt also exposed a bug, now fixed: an orchestrator "retry" threw away the worker's progress. A same-agent retry now continues in the same session and work tree.
