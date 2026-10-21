---
name: game-dev-loop
description: Build or change a game through playable slices and running-game playtests. Use for gameplay, controls, game UI, content, balance, builds, or game-specific asset integration.
---

> **harnessOrch note:** you run unattended inside an engine-managed task. Where this skill says to ask or confirm with the user, decide yourself and record the decision in your result's `decisions`. Ignore references to other skills or the Skill tool. Stay inside your write scope and run checks with hverify.


# Game Dev Loop

Deliver a player-observable improvement, not merely a code change.

## Work the loop

1. **Orient.** Identify the engine, relevant project structure, and actual run, test, and export commands from the repository. Read only the context needed for the requested change.
2. **Frame a playable slice.** Define the smallest end-to-end player outcome that tests the idea. State checkable acceptance criteria and exclusions. Resolve minor gaps with reversible assumptions; ask only when a choice would materially change the result.
3. **Baseline.** Run the smallest relevant automated checks and launch the current game when the environment supports it. Record pre-existing failures separately from the requested work.
4. **Implement thinly.** Complete one observable milestone at a time. Reuse project patterns, keep tuning values easy to change, use placeholders when they are enough to test the mechanic, and keep unrelated refactors outside the slice.
5. **Playtest.** Run the changed game and follow the shortest route that demonstrates the slice. Check the relevant controls, camera, feedback, core loop, success, failure, retry, state transitions, readability, and performance. A successful compile supports the result but does not prove gameplay.
6. **Critique and improve.** Rank observations as blocking, confusing, unsatisfying, or cosmetic. Repair the highest-impact in-scope problem and repeat implementation and playtesting until the acceptance criteria pass.
7. **Finish with evidence.** Report the player-visible result, commands and playtest route used, acceptance evidence, known limitations, and the next useful slice. Publishing, spending money, and material scope expansion require explicit authorization.

## Observation boundary

Use computer control when it is available and appropriate. If the graphical game cannot be operated in the current environment, give the human an exact playtest route and mark those criteria unverified. Never describe a game as played or visually verified without direct evidence.

## Asset branch

Before generating or replacing an asset, define its gameplay role, dimensions, format, transparency, visual constraints, and destination. Validate the integrated asset in the running game. Before batching, complete one representative asset through generation, cleanup, integration, and playtest.

## Durable state

Ordinary tasks need no workflow files. For work expected to span sessions, create `.game-dev/` in the project with only the state that must survive:

- `brief.md`: stable player fantasy, core loop, target, and constraints.
- `current-slice.md`: active outcome, exclusions, acceptance criteria, and milestones.
- `playtest-log.md`: observed routes, evidence, issues, and decisions, newest first.

Keep these files concise. Repository configuration remains the source of truth for commands and structure.
