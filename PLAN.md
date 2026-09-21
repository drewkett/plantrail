# autoplan — Plan

A Claude Code plugin that maintains state for long-running tasks and open-ended research, so work survives `/clear`, compaction, and new sessions without re-reading large markdown files.

## Goals

- Claude *queries* state instead of reading whole files → small context footprint.
- Server enforces workflow rules (e.g. no `done` without a summary).
- Works across repos and for research with no repo at all (global-first).
- Dogfood: once the MVP works, all further autoplan development is tracked in autoplan.

## Non-goals (for now)

- Multi-user / sync / cloud storage.
- Embeddings / semantic search (FTS5 is enough to start).
- A GUI beyond a generated HTML view.

## Architecture

```
autoplan/
├── .claude-plugin/plugin.json   plugin manifest (MCP server + hooks + skills)
├── server/                      TypeScript MCP server (stdio)
│   ├── src/db.ts                SQLite schema + migrations (node:sqlite, WAL)
│   ├── src/store.ts             all state logic (tested directly)
│   ├── src/index.ts             MCP tool registration → store
│   ├── dist/                    esbuild bundles (committed; plugin runs without npm install)
│   └── src/cli.ts               `autoplan` CLI used by hooks (resume, status, export)
├── hooks/hooks.json             SessionStart, PreCompact, Stop
├── skills/
│   ├── autoplan/SKILL.md        core usage: when to call which tool
│   └── research/SKILL.md        research loop (post-MVP)
└── commands/                    /ap-status, /ap-next (post-MVP)
```

Storage: single DB at `~/.autoplan/state.db` (override with `AUTOPLAN_HOME`). Nothing is written into repos.

## Data model

| Table | Key fields |
|---|---|
| `threads` | id, title, goal, status (`active`/`parked`/`done`), created_at, touched_at |
| `nodes` | id, thread_id, parent_id, kind (`task`/`question`/`finding`/`decision`), title, status (`open`/`active`/`blocked`/`done`/`abandoned`), summary, body, priority, created_at, updated_at |
| `edges` | from_id, to_id, type (`blocks`/`answers`/`derived_from`/`contradicts`) |
| `links` | thread_id, kind (`repo`/`dir`/`url`/`ticket`), value (repo key = git common dir or remote URL) |
| `checkpoints` | id, thread_id, note, frontier_json, created_at |
| `sessions` | session_id, thread_id, bound_at |
| `nodes_fts` | FTS5 over node title/summary/body |

IDs: short human-friendly (`t12`, `n143`) so Claude and the user can reference them easily.

## Tools

### MVP
| Tool | Behavior |
|---|---|
| `thread_create(title, goal, link_cwd?)` | Create thread, optionally link current repo, bind session. |
| `list_threads(filter?)` | Active threads, most-recently-touched first. |
| `bind(thread_id)` | Bind current session to a thread. |
| `status()` | Compact (~300 tokens) view of bound thread: goal, active node, frontier, blockers, last checkpoint note. |
| `add(title, kind?, parent?, blocks?)` | Add node(s) to bound thread. Accepts a list for bulk breakdown. |
| `start(id)` | Mark active. Refuses if blocked. |
| `done(id, summary, refs?)` | Mark done. Summary required. Unblocks dependents. |
| `update(id, fields)` | Edit title/body/status/priority (abandon, block, etc.). |
| `next_options(n=3)` | Rank open, unblocked nodes (priority, depth, staleness). |
| `get(id, depth=0)` | Full node detail, optionally with children. |
| `checkpoint(note)` | Save handoff note + frontier snapshot. |
| `resume(cwd?)` | Used by hook: resolve thread for cwd/session and return status. |

### Post-MVP
`record_finding`, `search` / `search_all` (FTS5), `link`, `park`, `export(format=md|json|html)`, auto-park stale threads, per-node attempt budgets.

## Hooks

- **SessionStart** → `autoplan resume --cwd "$PWD" --session "$SESSION_ID"`
  - 1 active thread linked to repo → auto-bind, inject `status()`.
  - Multiple → inject short picker.
  - None → inject nothing (or recent threads, configurable).
- **PreCompact** (post-MVP) → inject reminder to `checkpoint()` first.
- **Stop** (post-MVP) → if nodes changed state without a `done`/`checkpoint`, nudge once.

## Milestones

### M0 — Scaffold
- [x] `package.json`, tsconfig, `@modelcontextprotocol/sdk`, `zod` — uses built-in `node:sqlite` (Node ≥22.13) instead of `better-sqlite3`: no native build, so the esbuild bundle is self-contained
- [x] Plugin manifest registering the MCP server (`claude plugin validate .` passes)
- [x] Local install via `claude plugin` / marketplace dir for testing (`autoplan@autoplan-dev`, user scope)

### M1 — MVP (dogfood gate)
- [x] DB schema + migrations
- [x] MVP tools above
- [x] `autoplan` CLI: `resume`, `status`, `threads`
- [x] SessionStart hook
- [x] `skills/autoplan/SKILL.md`
- [x] Tests for state transitions + `next_options` ranking (`npm test` in `server/`)
- [ ] **Dogfood switch:** create thread "autoplan development", import remaining milestones below as nodes, link this repo. From here on, track work in autoplan, not this file.

### M2 — Research mode
- [ ] `record_finding(question_id, text, confidence, sources)`
- [ ] Findings answer/close questions; `next_options` favors unexplored/low-confidence branches
- [ ] FTS `search` / `search_all`
- [ ] `skills/research/SKILL.md`

### M3 — Robustness
- [ ] PreCompact + Stop hooks
- [ ] Auto-park stale threads; staleness flags on long-`active` nodes
- [ ] Repo relink when repos move
- [ ] `export` to markdown/JSON (backup + readable view)

### M4 — Visibility
- [ ] `/ap-status`, `/ap-next` commands
- [ ] HTML graph view (`export(format=html)`)
- [ ] Capped related-findings from other threads in `status()`

## Dogfooding notes

- Keep this file as the design doc; move the *task list* into autoplan at the M1 gate.
- Log friction as `finding` nodes in the autoplan thread; review them before each milestone.
- Success signal: can `/clear` mid-task and resume correctly from the SessionStart injection alone.

## Implementation notes (M0/M1)

- **Session binding:** the MCP server can't see the session ID. The SessionStart hook records `sessions(session_id, thread_id, cwd)`; the server resolves its thread lazily as: explicit `bind` → latest session binding for its cwd (`CLAUDE_PROJECT_DIR`) → the single active thread linked to this location.
- **Repo key:** links store both the git common dir and the `origin` URL (both `kind=repo`); either matches. Non-git dirs link as `kind=dir`.
- **Rules enforced:** `done` needs a summary and no unresolved children; abandoning needs a summary; `start` refuses blocked nodes and demotes the previous active node; `active`/`done` can only be set via `start`/`done`.
- **`add` refs:** `#i` refers to the i-th item in the same call (forward refs are allowed only in `blocks`).
- **Ranking:** `priority*10 + 5 if leaf + 1.5*depth + 0.5*idle_days (cap 7)`; only open, unblocked `task`/`question` nodes.
- **Dev loop:** `cd server && npm test && npm run typecheck && npm run build`, then `claude plugin marketplace add ~/code/autoplan && claude plugin install autoplan@autoplan-dev`.

## Open questions

- Session ID availability in all hook payloads — verify against current Claude Code hook docs.
- Repo key: git common dir vs remote URL as primary (leaning common dir, remote as fallback for relink).
- Should `status()` token budget be configurable?
