---
description: Break a goal into plantrail nodes and show them for approval
argument-hint: <goal>
allowed-tools: Bash(node:*), Bash(~/.plantrail/bin/plantrail:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/server/dist/cli.js" status`

Goal: $ARGUMENTS

Plan this goal in plantrail (`~/.plantrail/bin/plantrail`, run from the project directory):

1. If the goal is empty, ask for it. If no thread is bound above, or the goal is unrelated to the bound thread, `plantrail create "Title" --goal "what done looks like"`. Otherwise add under the bound thread (use `--parent` or a top-level node for the goal).
2. Read enough of the code to make the breakdown concrete. `plantrail search` first so you don't duplicate existing nodes.
3. Add every node in one `plantrail add -` call: tasks small enough to finish in one sitting, `blocked_by` for real ordering constraints only, `kind: "question"` for unknowns, `kind: "decision"` for choices already made (reasoning in `body`).
4. Show the resulting tree (`plantrail get <root> --depth 2`, or `status`) and ask for approval. Don't start any node until the user approves; adjust with `update`/`delete` if they want changes.
