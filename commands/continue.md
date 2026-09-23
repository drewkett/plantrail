---
description: Resume the bound plantrail thread and keep working without asking
allowed-tools: Bash(node:*), Bash(~/.plantrail/bin/plantrail:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/server/dist/cli.js" status`

Above is the bound plantrail thread. Resume it now, without asking for confirmation:

1. Read the last checkpoint note; it is the handoff from the previous session.
2. If a node is active, `~/.plantrail/bin/plantrail get` it and continue it. Otherwise start the top **Next** item with `plantrail start`.
3. Work it to completion, then `plantrail done` with a specific summary and refs (files, commit SHAs), and move on to the next item.

Stop and ask only when a decision is genuinely the user's, the work is blocked, or the next item is outside what the thread's goal covers. If no thread is bound, say so and suggest `/plantrail:plan`.
