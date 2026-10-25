---
name: commit-work
description: Check and commit the current uncommitted work in harnessOrch as clean, logically grouped commits. Never pushes.
disable-model-invocation: true
---

Commit the work in the tree. Do not push.

1. `git status` and `git diff --stat`. Read the diffs before staging anything.
2. Run `npm run lint` and `npm run typecheck`. If the engine changed, also run `npm run build -w packages/engine` and `npm run typecheck -w apps/desktop`. Run `npm test` only when the engine changed. If a check fails, stop and report it instead of committing.
3. Never stage `.claude/settings.local.json`, `release/`, `out/`, `dist/`, `node_modules/`, logs, or anything that looks like a secret. Stage files by name, not with `git add -A`.
4. Group the changes into logical commits (one feature or fix each, with its tests and docs). Several unrelated features in the tree means several commits. If a file mixes two features, commit it with the main one and say so.
5. Write messages in the style of `git log --oneline -10`: a short imperative subject, then a blank line and a few lines on why when it is not obvious. End each message with the Co-Authored-By attribution line this session specifies.
6. Do not amend, force, or skip hooks. If a hook fails, fix the cause and make a new commit.
7. Finish with `git status` and `git log --oneline` for the new commits, and mention anything left uncommitted and why.
