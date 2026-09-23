---
description: Close the active plantrail node with a summary
argument-hint: [node id or summary hints]
allowed-tools: Bash(node:*), Bash(git log:*), Bash(git status:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/server/dist/cli.js" status`

!`git log --oneline -10 2>/dev/null; git status --short 2>/dev/null`

Arguments: $ARGUMENTS

Close the active node (or the node id given in the arguments) with `~/.plantrail/bin/plantrail done nN --summary "..." --ref ...`:

1. Draft the summary from this conversation and the commits above: what was done or learned, and any gotchas, specific enough that nobody has to re-derive it. Refs are the relevant commit SHAs and key file paths.
2. If there are uncommitted changes related to the node, mention it.
3. Show the draft and the command, then run it unless the user objects. If no node is active and none was given, say so and show `plantrail next` instead.
