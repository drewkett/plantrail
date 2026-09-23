# plantrail

A [Claude Code](https://claude.com/claude-code) plugin that keeps plan state for long-running tasks and research in a local SQLite database, so it survives `/clear`, compaction, and new sessions. Claude queries the plan instead of re-reading plan files.

Work is organized as **threads** (a goal, bound to a directory or repo) containing a tree of **nodes**: tasks, questions, findings, and decisions, linked by `blocks`, `derived_from`, and `contradicts` edges. Checkpoint notes carry handoff context between sessions.

## Install

Requires Node.js 22.13 or later (uses `node:sqlite`).

```sh
/plugin marketplace add drewkett/plantrail
/plugin install plantrail@plantrail
```

On first session start, the plugin installs a shim at `~/.plantrail/bin/plantrail`. Data lives in `~/.plantrail` (override with `PLANTRAIL_HOME`).

## What the plugin does

- **SessionStart hook**: resolves the thread bound to the current directory and prints its status (goal, active node, next items, last checkpoint) into context.
- **PreCompact hook**: saves an automatic checkpoint if anything changed.
- **Stop hook**: reminds Claude once to mark finished nodes done and checkpoint.
- **PostToolUse hook on ExitPlanMode**: saves the approved plan to `~/.plantrail/plans/` and suggests `plantrail import` so its steps become nodes.
- **Skills**: `plantrail` (the task-tracking workflow) and `research` (open-ended research as a tree of questions and findings with confidence levels).
- **Commands**:
  - `/plantrail:status`: summarize the bound thread.
  - `/plantrail:next`: recommend what to work on next and wait for confirmation.
  - `/plantrail:continue`: resume from the last checkpoint and keep working.
  - `/plantrail:plan <goal>`: break a goal into nodes and show them for approval.
  - `/plantrail:ask <question>`: answer only from recorded state, citing node ids.
  - `/plantrail:checkpoint`: write a handoff note now, e.g. before `/clear`.
  - `/plantrail:done`: close the active node with a summary drafted from the conversation and commits.
  - `/plantrail:research <question>`: start research using the `research` skill.

Claude drives it through the skills. You can also use the CLI directly.

## CLI

```sh
plantrail create "Title" --goal "what done looks like"
plantrail add "Design schema" --priority 2
plantrail start n1
plantrail done n1 --summary "what was done, gotchas" --ref src/db.ts
plantrail next
plantrail checkpoint "state, next step, anything non-obvious"
```

Other commands include `status`, `threads`, `bind`, `park`, `finish`, `finding`, `edge`, `search`, `log`, `history` (every recorded change), `undo` (revert the last command), `get`, `export` (markdown/JSON/HTML), and `serve` (a local live web view on port 7847). Run `plantrail help` for full usage.

## Development

```sh
cd server
npm install
npm run build      # bundles src/ into dist/ (committed, so the plugin runs without an install step)
npm run typecheck
npm test
```

## License

[MIT](LICENSE)
