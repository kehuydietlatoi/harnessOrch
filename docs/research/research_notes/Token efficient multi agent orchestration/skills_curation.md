# Curating and Loading Predefined Skills for a Multi-Agent Coding Team (as of Oct 2026)

Method note: Both target repos were cloned on 2026-10-21 (mattpocock/skills @ `5beb35b`, 2026-10-19, plugin v1.3.1; cursor/plugins @ `190d287`, 2026-10-20, pstack v0.15.29). The locally installed copy is `mattpocock-skills` v1.2.3 (commit `84fdeff`, 2026-08-06) at `C:\Users\Hung\.claude\plugins\cache\claude-plugins-official\mattpocock-skills\1.2.3`. Byte sizes come from `wc -c`. Token figures use a ~4 chars/token heuristic, so they are estimates, not tokenizer counts. obra/superpowers, anthropics/skills and openai/skills were also cloned and measured the same way.

## (a1) mattpocock/skills: every skill, structure, size, role fit

### Takeaway
This is a small set of composable, opinionated engineering skills. The design carries the main token lesson: of the 27 skills the plugin ships, only 11 are model-invoked and put a description in context, about 2.3k chars or roughly 570 tokens in total. The other 16 set `disable-model-invocation: true` and cost nothing until a human types them. The most valuable skills for a team are diagnosing-bugs, tdd, code-review, codebase-design, domain-modeling, and to-spec/to-tickets + implement-spec. Several of these assume an issue tracker that `/setup-matt-pocock-skills` configures first.

