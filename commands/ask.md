---
description: Answer a question only from what plantrail has recorded
argument-hint: <question>
allowed-tools: Bash(node:*), Bash(~/.plantrail/bin/plantrail:*)
---
Question: $ARGUMENTS

Answer from recorded plantrail state only (`~/.plantrail/bin/plantrail`, run from the project directory):

- `plantrail search "key words" --all` (try a few phrasings; `--kind finding` or `--kind decision` to narrow), then `plantrail get nN` on the hits. `plantrail log` covers recent history.
- Cite node ids for every claim, and the confidence of any finding you rely on.
- Say plainly what isn't recorded. Don't read code, browse, or research to fill gaps; offer `/plantrail:research` instead.
- Don't modify any state.
