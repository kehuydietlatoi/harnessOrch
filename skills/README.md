# Skills library

Workers never discover skills on their own. For each brief, the engine picks a small set and passes them as **file paths**, which the worker reads before starting:
- the **core** skills for the worker's role;
- at most **2 project skills**, which Opus names in the plan header (`skills:`) or on a task (`skills:`).

```
core/<role>/<skill>/SKILL.md        role = implementer | fixer | reviewer
project/<type>/<skill>/SKILL.md     named in plans by <skill>
```

| Role | Gets | Used for |
|---|---|---|
| implementer | `tdd` | `implement` and `small` tasks |
| fixer | `diagnosing-bugs`, `fix-root-causes` | `hard` tasks |
| reviewer | `blast-radius`, `test-behavior-not-implementation` | diff-only reviews |

| Project skill | For |
|---|---|
| `game-dev-loop` | games: playable slices, running-game playtests |
| `typescript-best-practices` | TypeScript codebases |
| `sprite-assets` | game asset tasks (`images: true`): generate sprites, icons and effect sheets, clean them with the generate2dsprite processor |

**To add a skill,** drop a folder with a `SKILL.md` into `core/<role>/` or `project/<type>/`. Keep it under about 5k tokens. Skills run unattended, so add the "harnessOrch note" header if the skill was written for interactive use. The engine's tests enforce the size limits.

## Sources (pinned, MIT)

| Skill | Source |
|---|---|
| `tdd`, `diagnosing-bugs` | [mattpocock/skills](https://github.com/mattpocock/skills) @ `5beb35b` (v1.3.1). See `LICENSE-mattpocock-skills`. |
| `blast-radius`, `test-behavior-not-implementation` (`principle-…`), `fix-root-causes` (`principle-…`), `typescript-best-practices` | [cursor/plugins pstack](https://github.com/cursor/plugins/tree/main/pstack) @ `190d287` (v0.15.29). See `LICENSE-pstack`. |
| `game-dev-loop` | your own skill (`~/.claude/skills/game-dev-loop`) |
| `sprite-assets` | condensed from your own Codex skill (`~/.codex/skills/generate2dsprite`), which workers can't see; it points at that skill's processor script |

Each vendored `SKILL.md` keeps its original text. The only change is a short "harnessOrch note" inserted after the frontmatter. When updating from upstream, diff against the pinned commit, then re-run the note insertion.
