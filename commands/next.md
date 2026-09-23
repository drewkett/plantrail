---
description: Rank what to work on next in the bound plantrail thread
allowed-tools: Bash(node:*), Bash(~/.plantrail/bin/plantrail:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/server/dist/cli.js" next`

Above are the ranked next options for the bound plantrail thread. Recommend one in a sentence and ask whether to start it. Don't start anything until the user confirms.
