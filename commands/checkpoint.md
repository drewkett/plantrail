---
description: Write a plantrail handoff note now, e.g. before /clear
argument-hint: [extra note]
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/server/dist/cli.js" status`

Write a checkpoint for the bound thread with `~/.plantrail/bin/plantrail checkpoint "note"`. Write it for a fresh session with no memory of this conversation:

- Current state: what's done since the last checkpoint above (node ids, commit SHAs), what's in progress and how far along.
- The next concrete step.
- Anything non-obvious: gotchas, dead ends, uncommitted changes, decisions not yet recorded as nodes.

Before writing it, close any node that is actually finished (`plantrail done`) and `add` any discovered work, so the note doesn't carry what belongs in nodes. Include this if given: $ARGUMENTS
