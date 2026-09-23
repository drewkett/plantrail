---
name: plantrail
description: Track long-running, multi-session work with the plantrail CLI (~/.plantrail/bin/plantrail status/add/start/done/checkpoint/next). Use when a task spans many steps or sessions, when the user asks to plan/break down/track work, when a SessionStart message begins with "[plantrail]", or before /clear or compaction on tracked work.
allowed-tools: Bash(~/.plantrail/bin/plantrail:*)
---

# plantrail

plantrail holds plan state in a database so you query it instead of re-reading plan files. State survives `/clear`, compaction, and new sessions.

Run it via Bash as `~/.plantrail/bin/plantrail <command>` (the SessionStart hook installs this shim). Always call it from the project directory: the thread is resolved from the cwd. `plantrail help` prints full usage. Errors go to stderr with exit 1; they state which rule was violated, so fix and retry rather than working around them.

## At session start

- If context contains an `[plantrail] tN "…"` status block, this directory is bound to that thread. Continue from **Active** or the top **Next** item; read the **Last checkpoint** note first.
- If it lists multiple threads, ask the user which one, then `plantrail bind tN`.
- Otherwise, don't create a thread for small one-off tasks. Create one when work will clearly span many steps or sessions, or the user asks: `plantrail create "Title" --goal "what done looks like"`.

## Working loop

1. `plantrail status` when you need orientation (~300 tokens). Don't re-read big plan docs to find out what's next.
2. Break work down in one call with a JSON array on stdin; `#i` references the i-th item of the same array, counting from 1 (`#1` is the first item); `parent`/`blocked_by` must point to earlier items, and `blocks` may point forward:
   ```sh
   ~/.plantrail/bin/plantrail add - <<'JSON'
   [{"title": "Design schema", "priority": 2},
    {"title": "Write migration", "parent": "#1", "blocked_by": ["#1"]},
    {"title": "Is WAL safe on NFS?", "kind": "question"}]
   JSON
   ```
   Single item: `plantrail add "Title" [--kind question] [--parent n3] [--blocks n4,n5] [--priority 1]`. Use priority (higher = sooner) sparingly.
   An existing markdown plan: `plantrail import PLAN.md --dry-run`, then without `--dry-run` (`--parent nN` nests it). Headings and list items become tasks and other text becomes their bodies; `[x]` items are skipped.
3. `plantrail start nN` before working on a node. Only one node is active per thread.
4. `plantrail done nN --summary "..." --ref path/file.ts --commit` when finished (`--commit` records HEAD's short SHA; `--ref HEAD~1` works too). The summary is the durable record: what was done or learned and any gotchas, specific enough that nobody has to re-derive it.
5. `plantrail next` (`-n 5` for more; `--all` ranks across every active thread) to choose what comes next.

## Other rules

- Discovered new work? `add` it; don't silently expand the current node.
- Can't proceed? `plantrail update nN --status blocked --body "why"`, or add a blocker node with `--blocks nN`.
- Thread on hold? `plantrail park [tN]`. Goal met? `plantrail finish [tN]` (`plantrail reopen tN` undoes it). Threads idle 30 days auto-park at session start; `plantrail bind tN` reactivates one. If status flags an active node as idle for days, finish it, split it, or mark it blocked.
- Repo moved or cloned elsewhere and the thread no longer resumes? `plantrail link tN` links this location (add `--prune` to drop paths that no longer exist; `plantrail unlink kind:value` removes one stale link, e.g. an old repo URL). Moves are healed automatically when the origin URL still matches.
- Dead end? `plantrail update nN --status abandoned --summary "why"`. Abandoning also frees anything it blocked.
- Wrong command (bad add, premature done, wrong edge)? `plantrail undo` reverts the last command on the bound thread; repeat to walk back further, `--dry-run` to preview. `plantrail history` lists recent commands and the rows each changed.
- Learned something that answers or informs a question? `plantrail finding nN "what you found" --confidence 0.8 --source <url|path>` (repeat `--source`). It's recorded as a done finding under nN; confidence is 0–1, so be honest about how sure you are. If it settles the question, add `--answers` to close nN with it. `next` ranks unexplored, low-confidence, and contested (findings linked by a `contradicts` edge) questions higher.
- Record decisions as nodes (`--kind decision`) with the reasoning in `--body`, so later sessions don't reopen them.
- Before re-deriving something that may already be recorded, `plantrail search "words"` (prefix match, all words required; `--all` searches every thread, `--kind finding|decision` filters).
- `plantrail get nN [--depth 1]` for detail on demand. Never dump whole subtrees without a reason.
- `plantrail checkpoint "note"` after meaningful progress, before stopping, and before `/clear` or compaction. Write the note for a fresh session with no memory: current state, the next concrete step, and anything non-obvious.
- Quote arguments containing shell metacharacters; for long bodies use `--body "$(cat <<'EOF' ... EOF)"`.
