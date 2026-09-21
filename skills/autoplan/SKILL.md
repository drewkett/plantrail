---
name: autoplan
description: Track long-running, multi-session work in autoplan (MCP tools thread_create, status, add, start, done, checkpoint, next_options). Use when a task spans many steps or sessions, when the user asks to plan/break down/track work, when a SessionStart message begins with "[autoplan]", or before /clear or compaction on tracked work.
---

# autoplan

autoplan holds plan state in a database so you query it instead of re-reading plan files. State survives `/clear`, compaction, and new sessions.

## At session start

- If context contains an `[autoplan] tN "…"` status block, this session is already bound to that thread. Continue from **Active** or the top **Next** item; read the **Last checkpoint** note first.
- If it lists multiple threads, ask the user which one, then `bind(thread_id)`.
- Otherwise, don't create a thread for small one-off tasks. Create one (`thread_create`) when work will clearly span many steps or sessions, or the user asks.

## Working loop

1. `status()` when you need orientation (cheap, ~300 tokens). Don't re-read big plan docs to find out what's next.
2. Break work down with one `add(items=[...])` call. Use `parent: "#0"` and `blocked_by: ["#1"]` to reference items within the same call. Use `priority` (higher = sooner) sparingly.
3. `start(id)` before working on a node. Only one node is active per thread.
4. `done(id, summary, refs)` when finished. The summary is the durable record: say what was done or learned and any gotchas, specific enough that nobody has to re-derive it. Put files, commits, and URLs in `refs`.
5. `next_options()` to choose what comes next.

## Other rules

- Discovered new work? `add` it; don't silently expand the current node.
- Can't proceed? `update(id, status="blocked", body="why")`, or add a blocker node with `blocks: [id]`.
- Dead end? `update(id, status="abandoned", summary="why")`. Abandoning also frees anything it blocked.
- Record decisions and findings as nodes (`kind: "decision"` / `"finding"`) with the reasoning in `body`, so later sessions don't reopen them.
- `get(id, depth)` for detail on demand. Never dump whole subtrees without a reason.
- `checkpoint(note)` after meaningful progress, before stopping, and before `/clear` or compaction. Write the note for a fresh session with no memory: current state, the next concrete step, and anything non-obvious.
