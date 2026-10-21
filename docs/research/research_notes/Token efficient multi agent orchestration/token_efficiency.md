# Token-Efficiency Strategies for Multi-Agent Coding Orchestration (as of Oct 2026)

Research date: 2026-10-21. All dated facts carry their publication date. "Evidence" = measured or published numbers; "Opinion" = practitioner or vendor recommendation without a controlled measurement.

## Q1. Where do tokens go in agentic coding sessions?

### Takeaway
In agentic coding, input tokens dominate cost, and most of those are re-sent context: cache reads, fixed harness preamble, and file contents gathered during exploration. Each fresh agent pays a fixed bootstrap of roughly 7k to 55k tokens (system prompt, tool schemas, CLAUDE.md/AGENTS.md, skills list) before it does any work. It then pays again to re-discover the codebase. The Explore and Fix phases take about two-thirds of all rounds. Runs that burn more tokens do not score higher; expensive failures are mostly redundant file viewing.

### Cited Findings
**Overall magnitude (evidence)**
- Agentic coding tasks consume about 3,500x more tokens than a single-round reasoning task and about 1,200x more than a multi-round chat task. The gap is driven mainly by input tokens. (SWE-bench Verified, 8 frontier LLMs; Bai, Huang, Wang, ..., Brynjolfsson, Pentland, Pei; arXiv 2604.22750, v3 dated 2 Oct 2026) — [How Do AI Agents Spend Your Money?](https://arxiv.org/abs/2604.22750)
- In that study, cache-read tokens are the largest cost category in every problem-solving phase. Output tokens cluster in planning-heavy phases such as Setup. — [arXiv 2604.22750v3](https://arxiv.org/html/2604.22750v3)
- The Explore and Fix phases together account for about two-thirds of all rounds. Explore accumulates context; Fix is edit and debug iterations. — [arXiv 2604.22750v3](https://arxiv.org/html/2604.22750v3)
- On the same task, the most expensive runs cost about 2x the cheapest, and total tokens can differ by up to 30x across runs. High-cost problems vary more. — [arXiv 2604.22750v3](https://arxiv.org/html/2604.22750v3)
- More tokens do not mean better results: "accuracy often peaks at intermediate cost and saturates at higher costs." High-cost failed runs show sharp increases in redundant file viewing and editing. — [arXiv 2604.22750v3](https://arxiv.org/html/2604.22750v3)
- Model choice matters for token efficiency. GPT-5 and GPT-5.2 reach strong accuracy at low cost, while Kimi-K2 and Claude Sonnet 4.5 use on average over 1.5M more tokens per task than GPT-5. — [arXiv 2604.22750v3](https://arxiv.org/html/2604.22750v3)
- Models predict their own token usage poorly (correlation up to 0.39 for output tokens) and systematically underestimate input tokens. — [arXiv 2604.22750v3](https://arxiv.org/html/2604.22750v3)
- Manus reports an input-to-output token ratio of about 100:1 in its agent, with about 50 tool calls per typical task (17-18 Jul 2025). — [Manus: Context Engineering for AI Agents](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Anthropic (13 Jun 2025): agents use about 4x the tokens of chat, and multi-agent systems about 15x. In BrowseComp, token usage alone explained 80% of performance variance; token usage, tool calls, and model choice together explained 95%. — [Anthropic: How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)

**Fixed per-session / per-agent overhead (evidence)**
- Harness preamble, measured with a logging proxy (12 Jul 2026; Claude Code 2.1.207 vs OpenCode 1.17.18, Sonnet 4.5):

  | | Total | System prompt | Tool schemas | Scaffolding |
  |---|---|---|---|---|
  | Claude Code | ~33,000 | ~6.5k | ~24k (27 tools) | ~2.5k |
  | OpenCode | ~6,900 | ~2k | ~4.8k (10 tools) | none |

  That is about 4.7x more for Claude Code. — [Systima: Claude Code Sends 4.7x More Tokens Than OpenCode](https://systima.ai/blog/claude-code-vs-opencode-token-overhead)
- The same study found OpenCode emitted byte-identical prefixes across requests, while Claude Code's prefix varied between sessions. On identical tasks Claude Code wrote 53,839 cache tokens vs 1,003 for OpenCode, a 54x difference, billed at the 1.25x write premium. — [Systima](https://systima.ai/blog/claude-code-vs-opencode-token-overhead)
- Systima also reports that a 72KB instruction file adds about 20k tokens per request, five MCP servers add about 4.9k to 7k tokens, and subagent delegation multiplied costs by 4.2x through repeated bootstrap overhead (in its test setup). — [Systima](https://systima.ai/blog/claude-code-vs-opencode-token-overhead)
- Claude Code subagent spawn cost (practitioner measurement, 28-29 Aug 2026). A no-op subagent that only returned "ok" received a 54,154-token context: system prompt, tool schemas, the CLAUDE.md chain and the skills list, written once as a cold cache write. The author had earlier reported 436k. That figure was wrong because it summed every request's full input at face value, so 8 iterations x 54k was counted without the cache-read discount. The author estimates the effective cost of a working reader subagent at about 100k tokens. That is 68k for the 54k write at 1.25x, plus iterations re-reading at 0.1x. Caveat: this was on a repo whose instruction files had once totalled 548KB. — [DEV: We said a subagent costs 436k tokens; a cleaner measurement says 54k](https://dev.to/rulestack/we-said-a-claude-code-subagent-costs-436k-tokens-a-cleaner-measurement-says-54k-here-is-what-37am)
- Another write-up reports median subagent "preamble bills" of about 15.9k (Sonnet 5), 15.9k (Opus 5), 14.8k (Opus 4.8) and 15.6k (Haiku 4.5). The difference from 54k probably reflects config size, such as CLAUDE.md, skills and MCP. — [ranjankumar.in: The Preamble Never Stops](https://ranjankumar.in/claude-code-subagent-token-cost) (search-snippet level; not fully reviewed)
- Practitioner headline (unverified, title-level only): "Claude Code Subagents Were 48% of My Bill. Their Output Was 0.9%." — [DEV](https://dev.to/ji_ai/claude-code-subagents-were-48-of-my-bill-their-output-was-09-e4i)
- Tool-schema bloat (Anthropic, 24 Nov 2025):
  - GitHub MCP: about 26K tokens (35 tools); Slack about 21K; Jira about 17K; Sentry and Grafana about 3K each; Splunk about 2K.
  - Five servers come to about 55K tokens "before the conversation even starts". The largest observed setup used 134K tokens on tool definitions.
  - [Anthropic: Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- Intermediate results flowing through context are a second form of bloat. Anthropic's example, a Google Drive to Salesforce workflow, falls from 150,000 to 2,000 tokens (98.7%) when code execution processes the data outside the model context. A 2-hour meeting transcript passed through twice could add about 50,000 tokens. (4 Nov 2025) — [Anthropic: Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- Tool-use system-prompt overhead per request is small: 286 tokens for Opus 5.5, Sonnet 5.5 and Haiku 5.5, and 497 for Sonnet/Opus 4.6. — [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing)

**Long sessions (vendor documentation)**
- Claude Code sends the full conversation on every request, and every tool call triggers another request carrying that context.
- Usage climbs in long sessions for these reasons: long context, cache misses after idle periods longer than the TTL, scheduled loops, cross-session messages, goal check-ins, subagents, active teammates, and compaction itself (/compact reads the whole conversation).
- [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- The /usage breakdown has a sample recommendation, "Trim ~/code/api/CLAUDE.md · 49k tokens per request". This shows that instruction files can rival the harness's own overhead. — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Enterprise averages: about $13 per developer per active day and $150-250 per month, with 90% of users under $30 per active day. — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)

### Inferences
- For an orchestrator that spawns one fresh worker per ticket, each ticket pays three times:
  - the harness and config bootstrap (about 7k to 55k, depending on harness and CLAUDE.md/MCP/skills size);
  - re-exploration of the codebase (the Explore phase, a large share of rounds);
  - the cache-write premium, because each new agent starts a new cache prefix.

  These costs are mostly invisible per ticket, but they add up roughly linearly with ticket count.
- Trimming the per-agent bootstrap probably helps fan-out designs most, since the saving multiplies by the number of agents. Shorter instruction files, fewer MCP servers and a lighter harness for workers all reduce it.
- Raw "total input tokens" figures overstate cost when caching is active. Budget in cache-weighted tokens or dollars (see Q4).

### Gaps
- I found no independent, peer-reviewed measurement of Codex CLI's fixed per-session overhead comparable to the Systima numbers for Claude Code and OpenCode.
- The 54k vs ~16k subagent-preamble discrepancy is not reconciled in a controlled study. Both are single-practitioner measurements.
- I found no published breakdown of how many tokens review loops consume in coding agents specifically. The phase data covers Explore/Fix/Setup, not reviewer passes.

## Q2. Spawn-per-task vs long-lived workers vs single agent with occasional delegation

### Takeaway
The evidence leans toward a single agent or a few long-lived threads that hold the write path. Delegation should be selective: read-heavy exploration, verbose operations, or independent review, each returning compressed summaries. Fan-out multi-agent setups cost several times more tokens. They pay off mainly when the work truly parallelizes, which Anthropic itself says is less true of coding than of research. Anthropic and Cognition (2026) now converge on the same rule: writes single-threaded, extra agents contribute read-only intelligence such as review and research.

### Cited Findings
**Cost of multi-agent (evidence)**
- Multi-agent research uses about 15x chat tokens. Multi-agent Opus 4 with Sonnet 4 subagents beat single-agent Opus 4 by 90.2% on Anthropic's internal research eval.
- Anthropic warns that "most coding tasks involve fewer truly parallelizable tasks than research", and that domains with shared context or tight inter-agent dependencies are a poor fit.
- [Anthropic, 13 Jun 2025](https://www.anthropic.com/engineering/multi-agent-research-system)
- Effort-scaling rules from that system:
  - simple query: 1 agent with 3-10 tool calls;
  - comparison: 2-4 subagents with 10-15 calls each;
  - complex research: more than 10 subagents.
  - [Anthropic, 13 Jun 2025](https://www.anthropic.com/engineering/multi-agent-research-system)
- Upgrading Sonnet 3.7 to Sonnet 4 gave more gain than doubling the token budget on Sonnet 3.7. Model choice beats brute-force tokens. — [Anthropic, 13 Jun 2025](https://www.anthropic.com/engineering/multi-agent-research-system)
- Claude Code docs say agent teams use about 7x more tokens than standard sessions when teammates run in plan mode, with usage "roughly proportional to team size". — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Amazon/UT Austin (Jan 2026; arXiv 2601.12307) compared one LLM role-playing a homogeneous multi-agent workflow over multi-turn conversation against true multi-agent execution:
  - The single agent matched or beat the multi-agent version at 50-90% lower cost, for example HumanEval 92.1% at $0.020.
  - The saving comes from KV-cache reuse: prefill "scale[s] with incremental growth rather than the full prefix."
  - Limitation: the result does not cover heterogeneous-model workflows.
  - [Rethinking the Value of Multi-Agent Workflow](https://arxiv.org/html/2601.12307v1)
- Survey and aggregate claims (search-snippet level, not fully reviewed):
  - Single-agent setups match multi-agent accuracy while cutting tokens by 54% and latency by 50% on average.
  - Multi-agent systems consume 4-220x more tokens than single-agent counterparts.
  - [arXiv 2601.04748: When Single-Agent with Skills Replace Multi-Agent Systems](https://arxiv.org/pdf/2601.04748)
  - [arXiv search summary](https://arxiv.org/html/2610.08155v1)
- S1-MAS (Oct 2026) gives bounded coordination decisions to lightweight "System One" models and keeps capable LLMs for open-ended work. It reports a 44.9-97.2% reduction in GPT-4o tokens and 37.8-93.0% lower latency. — [arXiv 2610.08155](https://arxiv.org/abs/2610.08155v1) (abstract-level)

**Quality and coherence arguments**
- Cognition (12 Jun 2025, opinion from production experience) set out two principles: "Share context, and share full agent traces, not just individual messages", and "Actions carry implicit decisions, and conflicting decisions carry bad results".
  - It recommends single-threaded linear agents, with a context-compression LLM for long tasks.
  - It notes that Claude Code subagents at the time never ran in parallel and only answered questions rather than doing independent writes.
  - [Cognition: Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)
- Cognition follow-up (Apr 2026): "multi-agent systems work best today when writes stay single-threaded and additional agents contribute intelligence rather than actions." Three patterns work:
  - a review agent that deliberately gets only the diff and no prior context (Devin Review averages 2 bugs per PR, 58% severe);
  - "smart friend" escalation from a cheaper model to a stronger one, which worked better across model families (Claude and GPT) than as a weak-to-strong pairing, and still needed both models to be strong;
  - hierarchical manager/child delegation for week-long, multi-PR tasks.

  Remaining open problems are all about cross-agent communication.
  - [ZenML LLMOps summary of Cognition "Multi-agents working"](https://www.zenml.io/llmops-database/multi-agent-systems-in-production-code-generation-and-review-at-scale)
  - Original: [cognition.ai/blog/multi-agents-working](https://cognition.ai/blog/multi-agents-working) (not fetched directly)
- Anthropic context engineering (29 Sep 2025): subagents may use "tens of thousands of tokens or more" but return "a condensed, distilled summary of its work (often 1,000-2,000 tokens)". This keeps the lead's context clean. — [Anthropic: Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

**Break-even rule for delegation (practitioner evidence, Aug 2026)**
- Reading N tokens inline costs about 3N effective tokens, because the content is re-sent as cache reads on later requests. A working subagent costs about 100k effective. Delegation therefore breaks even around N of about 33k, and the author rounds the threshold up to 40-50k tokens of material to discourage casual spawns. — [DEV: rulestack](https://dev.to/rulestack/we-said-a-claude-code-subagent-costs-436k-tokens-a-cleaner-measurement-says-54k-here-is-what-37am)

### Inferences
- The user's old design was "one fresh agent per ticket". It is the most expensive point on the spectrum: bootstrap plus re-discovery plus a cold cache for every ticket, with no shared KV/prompt-cache reuse.
- Better default: keep one long-lived worker session per area or epic and batch related tickets into it, so codebase knowledge and the cached prefix are reused. Use /clear or a new session only when switching to unrelated work.
- Fresh agents fit where isolation is the point:
  - an independent reviewer that sees only the diff;
  - one-shot verbose tasks, such as running a test suite or reading big logs, where the output would otherwise pollute the main context;
  - truly independent parallel tickets.
- Keep the write path single-threaded per area to avoid conflicting implicit decisions (Cognition). Parallelism belongs to read-only work or to disjoint modules.

### Gaps
- I found no controlled study comparing "long-lived worker with batched tickets" against "fresh agent per ticket" on a coding benchmark with both cost and quality measured. The recommendation is inferred from cache economics, the single-vs-multi studies and vendor guidance.
- OpenAI's agent-building guides were not re-fetched in this pass. I have no updated 2026 quantitative statement from OpenAI on single vs multi-agent.

## Q3. Techniques to cut tokens without losing quality

### Takeaway
The highest-leverage techniques are:
- keep cacheable prefixes stable and warm (cache hits cost 2.5-10% of base input);
- shrink fixed context: lazy-load tools and skills, short CLAUDE.md/AGENTS.md, CLI instead of MCP;
- avoid re-exploration with repo maps or skills and code-intelligence (LSP) tools;
- filter verbose tool output before it enters context;
- hand off through files plus compact structured summaries;
- route bounded work to cheap models.

Tool search and code execution each show 37-98% reductions in vendor tests.

### Cited Findings
**Prompt caching (evidence and pricing)**
- Claude cache-read price relative to base input:
  - standard: 0.1x;
  - Opus 5.5 and Sonnet 5.5: 5% ($0.20 and $0.10/MTok);
  - Fable 5.1 and Mythos 5.1: 2.5% ($0.25/MTok).

  Cache writes cost 1.25x for a 5-minute TTL (pays off after 1 read) or 2x for a 1-hour TTL (pays off after 2 reads). Multipliers stack with the 50% Batch discount.
  - [Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- Manus (Jul 2025) quotes a 10x difference between cached and uncached input on Sonnet ($0.30 vs $3/MTok). Its practices:
  - stable prompt prefix (no timestamps at the top);
  - append-only context;
  - deterministic JSON serialization, because key-order changes silently break the cache;
  - "mask, don't remove" tools mid-task, because changing tool definitions invalidates the cache.
  - [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Claude Code now reports cache statistics in /usage (v2.1.251+): request count, percentage of input served from cache, misses with their likely cause (e.g. "tool definitions changed", v2.1.260+), expected rebuilds after compaction or tool-result clearing, and warm/cold state with the TTL (a 1h TTL is shown in the example). These stats cover the main conversation only, not subagents. — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- The Systima measurement found Claude Code's prefix varied between sessions while OpenCode's stayed byte-identical. A harness's own prefix stability is a real cost lever. — [Systima](https://systima.ai/blog/claude-code-vs-opencode-token-overhead)
- OpenAI GPT-5.5 cached input is $0.50/MTok against $5 uncached, a 90% discount (third-party pricing aggregator, 2026). — [MorphLLM OpenAI API pricing](https://www.morphllm.com/openai-api-pricing)
- Cross-model limitation: KV and prompt caches are per model, so heterogeneous workflows cannot share caches. Every hop between models (Claude to Codex to a cheap model) re-pays the prefill. — [arXiv 2601.12307](https://arxiv.org/html/2601.12307v1)

**Tool-schema reduction (evidence)**
- Anthropic's Tool Search Tool (24 Nov 2025):
  - context before any work drops from about 77K to about 8.7K tokens (85% reduction; 191.3K vs 122.8K context left);
  - accuracy improves on Opus 4 (49% to 74%) and Opus 4.5 (79.5% to 88.1%).
  - [Anthropic: Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- Programmatic Tool Calling, where the model writes code that calls tools and only final results enter context, cut average tokens from 43,588 to 27,297 (37%) on complex research tasks. Accuracy also rose: 25.6% to 28.5% on internal knowledge retrieval and 46.5% to 51.2% on GIA. — [Anthropic: Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- Tool-use examples raised accuracy on complex parameters from 72% to 90%. This is a quality lever that also reduces retry loops. — [Anthropic: Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- Code execution with MCP: 150K to 2K tokens (98.7%) on a sample workflow. — [Anthropic, 4 Nov 2025](https://www.anthropic.com/engineering/code-execution-with-mcp)
- Claude Code (Oct 2026) defers MCP tool definitions by default, so only names and server instructions load until a tool is used. The docs still say CLI tools (gh, aws, gcloud, sentry-cli) "are still more context-efficient than MCP servers". — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)

**Shrinking fixed context and avoiding exploration (vendor guidance)**
- Keep CLAUDE.md under about 200 lines and move workflow-specific instructions into skills, which load on demand. A "codebase-overview" skill lets the agent skip exploratory file reads. — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Code-intelligence (LSP) plugins replace grep plus reading several candidate files with a single go-to-definition call, and they report type errors after edits. — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Specific prompts ("add input validation to the login function in auth.ts") avoid the broad scanning that vague prompts trigger. — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Codex docs give the same advice: be precise and drop unneeded context, point the agent at relevant files only, control AGENTS.md size with nested files, and limit active MCP servers. — [Codex pricing / usage docs](https://learn.chatgpt.com/docs/pricing)
- Just-in-time retrieval: keep lightweight identifiers (paths, queries, links) and load content at runtime rather than preloading. — [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

**Limiting tool output (vendor guidance with a concrete mechanism)**
- A PreToolUse hook can rewrite test commands to `... 2>&1 | grep -A 5 -E '(FAIL|ERROR|error:)' | head -100`. Grepping a 10,000-line log this way cuts context "from tens of thousands of tokens to hundreds." — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Tool-result clearing is described as the "safest lightest touch" form of compaction. — [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)

**Compaction, memory and handoff files**
- Compaction summarizes near the context limit, keeping architectural decisions and unresolved issues. — [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Custom compaction instructions are supported, either `/compact Focus on ...` or a "Compact instructions" section in CLAUDE.md.
- Note: /compact is itself a large request, while /clear costs nothing. Use /rename plus /resume to return to earlier sessions.
- [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Structured note-taking and memory outside the context window, such as progress notes, keeps critical state across thousands of steps. — [Anthropic: Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Manus treats the filesystem as unlimited persistent context. It keeps file paths and URLs in context when dropping their contents, so compression is reversible, and it re-states objectives through a todo.md file to fight lost-in-the-middle. — [Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Anthropic's research system has subagents write outputs to the filesystem and pass lightweight references back, avoiding a "game of telephone". Parallel tool calling cut research time by up to 90%. — [Anthropic, Jun 2025](https://www.anthropic.com/engineering/multi-agent-research-system)

**Model routing**
- Use Sonnet for most coding and agent-team teammates, keep Opus for complex architecture work, and set `model: haiku` for simple subagents. Subagents inherit the session model unless one is specified. — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Thinking tokens bill as output and can reach tens of thousands per request. Lower /effort for simple tasks, or set MAX_THINKING_TOKENS on fixed-budget models. Thinking cannot be turned off on Opus 5.5, Sonnet 5.5, Haiku 5.5 or the Fable models. — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Caveat: Cognition found that cheap-to-strong "smart friend" escalation needed both models to be strong, which eroded the savings. — [ZenML summary of Cognition](https://www.zenml.io/llmops-database/multi-agent-systems-in-production-code-generation-and-review-at-scale)
- The S1-MAS idea is to use small models for bounded coordination decisions (routing, checks) and large models for open-ended work. It reports 45-97% token reductions. — [arXiv 2610.08155](https://arxiv.org/abs/2610.08155v1)

**Session fork/resume**
- Claude Code supports /resume of named sessions. A practitioner article compares what `/fork`, `/subtask` and `subagent_type: "fork"` each copy; a fork inherits the parent context, so it skips re-discovery but carries the full context cost. — [Claude Code docs: costs](https://code.claude.com/docs/en/costs); [DEV: Claude Code fork vs subagent](https://dev.to/rulestack/claude-code-fork-vs-subagent-what-fork-subtask-and-subagenttype-fork-each-copy-229a) (title-level, not fully reviewed)

### Inferences
- Concrete orchestrator design implied by the evidence:
  1. Have the orchestrator write a compact task brief (goal, files, acceptance tests, constraints) and require workers to return a structured summary of 1-2k tokens plus a handoff file path, not transcripts.
  2. Keep a persistent repo map / codebase-overview skill and a progress/decisions file that every worker reads first, so workers don't re-explore.
  3. Batch related tickets into one long-lived worker per module to keep the prompt cache warm. Keep idle gaps under the cache TTL, or use the 1h TTL.
  4. Use fresh, minimal-config workers (small CLAUDE.md, no unneeded MCP, a lighter harness such as OpenCode for cheap models) for isolated verbose or parallel jobs.
  5. Filter test and log output through hooks or scripts.
  6. Use a diff-only reviewer agent.
  7. Route mechanical tickets to cheap models, and escalate on failure using test results as the signal.
- When orchestrator and workers share a provider and model, keeping the system prompt, tools and project-context block byte-identical across delegated calls should let workers reuse cached prefixes. Across models there is no reuse.

### Gaps
- I found no quantitative study of repo-map tools (e.g. Aider-style repo maps, code-search MCPs) measuring token savings on coding benchmarks in 2026.
- No measured data was found on how much "batching related tickets into one session" saves versus spawn-per-ticket. It is inferred, not measured.
- No published quality impact of compaction on coding-agent success rates was found.

## Q4. Measuring and budgeting tokens per agent/task

### Takeaway
Claude Code exposes per-session and attributed usage (/usage, with breakdown by skills, subagents, plugins and MCP servers), cache-hit statistics, OpenTelemetry export, a status line cost field, `--max-budget-usd`, and workspace or org spend limits. Codex exposes plan usage and credits. Budgets should be set in cache-weighted tokens or dollars, not raw input tokens. Models cannot predict their own costs, so guardrails need to be external.

### Cited Findings
- /usage shows session tokens by model (input, output, cache read, cache write) and a list-price dollar estimate.
  - On subscription plans it attributes usage to skills, subagents, plugins and individual MCP servers, and suggests fixes behind 10% or more of usage (e.g. trimming CLAUDE.md, lowering effort). There is a 24h/7d toggle and an `f` shortcut to apply fixes (v2.1.305+).
  - Prompt-cache stats cover the main conversation only, not subagents.
  - [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- The `--max-budget-usd` CLI flag caps spend; the status line exposes cost and duration. — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Org-level spend controls and APIs:
  - OpenTelemetry export works on every setup and is "the only option that streams per-user token and cost metrics into your own observability stack in near real time";
  - the Claude Code Analytics API (Console) and the Enterprise Analytics API (Enterprise) provide per-user numbers;
  - workspace spend limits apply on the API;
  - the LiteLLM gateway tracks spend per virtual key;
  - a `modelPricing` managed setting makes reported costs match contracted rates (v2.1.242+).
  - [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Recommended per-user rate limits by team size: 200k-300k TPM for 1-5 users, falling to 10k-15k TPM for 500+ users. — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Background usage is under about $0.04 per session. — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)
- Measurement pitfall: summing total input tokens per request without discounting cache reads overstated a subagent's cost by about 8x (436k vs 54k). — [DEV: rulestack](https://dev.to/rulestack/we-said-a-claude-code-subagent-costs-436k-tokens-a-cleaner-measurement-says-54k-here-is-what-37am)
- Self-prediction of token use correlates at most about 0.39 with actual use, with systematic underestimation. The authors suggest it only as a coarse early-warning signal. — [arXiv 2604.22750v3](https://arxiv.org/html/2604.22750v3)
- Codex docs say "a typical GPT-5.6 Sol task may use 2-15 credits" and list credit costs per 1M tokens per model. Plan usage and credits are the budgeting unit for subscription users. — [Codex pricing docs](https://learn.chatgpt.com/docs/pricing)

### Inferences
- Per-agent budget guardrail: launch workers non-interactively with `--max-budget-usd`, or a turn limit, per ticket. Log each worker's usage (OTel or the session JSONL) tagged with the ticket ID. Kill or escalate when a worker exceeds roughly 2-3x the median for its ticket class, since high-cost runs correlate with failure and redundant file views.
- Track cache-hit percentage per worker. A low hit rate signals an unstable prefix or idle gaps longer than the TTL.

### Gaps
- Exact OpenTelemetry metric and attribute names for Claude Code (from the monitoring-usage doc) and Codex were not fetched in this pass. Verify in [Claude Code monitoring docs](https://code.claude.com/docs/en/monitoring-usage).
- ccusage and OpenCode's built-in stats were not researched directly. I have no sourced details on their features or accuracy.

## Q5. Pricing and subscription limits (Oct 2026) relevant to design

### Takeaway
List prices in Oct 2026 vary by more than two orders of magnitude, from Haiku 5.5 at $0.10/MTok input to Fable/Mythos at $10 input and $50 output. Cache reads on newer Claude models cost 2.5-5% of base input, so stable, warm prefixes are worth more than ever. Open models on OpenRouter cost roughly $0.07-0.74 input and $0.18-3.50 output per MTok. Subscription plans meter by rolling 5-hour and weekly windows (Claude) or messages and credits (Codex). Under those plans, spawn overhead burns the limit window rather than dollars.

### Cited Findings
**Claude API list prices, per MTok: input / 5m cache write / 1h cache write / cache read / output** ([Claude API pricing](https://platform.claude.com/docs/en/about-claude/pricing), fetched 2026-10-21)

| Model | Input | 5m write | 1h write | Cache read | Output |
|---|---|---|---|---|---|
| Fable 5.1 / Mythos 5.1 | $10 | $12.50 | $20 | $0.25 | $50 |
| Fable 5 / Mythos 5 | $10 | $12.50 | $20 | $1 | $50 |
| Opus 5.5 | $4 | $5 | $8 | $0.20 | $20 |
| Opus 5 / 4.8 / 4.7 / 4.6 / 4.5 | $5 | $6.25 | $10 | $0.50 | $25 |
| Sonnet 5.5 | $2 | $2.50 | $4 | $0.10 | $10 |
| Sonnet 5 | $2 | $2.50 | $4 | $0.20 | $10 |
| Sonnet 4.6 / 4.5 | $3 | $3.75 | $6 | $0.30 | $15 |
| Haiku 5.5 (prompt ≤100k) | $0.10 | $0.125 | $0.20 | $0.01 | $0.50 |
| Haiku 5.5 (prompt >100k) | $0.50 | $0.625 | $1 | $0.05 | $2.50 |
| Haiku 4.5 | $1 | $1.25 | $2 | $0.10 | $5 |

- Mythos is limited availability. Batch API is 50% off.
- Claude 4.6+ models (except Haiku 5.5) get the 1M context at standard pricing. Haiku 5.5 is priced by prompt length, and a prompt over 100k pays the higher rate even when part of it is a cache hit.
- Fast mode on Opus 5.5 costs $8 input / $40 output per MTok.
- US-only inference adds a 1.1x multiplier.

**OpenAI**
- GPT-5.5 costs $5 input, $0.50 cached and $30 output per MTok for prompts up to 272K tokens, and $10 / $45 above that. Batch is $2.50 / $15. (Third-party aggregator, 2026.) — [MorphLLM](https://www.morphllm.com/openai-api-pricing)
- Codex plan limits (official docs fetched 2026-10-21; model names have changed and the page appears to be mid-update):
  - Plus and Standard Business have 5-hour rolling limits per model: GPT-6 Astra 5-45 local messages, GPT-6.1 Sol 15-160, GPT-6 Luna 350-3,000.
  - Pro tiers ($100/$200/$500) currently have no fixed 5-hour limit.
  - Credits per 1M tokens: Astra 250 input / 1,250 output; Sol 50 / 250; Luna 2.5 / 12.5.
  - Fast and Ultrafast modes consume limits at 2.5x and 8x.
  - [Codex pricing docs](https://learn.chatgpt.com/docs/pricing)
  - CONFLICT: the same page mentions "GPT-5.6 Sol". A June 2026 third-party source lists GPT-5.5 at 15-80 messages per 5h on Plus, 80-400 on Pro 5x and 300-1,600 on Pro 20x ([MorphLLM comparison, Jun 2026](https://www.morphllm.com/comparisons/claude-code-vs-codex)). Another source reports OpenAI "removed Codex's 5-hour limit" ([eesel](https://www.eesel.ai/blog/gpt-remove-5-hour-limits)). Treat the exact Codex numbers as volatile and re-check before relying on them.

**Open models via OpenRouter (aggregator data, Oct 2026; prices vary by provider)** ([TeamDay: OpenRouter top models Oct 2026](https://www.teamday.ai/blog/top-ai-models-openrouter-2026); [DevelopersDigest open-weights coding showdown](https://www.developersdigest.tech/blog/glm-5-2-vs-deepseek-v4-vs-qwen3-open-weights-coding-showdown); [OpenRouter DeepSeek](https://openrouter.ai/deepseek))

| Model | Input $/MTok | Output $/MTok |
|---|---|---|
| DeepSeek V4 Pro | 0.435 | 0.87 |
| DeepSeek V4 Flash | 0.09 | 0.18 |
| DeepSeek V4.1 Flash (17 Oct 2026) | 0.07 | 0.50 |
| Kimi K2.7 Code | 0.74 | 3.50 |
| Kimi K2.6 | 0.465 | 2.45 |
| Kimi K2.5 | 0.45 | 2.25 |
| GLM-5.2 (provider median) | ~0.55 | ~1.85 |
| GLM 4.6 | 0.43 | 1.75 |
| GLM 4.5 Air | 0.13 | 0.85 |
| Qwen3 Coder | 0.22 | 1.80 |

Values are from search-result summaries and were not each verified on OpenRouter model pages.

**Subscription mechanics (Claude)**
- On Team/Enterprise, Claude Code usage draws from a per-seat allowance that resets on a rolling 5-hour window and a weekly window. The allowance is shared with Claude chat and Cowork. Session and weekly limits apply across all models, so switching models does not restore access; model-specific Opus/Sonnet limits are separate. Usage credits allow overage with spend limits. — [Claude Code docs: Manage costs](https://code.claude.com/docs/en/costs)

**Efficiency vs price caveat**
- Per-token price is not per-task cost. Kimi-K2 and Sonnet 4.5 used over 1.5M more tokens per SWE-bench task than GPT-5. — [arXiv 2604.22750v3](https://arxiv.org/html/2604.22750v3)

### Inferences
- With cache reads at about 5% of input on Opus 5.5 and Sonnet 5.5, a long-lived warm worker re-reading 100k of context costs about $0.01 per request on Sonnet 5.5. A fresh worker paying a 54k cache write at $2.50/MTok costs about $0.135 per spawn before any work. Under these prices, spawn and re-exploration dominate over context re-reads, which strengthens the case for long-lived, batched workers. (Arithmetic from the listed prices.)
- Cheap open models (about $0.1-0.7 input) are roughly 5-40x cheaper per token than Sonnet 5.5 or Opus 5.5 on input. Measured token-efficiency differences of 1.5M+ tokens per task mean routing must be judged per task by tests passed per dollar, not by sticker price.
- On subscription plans the binding constraint is the 5-hour or weekly window. Fixed per-spawn bootstrap therefore converts directly into lost work capacity.

### Gaps
- Independent verification of Haiku 5.5 pricing beyond the official page (the drop from $1 to $0.10 input is large) was not sought; it is reported as listed.
- Official OpenAI API pricing for current GPT-5.x/6 Codex models was not fetched directly; the figures come from aggregators.
- Claude Pro/Max plan-limit specifics (hours or tokens per window) were not found in a primary source in this pass.