### Cited Findings
- **Repo layout and policy.** Skills sit in bucket folders: `engineering/` (daily code work), `productivity/`, `misc/` (rarely used, not promoted), `in-progress/` (beta, not shipped in the plugin) and `deprecated/`. The Claude Code plugin ships only the promoted set from `engineering/` and `productivity/`. — [mattpocock/skills CLAUDE.md](https://github.com/mattpocock/skills/blob/main/CLAUDE.md)
- **Invocation is the main design axis.** A user-invoked skill sets `disable-model-invocation: true` in Claude Code and `policy.allow_implicit_invocation: false` in `agents/openai.yaml` for Codex, and gets a short human-facing description. A model-invoked skill keeps rich "Use when…" trigger text. The test is: "could the model usefully reach for this autonomously?" — [.agents/invocation.md](https://github.com/mattpocock/skills/blob/main/.agents/invocation.md)
- **The author states the token tradeoff directly.** "The description is the skill's top-level context pointer, forced to stay loaded at all times — permanent context load in exchange for discoverability… If it only ever fires by hand, make it user-invoked and pay no context load." A user-invoked "router skill" (`ask-matt`) cures the cognitive load of remembering many hidden skills. — [writing-for-agents/SKILL-MECHANICS.md](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL-MECHANICS.md)
- **Dependencies are prose, not deep links.** Skills call each other in prose ("Run a `/grilling` session") instead of linking `../other-skill/FILE.md`. Shared reference material lives inside the skill that owns it. — [.agents/invocation.md](https://github.com/mattpocock/skills/blob/main/.agents/invocation.md)
- **Per-skill structure.** Each skill has `SKILL.md`, a Codex `agents/openai.yaml` (about 100–170 B: display_name, short_description, optional policy), and optional flat reference files (for example `DEEPENING.md` and `ADR-FORMAT.md`) or scripts. References sit one level deep. — local files under `...\mattpocock-skills\1.2.3\skills\`
- **Installation.** Claude Code: `claude plugins install mattpocock-skills` (official marketplace, read-only, auto-updates). Codex and other agents: `npx skills@latest add mattpocock/skills`, which lets you pick individual skills and writes editable copies. "Installing both leaves you with every skill twice." No native Codex plugin exists yet. — [README](https://github.com/mattpocock/skills/blob/main/README.md)
- **Changes from v1.2.3 (local) to v1.3.1 (upstream).** Added `implement-spec`, `pr` and `retro` (engineering) and `chief-of-staff` (in-progress). Removed `resolving-merge-conflicts` ("the agent works through an in-progress merge or rebase conflict without a dedicated skill"). — [CHANGELOG 1.3.0/1.3.1](https://github.com/mattpocock/skills/blob/main/CHANGELOG.md)

**Skill inventory.** MI = model-invoked (its description always sits in context); UI = user-invoked (zero standing cost). Sizes are SKILL.md bytes and whole-folder bytes from the local v1.2.3 copy; upstream v1.3.1 sizes are within about ±5% unless marked. Role fit: P = planner/spec, I = implementer, R = reviewer, D = debugger, O = orchestrator/human-facing.

| Skill | Bucket | Inv | SKILL.md / total | What it does | Role |
|---|---|---|---|---|---|
| ask-matt | eng | UI | 11.6 KB (12.7 KB upstream) / 16.1 KB (+PHASE-BOUNDARIES.md) | Router: maps the user's situation to the right skill or flow | O |
| grill-with-docs | eng | UI | 0.25 KB | One line: run `/grilling` using `/domain-modeling` (writes ADRs and glossary) | P/O |
| triage | eng | UI | 6.7 KB / 19.8 KB (AGENT-BRIEF.md 8.2 KB, OUT-OF-SCOPE.md 4.8 KB) | State machine for issues and PRs; writes agent-ready briefs | O/P |
| improve-codebase-architecture | eng | UI | 6.1 KB / 13.1 KB (HTML-REPORT.md) | Scans for deepening opportunities, makes an HTML report, then grills | P/R |
| setup-matt-pocock-skills | eng | UI | 7.0 KB / 19.9 KB (tracker configs for GitHub/GitLab/local, labels, domain) | One-time repo setup: issue tracker, triage labels, doc layout | O (once) |
| tdd | eng | MI | 3.6 KB / 7.5 KB (tests.md, mocking.md) | Red-green-refactor and integration-test discipline | I |
| to-spec | eng | UI | 3.1 KB | Turns the conversation into a spec on the issue tracker, with no interview | P |
| to-tickets | eng | UI | 5.8 KB | Breaks a spec into tracer-bullet tickets with blocking edges | P |
| wayfinder | eng | UI | 12.0 KB (12.5 KB upstream) | Plans work larger than one session as a map of decision tickets | P/O |
| implement | eng | UI | 0.45 KB (0.64 KB upstream) | Implements a spec or tickets: uses tdd at agreed seams, runs typecheck/tests, then code-review, then commits | I |
| implement-spec (new 1.3.0) | eng | UI | 2.8 KB | Reads tickets as a task graph, runs implementer subagents in worktrees across the ready frontier, merges to one integration branch, closes with code-review | O/I |
| prototype | eng | MI | 3.0 KB / 16.3 KB (LOGIC.md 6.2 KB, UI.md 7.1 KB) | Throwaway prototype to answer a design question | P/I |
| research | eng | MI | 0.8 KB | Investigates against primary sources and writes a Markdown file | P |
| domain-modeling | eng | MI | 3.5 KB / 8.8 KB (ADR-FORMAT, CONTEXT-FORMAT) | Ubiquitous language in CONTEXT.md, plus ADRs | P |
| codebase-design | eng | MI | 6.6 KB / 12.0 KB (DEEPENING, DESIGN-IT-TWICE) | Deep-module vocabulary: seams, interfaces, testability | P/R |
| code-review | eng | MI | 6.7 KB | Reviews a diff since a fixed point on two axes (Standards vs Spec), using 2 parallel sub-agents | R |
| pr (new 1.3.0) | eng | MI | 4.3 KB / 5.0 KB | Shape of a PR body: visual summary, before/after evidence, merge-danger call | I/R |
| retro (new 1.3.0) | eng | UI | 4.4 KB | Session retrospective that changes the agent's environment (checks, steering files), not the code | O |
| resolving-merge-conflicts | eng | MI (removed in 1.3.0) | 0.9 KB | Resolves an in-progress merge or rebase | I |
| wizard | eng | MI | 4.2 KB / 13.1 KB (template.sh 8.8 KB) | Generates an interactive bash wizard for steps only a human can do | O |
| diagnosing-bugs | eng | MI | 9.1 KB / 10.6 KB (hitl-loop.template.sh) | Diagnosis loop for hard bugs and perf regressions | D |
| grill-me | prod | UI | 0.15 KB | One line: run `/grilling` | P/O |
| grilling | prod | MI | 1.9 KB | Relentless interview to stress-test a plan | P |
| handoff | prod | UI | 0.9 KB | Compacts the conversation into a handoff doc for another agent | O |
| teach | prod | UI | 9.6 KB / 18.3 KB (4 format refs) | Teaches the user a concept within the workspace | human |
| to-questionnaire | prod | UI | 3.0 KB | Turns an undecidable question into a questionnaire for someone else | O |
| wait-what | prod | UI | 0.3 KB | "That last message did not land — re-pitch it" | human |
| writing-for-agents | prod | MI | 11.0 KB / 13.8 KB (SKILL-MECHANICS.md) | How to write skills, AGENTS.md and CLAUDE.md | meta (skill authoring) |
| misc/git-guardrails-claude-code | misc | MI* | 2.4 KB / 3.1 KB (block-dangerous-git.sh) | Hooks that block git push, reset --hard and similar | O (setup) |
| misc/setup-pre-commit | misc | MI* | 2.4 KB | Husky, lint-staged, typecheck and tests | O (setup) |
| misc/migrate-to-shoehorn | misc | MI* | 2.9 KB | TS tests: replace `as` with shoehorn | I (niche) |
| misc/scaffold-exercises | misc | MI* | 3.7 KB | Course exercise scaffolding | niche |
| in-progress/{claude-handoff, loop-me, setup-ts-deep-modules, writing-beats, writing-fragments, writing-shape, chief-of-staff} | beta | UI | 1.3–7.7 KB each | Background handoff, workflow spec grilling, dependency-cruiser deep modules, article writing, long-running goal coordinated by subagents | mostly not coding roles |

*misc skills are not in the plugin manifest; their descriptions are model-facing only if you install them via skills.sh.

- **Aggregate cost (v1.3.1 plugin set).** 27 skills. 11 are model-invoked (diagnosing-bugs, tdd, prototype, research, domain-modeling, codebase-design, code-review, pr, wizard, grilling, writing-for-agents), with description+name ≈ 2,266 chars ≈ 570 tokens of standing cost. All 27 SKILL.md bodies together come to ≈128.6 KB ≈ 32k tokens if everything were loaded. — computed from [plugin.json](https://github.com/mattpocock/skills/blob/main/.claude-plugin/plugin.json) and the SKILL.md files.
- **Confirmed live on this machine.** This session's own skill listing for the v1.2.3 plugin shows exactly the 11 model-invoked skills (with resolving-merge-conflicts in place of pr). The UI-only skills (implement, to-spec, triage, etc.) do not appear, which matches Claude Code hiding `disable-model-invocation` skills from the model. — observed in current Claude Code session context; mechanism per [Claude Code skills docs](https://code.claude.com/docs/en/skills)

### Inferences
- **Best fits per role.** Implementer: tdd, implement/implement-spec, pr. Reviewer: code-review (two axes, parallel sub-agents), codebase-design as review vocabulary. Debugger: diagnosing-bugs. Planner: grilling/grill-with-docs, domain-modeling, to-spec, to-tickets, wayfinder, prototype, research. Orchestrator: triage, implement-spec, handoff, retro.
- **Human-in-the-loop dependency.** grilling and its variants interview a human. In an unattended orchestrator they only make sense in a planner session that talks to the user, not in background workers.
- **Tracker dependency.** to-spec, to-tickets, triage, implement-spec and wayfinder expect `/setup-matt-pocock-skills` to have configured an issue tracker (GitHub, GitLab or local files). An orchestrator that ships them must either run setup or provide equivalent config, such as local-file tickets.
- **Skill-to-skill calls.** implement calls `Skill("tdd")` and `Skill("code-review")`. If a worker gets only `implement` without tdd and code-review installed, the chain breaks. Ship dependency closures, not single skills.

### Gaps
- The local v1.2.3 copy and upstream v1.3.1 differ. Per-file docs pages (`docs/`) were not measured because they do not ship to agent context.
- No tokenizer-exact counts. The chars/4 figure is an approximation (Claude tokenizers differ by model).

## (a2) cursor/plugins pstack: contents, philosophy, sizes, role mapping

### Takeaway
pstack (Lauren Tan, "poteto") is one large entry skill, `/poteto-mode` (20.5 KB SKILL.md plus 23 playbooks). It routes to 55 other skills, including 24 one-principle micro-skills, plus 2 subagents. Almost every skill is `disable-model-invocation: true`, so the always-on description cost is close to zero. The mode skill keeps an inline principles index and tells agents to *Read* leaf SKILL.md files by path on demand. In practice it is orchestrator-side skill routing built from plain files. It is Cursor-first and multi-model (Grok for code delegates, Opus 5.5 for judgment). Claude Code support comes through a generated adapter. There is no Codex or OpenCode adapter.

### Cited Findings
- **Identity.** pstack v0.15.29 by Lauren Tan, MIT. "if you want to go fast, go deep first… helps you write less, but higher quality code. rigorous agent workflows you can parallelize with confidence." The manifest declares `skills: ./skills/` and `agents: ./agents/`. There are no rules, commands, hooks or MCP. — [pstack/.cursor-plugin/plugin.json](https://github.com/cursor/plugins/blob/main/pstack/.cursor-plugin/plugin.json)
- **Philosophy.** "fearless parallelism… when you can go deep on one agent and trust it to write good, verifiable code, you can truly parallelize with confidence". There are deliberately no planning skills: "i don't believe in planning. the best spec is code." — [pstack README](https://github.com/cursor/plugins/blob/main/pstack/README.md)
- **Entry point.** `/poteto-mode` matches the task to one of 23 playbooks (investigation, bug fix, perf, hillclimb, runtime and trace forensics, feature, refactoring, prototype, visual parity, authoring a skill, eval, babysit, shipping, autonomous run, orchestrate, autopilot-full, autopilot-stack, session pickup, pause safely, multi-phase plan, worktree cleanup, opening a PR). It opens a todo list from the playbook steps and "routes to the other skills as the steps fire". — [README](https://github.com/cursor/plugins/blob/main/pstack/README.md)
- **Persistent mode.** In Cursor, Alt/Option+Enter turns a skill into a Custom Mode that "stays in context every turn until you exit the mode". Plain Enter attaches it to one message. — [README](https://github.com/cursor/plugins/blob/main/pstack/README.md); [Cursor skills docs](https://cursor.com/docs/skills)
- **Principles index.** "twenty-four short skills, one principle each. `poteto-mode` indexes them inline and reads that index at task start. the standalone files are there so other skills can reference a principle by name." poteto-mode instructs: "Read the leaf skill in full for any principle you apply… Cite only principles whose leaf SKILL.md you read this session." — [README](https://github.com/cursor/plugins/blob/main/pstack/README.md); [poteto-mode/SKILL.md](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md)
- **Subagents.** `poteto-agent` is a background delegate that "Reads the `poteto-mode` skill's SKILL.md in full before any work". Substituting generalPurpose "skips that read and drifts". It gets the absolute path from its parent. `comment-sicko` is a read-only comment-deletion reviewer. — [agents/poteto-agent.md](https://github.com/cursor/plugins/blob/main/pstack/agents/poteto-agent.md), [agents/comment-sicko.md](https://github.com/cursor/plugins/blob/main/pstack/agents/comment-sicko.md)
- **Delegation defaults.** "`run_in_background: true`… **file pointers not inlined context**, explicit model per role… Defaults `grok-4.7-xhigh-fast` for code, `claude-opus-5-5-xhigh` for prose and judgment." Also: "Fresh subagents by default… with consolidated scope", and "You own every subagent's work. Review the diff and write your own summary." — [poteto-mode/SKILL.md §Subagents](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md)
- **Model routing is configurable.** `/setup-pstack` (the only model-invocable skill) writes an always-applied rule mapping roles (code, judgment, review panels, swarm workers) to models and a reasoning budget: `~/.cursor/rules/pstack-models.mdc`, or `~/.claude/rules/pstack-models.md` in Claude Code. — [README](https://github.com/cursor/plugins/blob/main/pstack/README.md); [docs/harness/claude-code.md](https://github.com/cursor/plugins/blob/main/pstack/docs/harness/claude-code.md)
- **Claude Code adapter.** Install with `/plugin marketplace add cursor/plugins` then `/plugin install pstack@cursor-plugins`. Commands get a `pstack:` prefix. A generated copy lives at `harness/pstack/`. The adapter maps Task to Agent, `readonly` to the Explore subagent, `environment: cloud` to `isolation: worktree`, and non-Claude model slugs to "omit model". Key line: "Run another pstack skill → `Read` `<pstack>/skills/<name>/SKILL.md` and follow it. **The `Skill` tool refuses most pstack skills.**" Cursor-only steps (Automations, Bugbot, cloud agents) are skipped with a one-line note. — [docs/harness/claude-code.md](https://github.com/cursor/plugins/blob/main/pstack/docs/harness/claude-code.md)
- **Not bundled.** `deslop`, `control-cli` and `control-ui` ship in `cursor-team-kit`. `/create-skill` is a Cursor built-in. Benny (Slack bug triage, repro and fix automations, three skills totalling ≈40 KB) is dormant and Cursor-Automations-only. — [README](https://github.com/cursor/plugins/blob/main/pstack/README.md)

**Inventory** (all `disable-model-invocation: true` except setup-pstack; SKILL.md / folder bytes):

| Skill | Size | What it does | Role |
|---|---|---|---|
| poteto-mode | 20.5 KB / 351 KB (23 playbooks 0.8–17 KB; most of the rest is TS scripts: orch store, watch-pr, check-plan) | Entry router and style. Non-negotiables, principles index, autonomy, subagents, reply style | O (all) |
| poteto-help | 15.6 KB / 22.5 KB | Help and router for humans | human |
| why | 9.0 KB / 53.6 KB (source playbooks for Slack, Linear, Notion, Sentry, Datadog, Databricks…) | Cited rationale via parallel MCP evidence queries | P/D |
| how | 2.7 KB / 7.0 KB | Subsystem walkthrough and placement questions | P/I |
| architect | 5.5 KB / 14.8 KB | Types, signatures and module shape before code; stays in the loop | P |
| arena | 4.6 KB | N parallel candidates, pick a base, graft the best parts | O |
| swarm | 2.8 KB | Fan out N workers, drain, one report | O |
| interrogate | 4.6 KB / 19.4 KB (rubric, reviewer prompt, code-quality review) | Multi-model adversarial review | R |
| blast-radius | 3.9 KB | What else a change can break; proves it by running code | R |
| tdd | 3.2 KB | Failing test first, only when cheap/requested | I/D |
| benchmark-checklist | 5.0 KB | Vets a perf number before reporting | D/R |
| no-comments | 2.7 KB (+ comment-sicko agent 2.3 KB) | Strip comments, encode constraints | R |
| unslop | 5.9 KB | Remove AI tells from prose | all (writing) |
| technical-writing | 9.2 KB | Diátaxis, Google style, STE standard | docs |
| typescript-best-practices | 2.8 KB / 12.4 KB | TS syntax-level rules | I |
| figure-it-out | 4.2 KB | Design an auditable playbook when none fits | O/P |
| show-me-your-work | 6.6 KB / 8.1 KB | TSV decision log for unattended runs | O |
| recall / ketchup | 5.4 / 6.5 KB | Rebuild context from history; catch the user up | O/human |
| reflect / correct | 4.8 KB (20.4 KB w/ 4 reviewer prompts) / 2.5 KB | Turn session learnings into skill edits; make repeated mistakes structurally impossible | O (meta) |
| create-/maintain-verification-skill | 6.6 / 5.0 KB | Generate and maintain a project-local "drive the app" verify skill | I/R |
| create-/maintain-formal-verification-skill | 5.2 / 7.1 KB | Model-check races, invariants and parsers | R (niche) |
| teach, sharpen, in-your-own-words, bro, automate-me, make-bot-ui, setup-pstack | 0.3–7.4 KB | Human-facing helpers, prompt sharpening, personal-mode authoring, Grok bot UI, model config | human/O |
| 24 × principle-* | 0.4–2.6 KB each (≈36 KB total) | laziness-protocol, foundational-thinking, redesign-from-first-principles, attack-the-premise, subtract-before-you-add, minimize-reader-load, outcome-oriented-execution, experience-first, exhaust-the-design-space, build-the-lever, model-the-domain, boundary-discipline, type-system-discipline, make-operations-idempotent, migrate-callers-then-delete-legacy-apis, separate-before-serializing-shared-state, prove-it-works, fix-root-causes, sequence-verifiable-units, test-behavior-not-implementation, explain-the-number, guard-the-context-window, never-block-on-the-human, encode-lessons-in-structure | All roles. Verification group suits R and D; architecture group suits P and I |

- **Aggregate cost.** 56 skills in `skills/`. Descriptions total ≈11.6k chars (≈2.9k tokens) if all were listed, but they are all hidden from the model except setup-pstack. SKILL.md bodies total ≈208 KB (≈52k tokens). A typical task pays poteto-mode at about 5k tokens, one playbook at 0.3–4k tokens, and a few leaf principles at 0.1–0.6k tokens each. — computed from the [pstack/skills](https://github.com/cursor/plugins/tree/main/pstack/skills) files

### Inferences
- **Role mapping.** Orchestrator: poteto-mode, swarm, arena, show-me-your-work, figure-it-out. Planner: architect, how, why. Implementer: tdd, typescript-best-practices, the architecture principles. Reviewer: interrogate, blast-radius, no-comments/comment-sicko, the prove-it-works principle. Debugger: why, benchmark-checklist, fix-root-causes, attack-the-premise, explain-the-number, and the bug-fix/perf/forensics playbooks.
- **Portability.** pstack is the less portable of the two. It names Cursor tools (Task, AskQuestion, `environment: cloud`), Grok models and Cursor-only features. Reusing it in Codex or OpenCode means writing an adapter like `docs/harness/claude-code.md` or porting only the tool-neutral leaf skills (principles, interrogate rubric, blast-radius, benchmark-checklist).
- **Reusable pattern.** The router-plus-hidden-leaf-library pattern is the main transferable idea for a token-efficient orchestrator, more than any single skill.

### Gaps
- Not verified: whether pstack's Cursor-side `disable-model-invocation` skills are still readable by subagents in Cursor without the path (poteto-agent searches `~/.cursor/plugins/` as a fallback, which suggests they are hidden from the catalog).
- No measured data on how often poteto-mode actually reads leaf principles in practice.

## (a3) Overlap, gaps, and the most valuable items for an orchestrated team

### Takeaway
The two sets complement each other. mattpocock is strong on alignment and planning: grilling, domain language, spec → tickets → implement-spec, plus a simple two-axis review. pstack is strong on execution rigor and verification: playbooks, multi-model adversarial review, blast radius, benchmark vetting, principles, and fan-out/arena. Both independently use hidden user-invoked skills plus a router.

### Cited Findings
- **Direct overlaps.**
  - tdd exists in both. Matt's is MI and always test-first. pstack's is user-invoked and conditional: "Use only when the user explicitly asks… OR when the bug has an obvious cheap local test target". — [mattpocock tdd](https://github.com/mattpocock/skills/blob/main/skills/engineering/tdd/SKILL.md); [pstack tdd](https://github.com/cursor/plugins/blob/main/pstack/skills/tdd/SKILL.md)
  - teach, prototype (a pstack playbook) and routers (ask-matt vs poteto-help) also overlap. — same repos
- **Review.** Matt's code-review = Standards and Spec axes in 2 parallel sub-agents. pstack's interrogate = multiple LLM reviewers "from independent angles", plus blast-radius and comment-sicko. — [code-review](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md); [interrogate](https://github.com/cursor/plugins/blob/main/pstack/skills/interrogate/SKILL.md)
- **Planning stance.** Matt: "grilling session… Use them _every_ time you want to make a change". pstack: "i don't believe in planning. the best spec is code." — [mattpocock README](https://github.com/mattpocock/skills/blob/main/README.md); [pstack README](https://github.com/cursor/plugins/blob/main/pstack/README.md)
- **Multi-agent execution.** Matt's implement-spec runs implementer subagents in worktrees over a ticket task graph onto one integration branch. pstack has the swarm, arena and orchestrate/autopilot playbooks. — [CHANGELOG 1.3.0](https://github.com/mattpocock/skills/blob/main/CHANGELOG.md); [pstack README](https://github.com/cursor/plugins/blob/main/pstack/README.md)

### Inferences
**Recommended "core shipped set" for an orchestrator**, about 15 items, each bound to a role:
- Planner: grilling (interactive sessions only), domain-modeling, to-spec, to-tickets, pstack architect.
- Implementer: mattpocock tdd, implement (adapted to the orchestrator's tracker), pr; pstack principles model-the-domain, boundary-discipline, type-system-discipline and laziness-protocol, as a short combined "implementer principles" file.
- Reviewer: mattpocock code-review (Standards vs Spec maps neatly to a reviewer worker given the ticket); pstack interrogate rubric (single model or multi-model) and blast-radius; principles prove-it-works and test-behavior-not-implementation.
- Debugger: mattpocock diagnosing-bugs; pstack benchmark-checklist; principles fix-root-causes, attack-the-premise and explain-the-number.
- Orchestrator only: pstack swarm/arena patterns, show-me-your-work (decision log), principle guard-the-context-window; mattpocock handoff and triage's AGENT-BRIEF.md (a template for worker briefs).

**What to skip or leave optional:**
- Human-facing items: teach, wait-what, bro, ketchup, sharpen, in-your-own-words.
- Writing skills, unless the orchestrator produces docs.
- Cursor-only items: benny, make-bot-ui, setup-pstack.
- Niche items: formal verification, shoehorn, scaffold-exercises.
- Superseded: resolving-merge-conflicts (removed upstream).

**Gaps in both sets:**
- No explicit security-review skill.
- No dependency/upgrade skill.
- No "write the brief for a worker" skill for non-Claude agents, apart from triage's AGENT-BRIEF.md.
- No cross-harness adapter for Codex or OpenCode in pstack.

### Gaps
- No usage or eval data comparing the two review approaches. I found no independent benchmark of either repo.

## (b) Token mechanics of skill loading across harnesses

### Takeaway
Under the open SKILL.md standard, every harness pays a standing cost per *visible* skill (name, description and sometimes path) on every turn. The body costs only when a skill is invoked, but then it stays in the conversation. Hidden or user-invoked skills cost zero until called, and every major harness has a switch for that. Subagent preloading and Cursor "custom mode" pay the full body up front. The real bloat risks are (1) many model-invoked descriptions, (2) bodies that persist after use, (3) session-start hooks that inject skill text (superpowers), and (4) per-turn tool, subagent and MCP descriptions.

### Cited Findings
- **Open standard (agentskills.io).**
  - Fields: `name` (≤64 chars, lowercase-hyphen, must match the directory) and `description` (≤1024 chars). Optional: `license`, `compatibility` (≤500), `metadata`, experimental `allowed-tools`.
  - Progressive disclosure: "Metadata (~100 tokens)… loaded at startup for all skills; Instructions (< 5000 tokens recommended)… loaded when the skill is activated; Resources (as needed)". "Keep your main SKILL.md under 500 lines." File references go one level deep.
  - — [agentskills.io/specification](https://agentskills.io/specification)
- **Anthropic engineering post.** Three-level disclosure. "the amount of context that can be bundled into a skill is effectively unbounded" because agents read files on demand. Install "only from trusted sources" and audit others. Published 16 Oct 2025; the open standard was announced 18 Dec 2025. — [Anthropic Engineering](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- **Claude Code: listing.** "skill descriptions are loaded into context so Claude knows what's available, but full skill content only loads when invoked." Combined `description` + `when_to_use` is "truncated at 1,536 characters in the skill listing". `/context` shows how much space descriptions take. — [Claude Code skills docs](https://code.claude.com/docs/en/skills)
- **Claude Code: visibility controls.**
  - `disable-model-invocation: true` gives "Description not in context". `user-invocable: false` keeps the description but hides the skill from the `/` menu. — [Claude Code skills docs](https://code.claude.com/docs/en/skills)
  - `skillOverrides` in settings sets per-skill states without editing the SKILL.md: `"on"` (name and description), `"name-only"`, `"user-invocable-only"` (hidden from the model) or `"off"`.
  - `skillListingBudgetFraction` (example 0.15) reserves context for the listing, and `skillListingMaxDescChars` (example 500) caps each description. Both default to unset. `enabledPlugins` toggles plugins per scope.
  - — [skills docs](https://code.claude.com/docs/en/skills); [settings reference](https://code.claude.com/docs/en/settings-reference)
- **Claude Code: default listing budget (third-party, not confirmed).** "1% default budget being approximately 2,000 tokens for a 200K context window model and approximately 10,000 tokens for a 1M context window model". The `SLASH_COMMAND_TOOL_CHAR_BUDGET` env var overrides it. — [claudefa.st skill-listing-budget](https://claudefa.st/blog/guide/mechanics/skill-listing-budget). The official settings reference I fetched lists the keys with default "unset" and does not state the 1% figure or the env var, so treat both as unconfirmed.
- **Claude Code: persistence and compaction.**
  - After invocation, "The rendered SKILL.md content enters the conversation as a single message and stays there across later turns."
  - On auto-compaction, Claude Code "re-attaches the most recent invocation of each skill after the summary, keeping the first 5,000 tokens of each… combined budget of 25,000 tokens".
  - Re-invoking with identical content adds only a short note.
  - — [Claude Code skills docs](https://code.claude.com/docs/en/skills)
- **Claude Code: isolation and scoping.**
  - `context: fork` + `agent:` runs a skill in an isolated subagent, so the body does not land in the main thread.
  - `paths:` globs make a skill auto-load "only when working with files matching the patterns".
  - Skill-level `model` and `effort` overrides exist.
  - — [Claude Code skills docs](https://code.claude.com/docs/en/skills)
- **Claude Code: subagents.**
  - The `skills:` frontmatter "full content… is injected into the subagent's context at startup". Up to 32 skills.
  - You "can't preload skills that set `disable-model-invocation: true`".
  - Without `skills:`, subagents can still discover skills via the Skill tool. Remove `Skill` from `tools` or add it to `disallowedTools` to block that.
  - Subagent descriptions also cost context: a warning appears when combined custom-agent descriptions exceed 15,000 tokens. Move detail into the system prompt, which "only loads when that subagent runs".
  - — [Claude Code sub-agents docs](https://code.claude.com/docs/en/sub-agents)
- **Claude Code: locations.**
  - Enterprise > personal (`~/.claude/skills`) > project (`.claude/skills`, plus parent dirs up to the repo root).
  - Nested `.claude/skills` load when Claude first edits files there.
  - `--add-dir`, plugins (namespaced `/plugin:skill`) and claude.ai-synced skills are also sources.
  - — [Claude Code skills docs](https://code.claude.com/docs/en/skills)
- **Codex.**
  - Scopes: REPO `.agents/skills` (cwd, parents, repo root), USER `$HOME/.agents/skills`, ADMIN `/etc/codex/skills`, and SYSTEM (bundled). Symlinks are followed.
  - The initial list holds name, description and path, using "at most 2% of the model's context window, or 8,000 characters when the context window is unknown". It is adjustable via `skills.max_context_tokens` up to 10,000 tokens. "Descriptions are shortened first if many skills exist; some may be omitted with a warning."
  - Explicit `$skill-name`. `agents/openai.yaml` `policy.allow_implicit_invocation: false` = explicit only.
  - Disable with `[[skills.config]] path=… enabled=false` in `~/.codex/config.toml`, then restart.
  - — [Codex build-skills docs (learn.chatgpt.com, redirected from developers.openai.com/codex/skills)](https://learn.chatgpt.com/docs/build-skills)
- **OpenCode.**
  - Paths: `.opencode/skills`, `~/.config/opencode/skills`, `.claude/skills`, `~/.claude/skills`, `.agents/skills`, `~/.agents/skills`. Project paths walk up to the git worktree root.
  - Skills are surfaced through a `skill` tool whose `<available_skills>` list the model sees. Name must match `^[a-z0-9]+(-[a-z0-9]+)*$`; description is 1–1024 chars.
  - `metadata` `opencode/autoinvoke: "false"` hides a skill from model guidance; `opencode/slash: "true"` adds a TUI command.
  - `permission.skill` patterns (allow, deny, ask) with per-agent overrides. `tools.skill: false` disables skills for an agent.
  - — [OpenCode skills docs](https://opencode.ai/docs/skills/)
- **Cursor.**
  - Paths: `.agents/skills`, `.cursor/skills`, `~/.agents/skills`, `~/.cursor/skills`, plus legacy `.claude/skills`, `.codex/skills` and the home equivalents. Nested and monorepo discovery.
  - `disable-model-invocation: true` makes it "like a traditional slash command, where it is only included in context when you explicitly type `/skill-name`".
  - Supports `paths`, `icon`/`color` (Custom Mode) and `metadata`. "The documentation provides no explicit limits on skill quantity or file size."
  - — [Cursor skills docs](https://cursor.com/docs/skills)
- **Session-start injection bypasses progressive disclosure.** obra/superpowers registers a `SessionStart` hook (startup, clear, compact) that injects the full `using-superpowers` SKILL.md (3.2 KB ≈ 800 tokens) inside `<EXTREMELY_IMPORTANT>` every session. Its description tells the model to invoke skills "before ANY response". — [superpowers hooks/hooks.json and hooks/session-start](https://github.com/obra/superpowers/tree/main/hooks)
- **Measured standing costs if every skill were model-invoked** (description chars only):

| Set | Descriptions |
|---|---|
| mattpocock v1.3.1 plugin | 27 skills ≈4.2k chars; actual (11 MI) ≈2.3k chars ≈570 tok |
| pstack | 56 skills ≈11.6k chars ≈2.9k tok; actual ≈ setup-pstack only |
| superpowers | 15 skills ≈2.3k chars ≈580 tok, plus ≈800 tok hook injection |
| anthropics/skills | 20 skills ≈6.4k chars ≈1.6k tok |

  Body totals: mattpocock ≈32k tok, pstack ≈52k, superpowers ≈40k, anthropics ≈72k. — computed from the cloned repos (local measurement)

**Plugins vs skills vs commands vs subagents (Claude Code):**
- A plugin is only packaging. Its cost is the sum of its parts: skill descriptions, agent descriptions, any hooks that inject text, and MCP tool schemas.
- Slash commands are skills now. A user-invoked skill or command costs nothing until typed.
- A subagent costs a description per turn in the parent. Its system prompt and preloaded skills land in the *subagent's* context, not the parent's.
- A `context: fork` skill keeps its body out of the main thread.
- — [skills docs](https://code.claude.com/docs/en/skills); [sub-agents docs](https://code.claude.com/docs/en/sub-agents)

### Inferences
- At typical scale (10–60 skills) the description cost is small: under 1% of a 200k window. The bigger costs are (a) invoked bodies that persist for the rest of the session (5–20 KB each for routers like poteto-mode, wayfinder or ask-matt), (b) preloading and custom-mode pinning, and (c) wrong-skill invocations caused by overlapping descriptions (two tdd skills, two review skills). Accuracy loss from a crowded listing is likely the stronger argument for curation than raw tokens.
- In Codex, Claude Code and OpenCode, `disable-model-invocation`, `allow_implicit_invocation: false` and `opencode/autoinvoke: false` are the shared lever. A skill shipped with both the Claude frontmatter and `agents/openai.yaml` (as mattpocock does) behaves the same in all four harnesses. OpenCode needs the metadata key added.
- A skill hidden this way cannot be preloaded into Claude Code subagents. Hidden library skills must therefore be delivered by path ("Read X") or by injection into the brief. That is exactly what pstack's Claude Code adapter does.

### Gaps
- No official confirmation of the Claude Code default listing budget fraction (the 1% figure is third-party) or of `SLASH_COMMAND_TOOL_CHAR_BUDGET` in current docs.
- Cursor's description budget and truncation behaviour are not documented.
- No source measured how listing size affects skill-selection accuracy. That effect is inferred, not cited.

## (c) Recommended curation and loading strategy for a multi-agent orchestrator

### Takeaway
Treat skills as a library the orchestrator owns, not a global install.
1. Vendor a small curated set into the orchestrator under one canonical SKILL.md format.
2. Give each worker role a tiny visible set (3–6 model-invoked skills), with everything else hidden or user-invoked.
3. Prefer orchestrator-side routing: pick the skill for the task and inject its body, or a pointer to its path, into the worker brief. That beats relying on each agent's auto-discovery.
4. Measure per-harness standing cost and keep descriptions under about 200 chars.

### Cited Findings (mechanisms the strategy relies on)
- **Per-role sets are natively supported.**
  - Claude Code: subagent `skills:` preloading (≤32) and `tools`/`disallowedTools` to remove the Skill tool. — [sub-agents docs](https://code.claude.com/docs/en/sub-agents)
  - OpenCode: per-agent `permission.skill` and `tools.skill: false`. — [OpenCode skills](https://opencode.ai/docs/skills/)
  - Codex: per-path enable/disable in `config.toml`. — [Codex skills](https://learn.chatgpt.com/docs/build-skills)
  - Claude Code: `skillOverrides` ("name-only", "off", etc.) and `enabledPlugins` per settings scope. — [settings reference](https://code.claude.com/docs/en/settings-reference)
- **Scoping without global installs.**
  - Project-scope directories are read by all harnesses: `.agents/skills` (Codex, OpenCode, Cursor) and `.claude/skills` (Claude Code, OpenCode, Cursor legacy). — docs above
  - Claude Code `--add-dir` loads skills from an extra dir for one session only. — [skills docs](https://code.claude.com/docs/en/skills)
  - mattpocock's `scripts/link-skills.sh` symlinks skills into `~/.claude/skills` and `~/.agents/skills`, and Codex follows symlinks. — [mattpocock CLAUDE.md](https://github.com/mattpocock/skills/blob/main/CLAUDE.md); [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- **Routing precedents.**
  - pstack's poteto-mode is a router with an inline principle index and leaf files read by path. Delegates get "file pointers not inlined context". — [poteto-mode](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md)
  - mattpocock's ask-matt is a hidden router. — [SKILL-MECHANICS.md](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL-MECHANICS.md)
- **Keep descriptions short and front-loaded.** "Put the key use case first". The cap is 1,536 chars in Claude Code and 1,024 in the spec. — [Claude Code skills docs](https://code.claude.com/docs/en/skills); [agentskills.io](https://agentskills.io/specification)
- **Measurement hooks.**
  - Claude Code: `/context` for skill-description usage. — [skills docs](https://code.claude.com/docs/en/skills)
  - Claude Code: a startup warning when custom subagent descriptions exceed 15,000 tokens. — [sub-agents docs](https://code.claude.com/docs/en/sub-agents)
  - Codex: warns when skills are omitted from its 2%/8,000-char list. — [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- **Security.** Install only from trusted sources and audit scripts and network calls. — [Anthropic Engineering](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)

### Inferences (concrete recommendations)
1. **Vendor, don't subscribe.** Copy the chosen skills into the app, e.g. `skills/<role>/<name>/`, with license attribution (both repos are MIT). Pin the upstream commit and diff on update. Both upstreams change fast: mattpocock went v1.2.3 → v1.3.1 in about 2 months and added and removed skills; pstack is at v0.15.29 with daily commits.
2. **One canonical format, three outputs.**
   - SKILL.md with spec-compliant `name`/`description` (≤1024 chars).
   - `disable-model-invocation` for Claude Code and Cursor.
   - `agents/openai.yaml` with `policy.allow_implicit_invocation` for Codex.
   - `metadata.opencode/autoinvoke` for OpenCode.
   - Mattpocock's dual frontmatter + openai.yaml is the template to follow.
3. **Three tiers per role.**
   - (i) **Always-visible**, 3–6 model-invoked skills, descriptions ≤200 chars. Examples: implementer = tdd + pr; reviewer = code-review; debugger = diagnosing-bugs.
   - (ii) **Hidden library**: user-invoked or `name-only` skills the orchestrator references by path, such as leaf principles, playbooks and interrogate rubrics.
   - (iii) **Not installed**: human-facing and niche skills.
4. **Orchestrator-side routing as the default for workers.**
   - The orchestrator classifies the task, picks 0–2 skills, and puts either the SKILL.md body (if under about 2k tokens) or an absolute path plus a "read before work" line into the brief.
   - This works the same for Claude Code, Codex, OpenCode and Cursor CLI, and avoids each harness's discovery behaviour and listing budget.
   - It also gets around Claude Code's refusal to preload `disable-model-invocation` skills.
   - Combine pstack's "file pointers not inlined context" with mattpocock's AGENT-BRIEF.md template.
5. **Spawn workers with an isolated skill dir, not the user's global skills.**
   - Claude Code: launch workers with project-scoped `.claude/skills` in the worktree or `--add-dir <role-skill-dir>`, and use `skillOverrides: "off"` for the user's unrelated global or plugin skills via a `--settings` JSON for that session.
   - Codex: `.agents/skills` in the worktree, plus `[[skills.config]] enabled=false` for noise.
   - OpenCode: per-agent `permission.skill`.
   - This matters because this very machine's global listing includes about 40 unrelated skills (academic-research, pob2, artifact, etc.) that a coding worker would otherwise pay for and could mis-trigger on.
6. **Avoid always-on injectors in workers.** Don't ship SessionStart-hook skill injection (the superpowers style) or Cursor custom-mode pinning to workers. Reserve persistent modes for the orchestrator or lead session.
7. **Use `context: fork` / subagents for heavy skills.** Code-review, interrogate, swarm, research and "why" bodies plus their outputs belong in a forked context. Return only summaries ("guard-the-context-window").
8. **Measure.** Add CI that computes description chars per role set and SKILL.md bytes per skill, and fails over budget (e.g. role listing >1.5k chars, SKILL.md >5k tokens per spec). Periodically check `/context` in Claude Code and the omission warnings in Codex. Run an eval (pstack's eval playbook and skill-creator-style benchmarks) to confirm that routing to a skill improves outcomes before promoting it.
9. **Resolve overlaps explicitly.** Pick one tdd (mattpocock's for test-first feature work, or pstack's conditional one for bug fixes, but not both visible). Pick one review entry point (code-review for spec and standards; interrogate as an opt-in high-stakes escalation). Do the same for routers.

### Gaps
- No published benchmarks compare "orchestrator injects skill" against "agent auto-discovers skill" for success rate or tokens. This is a recommended experiment.
- Not verified: whether Cursor CLI honors the same skill dirs and `disable-model-invocation` as the Cursor IDE agent.

## (d) Other curated skill sources worth considering (brief, with quality filter)

### Takeaway
Two other sources are worth pulling from selectively:
- **obra/superpowers.** A process methodology (brainstorm → plan → implement with verification), actively maintained. Its session-start injection and "invoke before ANY response" stance are the opposite of token-lean.
- **anthropics/skills.** Best for document and artifact skills (docx, pdf, pptx, xlsx, skill-creator, webapp-testing, mcp-builder). Mostly not coding-role skills.

openai/skills is deprecated in favour of openai/plugins. Marketplace aggregators should be treated as discovery only.

### Cited Findings
- **obra/superpowers** (MIT, Jesse Vincent; last commit 2026-10-20).
  - 15 skills: brainstorming, writing-plans, executing-plans, subagent-driven-development (32.6 KB), dispatching-parallel-agents, test-driven-development, systematic-debugging, verification-before-completion, requesting-/receiving-code-review, using-git-worktrees, finishing-a-development-branch, writing-skills (26.6 KB), diagnosing-superpowers, using-superpowers.
  - Bodies total ≈162 KB.
  - A SessionStart hook injects using-superpowers each session.
  - — [obra/superpowers](https://github.com/obra/superpowers) (cloned and measured); history and positioning per [mcp.directory review](https://mcp.directory/blog/superpowers-skill-worth-it-2026) (secondary)
- **anthropics/skills** (last commit 2026-10-09).
  - 19 skills + template: academy-guide, algorithmic-art, brand-guidelines, canvas-design, claude-api, discernment-nudge, doc-coauthoring, docx, frontend-design, internal-comms, mcp-builder, pdf, pptx, skill-creator, slack-gif-creator, theme-factory, webapp-testing, web-artifacts-builder, xlsx.
  - Descriptions ≈6.4k chars; bodies ≈288 KB.
  - — [anthropics/skills](https://github.com/anthropics/skills) (cloned and measured)
- **openai/skills.** "**This repository is deprecated.** For current Codex skill and plugin examples, use the OpenAI Plugins repository". It held `.system` skills (imagegen, openai-docs, plugin-creator, skill-creator, skill-installer) and 39 `.curated` ones (gh-address-comments, gh-fix-ci, playwright, sentry, security-best-practices, security-threat-model, linear, figma-*, deploy targets…), installed via `$skill-installer`. Last commit 2026-06-23. — [openai/skills README](https://github.com/openai/skills)
- **Other cursor/plugins worth a look for orchestrators.** `orchestrate` ("Fan large tasks out across parallel cloud agents with planners, workers, verifiers, and structured handoffs"), `thermos` (deep branch review), `advisor` (consult a stronger model before major decisions), `continual-learning`, `cursor-team-kit` (deslop, control-cli, control-ui) and `dyl-stack` (built on pstack). — [cursor/plugins README](https://github.com/cursor/plugins/blob/main/README.md)
- **Ecosystem scale (secondary, low confidence).** "grew from one registry in late 2025 to eight marketplaces by mid-2026". — [mcp.directory](https://mcp.directory/blog/superpowers-skill-worth-it-2026) via search snippet; not verified

### Inferences
**Quality filter for any internet skill.** Keep a skill only if it:
- (1) Has a single clear trigger and a description under 300 chars.
- (2) Has a SKILL.md under about 5k tokens with references one level deep.
- (3) Declares its invocation mode (model vs user).
- (4) Has no hidden always-on hooks, or audited ones.
- (5) Has tool-neutral instructions, or a harness adapter.
- (6) Has an active maintainer and changelog, and an MIT/Apache license.
- (7) Fills a role gap not already covered (no duplicate tdd or review skills).

**Worth cherry-picking:**
- superpowers: systematic-debugging, verification-before-completion and receiving-code-review, as reviewer/debugger complements.
- anthropics: skill-creator, for authoring and evaluating your own skills.
- openai curated: gh-fix-ci, gh-address-comments and security-threat-model fill gaps in both target repos (CI fixing, PR comment handling, security).

### Gaps
- I did not check openai/plugins contents or the agentskills.io adopters list. The skills.sh registry and other marketplaces were not evaluated for quality.
