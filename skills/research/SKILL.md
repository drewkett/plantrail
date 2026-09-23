---
name: research
description: Run open-ended research (investigating a question, surveying options, debugging an unknown, comparing libraries/approaches) as a tree of questions and findings in plantrail, so evidence and confidence survive /clear, compaction, and new sessions. Use when the user asks to research/investigate/figure out something that needs many lookups, or when an plantrail thread holds open questions.
allowed-tools: Bash(~/.plantrail/bin/plantrail:*)
---

# research

Research in plantrail is a tree of **questions** answered by **findings**. Each finding carries a confidence (0–1) and sources, so a later session can see what is known, how well, and why, without redoing the work. Use the same CLI as the `plantrail` skill: `~/.plantrail/bin/plantrail <command>`, run from the project directory.

## Start

1. Check what's already known: `plantrail search "key words" --all` (add `--kind finding` or `--kind decision`). Don't re-research something with a high-confidence finding.
2. If there's no thread, `plantrail create "Research: topic" --goal "the question to settle and what a good answer looks like"`.
3. Break the top question into sub-questions in one call:
   ```sh
   ~/.plantrail/bin/plantrail add - <<'JSON'
   [{"title": "Which queue fits our load?", "kind": "question"},
    {"title": "Throughput of X at 10k msg/s?", "kind": "question", "parent": "#1"},
    {"title": "Does Y support exactly-once?", "kind": "question", "parent": "#1"}]
   JSON
   ```
   Keep questions specific and answerable; split broad ones rather than researching them whole.

## Loop

1. `plantrail next` picks the question to work on. It ranks unexplored, low-confidence, and contested questions higher, so follow it unless you have a reason not to. `plantrail start nN`.
2. Investigate (docs, code, experiments, web). Record each useful fact as you get it, not in a batch at the end:
   ```sh
   ~/.plantrail/bin/plantrail finding nN "X sustains ~40k msg/s on one node with acks=all" \
     --confidence 0.7 --source https://example.com/bench --source bench/results.csv
   ```
   - One claim per finding. Say what the claim rests on in the text if it isn't obvious from the sources.
   - Confidence: ~0.9+ verified directly (ran it, read the source); ~0.7 reputable docs; ~0.5 single secondary source or inference; below that, a lead. Don't inflate it.
   - Always give sources (URL, file path, commit, command). A finding without sources should get low confidence.
   - Findings that contradict earlier ones are expected; record them, link them with `plantrail edge nNEW contradicts nOLD`, and lower your confidence in the overall answer. `status` lists contradictions until the question is closed.
3. When the evidence settles the question, record the conclusion with `--answers` to close it:
   `plantrail finding nN "Use X: meets throughput, Y lacks exactly-once" --confidence 0.8 --source ... --answers`
4. New questions come up → `add` them (`--kind question --parent nN`). A dead-end question → `plantrail update nN --status abandoned --summary "why"`.
5. A conclusion that commits to a choice → also add a `--kind decision` node with the reasoning in `--body`, so it isn't reopened.
6. `plantrail checkpoint "note"` after meaningful progress and before stopping: what's settled, what's still open, what to try next.

## Reporting

When asked for results, build the answer from the recorded tree (`plantrail get nN --depth 1`, `plantrail search`), not memory. State confidence and cite the sources recorded with each finding; call out open or low-confidence questions explicitly.
