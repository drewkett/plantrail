import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { AUDITED, rowJson, type AuditedTable, type DB } from "./db.ts";
import { headTime, isRepoKey, locationKeys, unpushedCount, type LinkKey } from "./repo.ts";

export const NODE_KINDS = ["task", "question", "finding", "decision"] as const;
export const EDGE_TYPES = ["blocks", "derived_from", "contradicts"] as const;
export const NODE_STATUSES = ["open", "active", "blocked", "done", "abandoned"] as const;
export type NodeKind = (typeof NODE_KINDS)[number];
export type EdgeType = (typeof EDGE_TYPES)[number];
export type NodeStatus = (typeof NODE_STATUSES)[number];
export type ThreadStatus = "active" | "parked" | "done";

export interface Thread {
  id: string;
  title: string;
  goal: string;
  status: ThreadStatus;
  created_at: string;
  touched_at: string;
  /** Last event seq when the Stop hook reminded about uncheckpointed changes. */
  nudged_seq?: number | null;
}

/** One recorded command: its row changes, described, newest op first in history(). */
export interface OpEntry {
  id: number;
  at: string;
  label: string | null;
  /** Set on an undo op: the op it reverted. */
  undoes: number | null;
  /** Set on a reverted op: the undo that reverted it. */
  undone_by: number | null;
  changes: string[];
}

interface EventRow {
  seq: number;
  tbl: AuditedTable;
  action: "insert" | "update" | "delete";
  row_key: string;
  old: string | null;
  new: string | null;
}

export type LogEntry = { at: string; checkpoint: string; node?: undefined } | { at: string; node: Node; checkpoint?: undefined };

export interface Node {
  id: string;
  thread_id: string;
  parent_id: string | null;
  kind: NodeKind;
  title: string;
  status: NodeStatus;
  summary: string | null;
  body: string | null;
  refs: string | null;
  /** 0..1, findings only. */
  confidence: number | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface AddItem {
  title: string;
  kind?: NodeKind;
  /** Node id, or `#i` referencing the i-th item (1-based) of the same add() call. */
  parent?: string;
  body?: string;
  priority?: number;
  /** Nodes this one blocks (ids or `#i`). */
  blocks?: string[];
  /** Nodes that block this one (ids or `#i`). */
  blocked_by?: string[];
}

export interface Option {
  node: Node;
  score: number;
  why: string;
  /** Set by nextOptionsAll, which ranks across threads. */
  thread_title?: string;
}

/** A thread's nodes, children by parent id, open blocker ids by node id, and contradicts edges touching it. */
interface Graph {
  nodes: Map<string, Node>;
  kids: Map<string, Node[]>;
  blockers: Map<string, string[]>;
  contradicts: { from_id: string; to_id: string }[];
}

const byScore = (a: Option, b: Option) =>
  b.score - a.score ||
  a.node.created_at.localeCompare(b.node.created_at) ||
  a.node.id.localeCompare(b.node.id, undefined, { numeric: true });

export interface SearchHit {
  node: Node;
  /** Matching excerpt with hits wrapped in [ ]. */
  snippet: string;
  thread_title: string;
}

export interface ThreadExport {
  version: 1;
  exported_at: string;
  thread: Thread;
  /** Depth-first tree order; refs decoded. */
  nodes: (Omit<Node, "refs"> & { refs: string[] | null })[];
  edges: { from_id: string; to_id: string; type: string }[];
  links: { kind: string; value: string }[];
  checkpoints: { id: number; note: string; frontier: { active: string[]; next: string[] }; created_at: string }[];
}

export class PlantrailError extends Error {}
/** current() found no thread for this session/location. */
export class NotBoundError extends PlantrailError {}

const RESOLVED: NodeStatus[] = ["done", "abandoned"];
/** Active threads untouched this long are parked by resume(). */
export const PARK_AFTER_DAYS = 30;
/** Active nodes untouched this long are flagged in status. */
export const STALE_ACTIVE_DAYS = 3;
const DAY = 86_400_000;

export class Store {
  /** Thread bound to this process: explicit --thread, else resolved by current(). */
  bound: string | null = null;
  /** Claude session this process runs in (hook payload or $CLAUDE_CODE_SESSION_ID), if known. */
  session: string | null = null;
  /** Claude process pid ($CLAUDE_PID), if known; it survives /clear, which starts a new session. */
  pid: number | null = null;
  /** Recorded on each op, e.g. the CLI command line. */
  label: string | null = null;

  readonly db: DB;
  readonly cwd: string;
  readonly now: () => Date;

  constructor(db: DB, cwd: string = process.cwd(), now: () => Date = () => new Date()) {
    this.db = db;
    this.cwd = cwd;
    this.now = now;
  }

  // ---------- helpers ----------

  private ts(): string {
    return this.now().toISOString();
  }

  private nextId(prefix: "t" | "n"): string {
    const row = this.db
      .prepare("UPDATE counters SET next = next + 1 WHERE name = ? RETURNING next - 1 AS id")
      .get(prefix) as { id: number };
    return `${prefix}${row.id}`;
  }

  /**
   * Run `fn` under BEGIN IMMEDIATE, which serializes writers across processes,
   * so validation reads inside `fn` still hold when it writes. `fn` runs as one
   * op: triggers record its row changes as events (see db.ts AUDITED).
   */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const op = Number(
        this.db.prepare("INSERT INTO ops (label, session_id, at) VALUES (?, ?, ?)").run(this.label, this.session, this.ts()).lastInsertRowid,
      );
      const out = fn();
      const first = this.db.prepare("SELECT thread_id FROM events WHERE op_id = ? ORDER BY seq LIMIT 1").get(op) as
        | { thread_id: string | null }
        | undefined;
      if (first) this.db.prepare("UPDATE ops SET open = 0, thread_id = ? WHERE id = ?").run(first.thread_id, op);
      else this.db.prepare("DELETE FROM ops WHERE id = ?").run(op);
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      // SQLite may already have rolled back (e.g. on SQLITE_FULL); don't let that mask `e`.
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }

  private touch(threadId: string): void {
    this.db.prepare("UPDATE threads SET touched_at = ? WHERE id = ?").run(this.ts(), threadId);
  }

  getThread(id: string): Thread {
    const t = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Thread | undefined;
    if (!t) throw new PlantrailError(`No thread ${id}`);
    return t;
  }

  getNode(id: string): Node {
    const n = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as Node | undefined;
    if (!n) throw new PlantrailError(`No node ${id}`);
    return n;
  }

  /** Open blockers of a node: `blocks` edges from unresolved nodes. */
  blockers(id: string): Node[] {
    return this.db
      .prepare(
        `SELECT n.* FROM edges e JOIN nodes n ON n.id = e.from_id
         WHERE e.to_id = ? AND e.type = 'blocks' AND n.status NOT IN ('done','abandoned')`,
      )
      .all(id) as unknown as Node[];
  }

  children(id: string): Node[] {
    return this.db
      .prepare("SELECT * FROM nodes WHERE parent_id = ? ORDER BY priority DESC, rowid")
      .all(id) as unknown as Node[];
  }

  // ---------- threads & binding ----------

  createThread(title: string, goal: string, linkCwd = true, sessionId = this.session): Thread {
    return this.tx(() => {
      const id = this.nextId("t");
      const now = this.ts();
      this.db
        .prepare("INSERT INTO threads (id, title, goal, created_at, touched_at) VALUES (?, ?, ?, ?, ?)")
        .run(id, title, goal, now, now);
      if (linkCwd) for (const k of locationKeys(this.cwd)) this.addLink(id, k);
      this.bindInner(id, sessionId);
      return this.getThread(id);
    });
  }

  addLink(threadId: string, key: { kind: string; value: string }): void {
    this.db.prepare("INSERT OR IGNORE INTO links (thread_id, kind, value) VALUES (?, ?, ?)").run(
      threadId,
      key.kind,
      key.value,
    );
  }

  /**
   * Link a thread (default: bound) to the current location, e.g. after a repo
   * moved and its old path no longer matches. With `prune`, drop repo/dir links
   * whose path no longer exists. Returns what changed and the resulting links.
   */
  relink(threadId?: string, prune = false): { added: LinkKey[]; removed: LinkKey[]; links: LinkKey[] } {
    const t = threadId ? this.getThread(threadId) : this.current();
    return this.tx(() => {
      const links = () => this.links(t.id);
      const before = new Set(links().map((l) => `${l.kind}\0${l.value}`));
      const added = locationKeys(this.cwd).filter((k) => !before.has(`${k.kind}\0${k.value}`));
      for (const k of added) this.addLink(t.id, k);
      const removed = prune
        ? links().filter((l) => (isRepoKey(l) || l.kind === "worktree") && isAbsolute(l.value) && !existsSync(l.value))
        : [];
      const del = this.db.prepare("DELETE FROM links WHERE thread_id = ? AND kind = ? AND value = ?");
      for (const l of removed) del.run(t.id, l.kind, l.value);
      return { added, removed, links: links() };
    });
  }

  /** Attach a `url:` or `ticket:` link (e.g. an issue or PR) to a thread (default: bound). */
  linkRef(threadId: string | undefined, spec: string): { added: LinkKey[]; removed: LinkKey[]; links: LinkKey[] } {
    const t = threadId ? this.getThread(threadId) : this.current();
    const key = parseLink(spec);
    if (key.kind !== "url" && key.kind !== "ticket")
      throw new PlantrailError(`Only url: and ticket: links can be added by hand; repo/dir/worktree/branch links come from the current directory ('plantrail link'). Got '${spec}'`);
    return this.tx(() => {
      const before = this.links(t.id).length;
      this.addLink(t.id, key);
      const links = this.links(t.id);
      return { added: links.length > before ? [key] : [], removed: [], links };
    });
  }

  /** Remove one link, given as `kind:value` exactly as `link` prints it. */
  unlink(threadId: string | undefined, spec: string): { removed: LinkKey; links: LinkKey[] } {
    const t = threadId ? this.getThread(threadId) : this.current();
    const removed = parseLink(spec);
    return this.tx(() => {
      const r = this.db.prepare("DELETE FROM links WHERE thread_id = ? AND kind = ? AND value = ?").run(t.id, removed.kind, removed.value);
      if (!r.changes) throw new PlantrailError(`${t.id} has no link ${spec}`);
      return { removed, links: this.links(t.id) };
    });
  }

  listThreads(filter: "active" | "parked" | "done" | "all" = "active"): Thread[] {
    const sql =
      filter === "all"
        ? "SELECT * FROM threads ORDER BY touched_at DESC"
        : "SELECT * FROM threads WHERE status = ? ORDER BY touched_at DESC";
    const stmt = this.db.prepare(sql);
    return (filter === "all" ? stmt.all() : stmt.all(filter)) as unknown as Thread[];
  }

  /** A thread's links, sorted. */
  private links(threadId: string): LinkKey[] {
    return this.db.prepare("SELECT kind, value FROM links WHERE thread_id = ? ORDER BY kind, value").all(threadId).map((l) => ({ ...l })) as unknown as LinkKey[];
  }

  /** Threads with the given status linked to any of the given location keys, most recently touched first. */
  threadsForLocation(keys: LinkKey[], status: ThreadStatus = "active", limit = -1): Thread[] {
    if (!keys.length) return [];
    const cond = keys.map(() => "(l.kind = ? AND l.value = ?)").join(" OR ");
    return this.db
      .prepare(
        `SELECT DISTINCT t.* FROM threads t JOIN links l ON l.thread_id = t.id
         WHERE t.status = ? AND (${cond}) ORDER BY t.touched_at DESC LIMIT ?`,
      )
      .all(status, ...keys.flatMap((k) => [k.kind, k.value]), limit) as unknown as Thread[];
  }

  private bindInner(threadId: string, sessionId = this.session): void {
    this.bound = threadId;
    // Record under the real session id if known; otherwise a per-cwd pseudo session
    // so later processes in the same directory can pick the binding up.
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, thread_id, cwd, bound_at, pid) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET thread_id = excluded.thread_id, cwd = excluded.cwd, bound_at = excluded.bound_at, pid = excluded.pid`,
      )
      .run(sessionId ?? `cwd:${this.cwd}`, threadId, this.cwd, this.ts(), this.pid);
    this.touch(threadId);
  }

  /** Binding a parked thread reactivates it. Done threads stay done. */
  bind(threadId: string, sessionId = this.session): Thread {
    const t = this.getThread(threadId);
    if (t.status === "parked") this.setThreadStatus(t.id, "active");
    const keys = locationKeys(this.cwd);
    this.tx(() => {
      this.bindInner(t.id, sessionId);
      // Binding a thread of this repo from a worktree/branch links it there so it resumes without asking.
      const here = new Set(this.links(t.id).map((l) => `${l.kind}\0${l.value}`));
      if (keys.some((k) => isRepoKey(k) && here.has(`${k.kind}\0${k.value}`)))
        for (const k of keys) if (!isRepoKey(k)) this.addLink(t.id, k);
    });
    return this.getThread(t.id);
  }

  setThreadStatus(threadId: string, status: ThreadStatus): Thread {
    this.getThread(threadId);
    return this.tx(() => {
      this.db.prepare("UPDATE threads SET status = ?, touched_at = ? WHERE id = ?").run(status, this.ts(), threadId);
      return this.getThread(threadId);
    });
  }

  /** Mark a thread done so it stops auto-resuming. Returns it with the count of still-open nodes. */
  finishThread(threadId: string): { thread: Thread; open: number } {
    const t = this.getThread(threadId);
    if (t.status === "done") throw new PlantrailError(`${t.id} is already done. \`plantrail reopen ${t.id}\` reactivates it.`);
    const { n } = this.db
      .prepare("SELECT COUNT(*) AS n FROM nodes WHERE thread_id = ? AND status IN ('open','active','blocked')")
      .get(t.id) as { n: number };
    return { thread: this.setThreadStatus(t.id, "done"), open: n };
  }

  /** Reactivate a done (or parked) thread. */
  reopenThread(threadId: string): Thread {
    const t = this.getThread(threadId);
    if (t.status === "active") throw new PlantrailError(`${t.id} is already active.`);
    return this.setThreadStatus(t.id, "active");
  }

  /** Change a thread's title and/or goal; omitted fields are left as-is. */
  renameThread(threadId: string, title?: string, goal?: string): Thread {
    if (title === undefined && goal === undefined) throw new PlantrailError("Nothing to change: give a title and/or goal");
    if (title !== undefined && !title.trim()) throw new PlantrailError("Title must not be empty");
    const t = this.getThread(threadId);
    return this.tx(() => {
      this.db
        .prepare("UPDATE threads SET title = ?, goal = ?, touched_at = ? WHERE id = ?")
        .run(title?.trim() ?? t.title, goal?.trim() ?? t.goal, this.ts(), threadId);
      return this.getThread(threadId);
    });
  }

  /** Park active threads untouched for `days`. Returns the parked threads. */
  autoPark(days = PARK_AFTER_DAYS): Thread[] {
    const cutoff = new Date(this.now().getTime() - days * DAY).toISOString();
    return this.db
      .prepare("UPDATE threads SET status = 'parked' WHERE status = 'active' AND touched_at < ? RETURNING *")
      .all(cutoff) as unknown as Thread[];
  }

  /** Active thread bound to a session, if any. */
  private sessionThread(sessionId: string | null): string | null {
    if (!sessionId) return null;
    const r = this.db
      .prepare(
        `SELECT s.thread_id FROM sessions s JOIN threads t ON t.id = s.thread_id
         WHERE s.session_id = ? AND t.status = 'active'`,
      )
      .get(sessionId) as { thread_id: string } | undefined;
    return r?.thread_id ?? null;
  }

  /**
   * Active threads linked to this location, best first: scored by the specific
   * keys they match here (branch 2 + worktree 1; repo/dir only 0), then by
   * recency. `top` is the leading run sharing the best score.
   */
  private rankedHere(keys: LinkKey[]): { ranked: { thread: Thread; score: number }[]; top: Thread[] } {
    const weight: Partial<Record<LinkKey["kind"], number>> = { worktree: 1, branch: 2 };
    const here = new Set(keys.map((k) => `${k.kind}\0${k.value}`));
    const score = (t: Thread) =>
      this.links(t.id).reduce((n, l) => n + (here.has(`${l.kind}\0${l.value}`) ? (weight[l.kind] ?? 0) : 0), 0);
    // Stable sort keeps threadsForLocation's most-recently-touched order within a score.
    const ranked = this.threadsForLocation(keys)
      .map((thread) => ({ thread, score: score(thread) }))
      .sort((a, b) => b.score - a.score);
    return { ranked, top: ranked.filter((r) => r.score === ranked[0].score).map((r) => r.thread) };
  }

  /**
   * The thread this location resolves to without a session binding: the most
   * specific active thread linked here, with `recent` (e.g. the cwd's latest
   * binding) winning unless a linked thread outranks it. Null when the top rank
   * is tied, or nothing matches. A unique match gets this location's repo keys
   * so it keeps matching if one of them (e.g. the path) changes.
   */
  private locate(keys: LinkKey[], recent: string | null): { id: string | null; ranked: Thread[] } {
    const { ranked, top } = this.rankedHere(keys);
    const threads = ranked.map((r) => r.thread);
    if (recent && (ranked.find((r) => r.thread.id === recent)?.score ?? 0) >= (ranked[0]?.score ?? 0)) return { id: recent, ranked: threads };
    if (top.length !== 1) return { id: null, ranked: threads };
    for (const k of keys) if (isRepoKey(k)) this.addLink(top[0].id, k);
    return { id: top[0].id, ranked: threads };
  }

  /**
   * Thread for the current process: explicit binding, else this session's
   * binding, else the most specific active thread linked to this location,
   * with the cwd's most recent binding breaking ties (for callers without a
   * session id).
   */
  current(): Thread {
    if (this.bound) return this.getThread(this.bound);
    const own = this.sessionThread(this.session);
    if (own) return this.getThread((this.bound = own));
    const recent = this.db
      .prepare(
        `SELECT s.thread_id FROM sessions s JOIN threads t ON t.id = s.thread_id
         WHERE s.cwd = ? AND t.status = 'active' ORDER BY s.bound_at DESC LIMIT 1`,
      )
      .get(this.cwd) as { thread_id: string } | undefined;
    const keys = locationKeys(this.cwd);
    const { id, ranked } = this.locate(keys, recent?.thread_id ?? null);
    if (id) return this.getThread((this.bound = id));
    const hint = ranked.length
      ? `Linked threads here: ${ranked.map((t) => `${t.id} "${t.title}"`).join(", ")}.`
      : "Use `plantrail threads` or `plantrail create`.";
    const inactive = ranked.length ? "" : this.inactiveHere(keys);
    throw new NotBoundError(`No thread bound. Run \`plantrail bind <thread_id>\`. ${hint}${inactive && `\n${inactive}`}`);
  }

  // ---------- nodes ----------

  add(items: AddItem[]): Node[] {
    const thread = this.current();
    return this.tx(() => {
      const now = this.ts();
      const ids: string[] = [];
      const resolve = (ref: string): string => {
        const m = /^#(\d+)$/.exec(ref);
        if (m) {
          // `#i` is 1-based, like node ids: #1 is the first item.
          const i = Number(m[1]);
          const id = ids[i - 1];
          if (id) return id;
          if (i < 1 || i > items.length)
            throw new PlantrailError(`Reference ${ref} is out of range: this call has ${items.length} item(s), #1..#${items.length} (#1 is the first)`);
          throw new PlantrailError(`Reference ${ref} in parent/blocked_by must point to an earlier item in this call (#1 is the first); use blocks for forward edges`);
        }
        const n = this.getNode(ref);
        if (n.thread_id !== thread.id) throw new PlantrailError(`${ref} belongs to thread ${n.thread_id}`);
        return n.id;
      };
      const insert = this.db.prepare(
        `INSERT INTO nodes (id, thread_id, parent_id, kind, title, body, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const edge = (from: string, to: string) => this.blockEdge(from, to);
      const deferred: [string, string][] = [];
      for (const it of items) {
        const id = this.nextId("n");
        // Resolve before pushing so `#i` can't refer to item i itself.
        const parent = it.parent ? resolve(it.parent) : null;
        const blockedBy = (it.blocked_by ?? []).map(resolve);
        ids.push(id);
        insert.run(
          id,
          thread.id,
          parent,
          it.kind ?? "task",
          it.title,
          it.body ?? null,
          it.priority ?? 0,
          now,
          now,
        );
        for (const b of blockedBy) edge(b, id);
        // `blocks` may point forward within the batch; resolve after all inserts.
        for (const b of it.blocks ?? []) deferred.push([id, b]);
      }
      for (const [from, ref] of deferred) edge(from, resolve(ref));
      this.touch(thread.id);
      return ids.map((id) => this.getNode(id));
    });
  }

  start(id: string): { node: Node; demoted: string[] } {
    return this.tx(() => {
      const node = this.getNode(id);
      if (RESOLVED.includes(node.status)) throw new PlantrailError(`${id} is ${node.status}; reopen it with update first`);
      const blockers = this.blockers(id);
      if (blockers.length)
        throw new PlantrailError(`${id} is blocked by ${blockers.map((b) => `${b.id} "${b.title}"`).join(", ")}`);
      if (node.status === "blocked")
        throw new PlantrailError(`${id} is marked blocked; update its status to open first`);
      const now = this.ts();
      const demoted = (
        this.db
          .prepare("SELECT id FROM nodes WHERE thread_id = ? AND status = 'active' AND id != ?")
          .all(node.thread_id, id) as { id: string }[]
      ).map((r) => r.id);
      this.db
        .prepare("UPDATE nodes SET status = 'open', updated_at = ? WHERE thread_id = ? AND status = 'active' AND id != ?")
        .run(now, node.thread_id, id);
      this.db.prepare("UPDATE nodes SET status = 'active', updated_at = ? WHERE id = ?").run(now, id);
      this.touch(node.thread_id);
      return { node: this.getNode(id), demoted };
    });
  }

  done(id: string, summary: string, refs?: string[]): { node: Node; unblocked: Node[]; parentReady: Node | null } {
    if (!summary?.trim()) throw new PlantrailError("done requires a non-empty summary");
    return this.tx(() => {
      const node = this.getNode(id);
      this.checkClosable(node);
      return this.complete(node, summary.trim(), refs, this.ts());
    });
  }

  /** A node can be completed only if it's unresolved, unblocked, and its children are resolved. */
  private checkClosable(node: Node): void {
    if (node.status === "done") throw new PlantrailError(`${node.id} is already done`);
    if (node.status === "abandoned") throw new PlantrailError(`${node.id} is abandoned; reopen it with update first`);
    const blockers = this.blockers(node.id);
    if (blockers.length)
      throw new PlantrailError(`${node.id} is blocked by ${blockers.map((b) => `${b.id} "${b.title}"`).join(", ")}`);
    this.checkChildrenResolved(node.id);
  }

  private checkChildrenResolved(id: string): void {
    const open = this.children(id).filter((c) => !RESOLVED.includes(c.status));
    if (open.length)
      throw new PlantrailError(`${id} has unresolved children: ${open.map((c) => c.id).join(", ")}`);
  }

  private complete(node: Node, summary: string, refs: string[] | undefined, now: string) {
    this.db
      .prepare("UPDATE nodes SET status = 'done', summary = ?, refs = ?, updated_at = ? WHERE id = ?")
      .run(summary, refs?.length ? JSON.stringify(refs) : null, now, node.id);
    const unblocked = this.releaseDependents(node.id, now);
    this.touch(node.thread_id);
    return { node: this.getNode(node.id), unblocked, parentReady: this.parentReady(node.parent_id) };
  }

  /** Dependents of `id` that no longer have open blockers; `blocked` ones are reopened. */
  private releaseDependents(id: string, now: string): Node[] {
    const deps = this.db
      .prepare(
        `SELECT n.* FROM edges e JOIN nodes n ON n.id = e.to_id
         WHERE e.from_id = ? AND e.type = 'blocks' AND n.status NOT IN ('done','abandoned')`,
      )
      .all(id) as unknown as Node[];
    const freed: Node[] = [];
    for (const d of deps) {
      if (this.blockers(d.id).length) continue;
      if (d.status === "blocked")
        this.db.prepare("UPDATE nodes SET status = 'open', updated_at = ? WHERE id = ?").run(now, d.id);
      freed.push(this.getNode(d.id));
    }
    return freed;
  }

  private parentReady(parentId: string | null): Node | null {
    if (!parentId) return null;
    const parent = this.getNode(parentId);
    if (RESOLVED.includes(parent.status)) return null;
    return this.children(parentId).every((c) => RESOLVED.includes(c.status)) ? parent : null;
  }

  /**
   * Record a finding under a question (or any node it informs). Findings are
   * facts, so they are created done: the text is the summary, sources the refs.
   * With `answers`, the finding also closes its parent question: an `answers`
   * edge is added and the question is completed with the finding as summary.
   */
  recordFinding(
    parentId: string,
    text: string,
    confidence?: number,
    sources?: string[],
    answers = false,
  ): { node: Node; closed: { node: Node; unblocked: Node[]; parentReady: Node | null } | null } {
    if (!text?.trim()) throw new PlantrailError("A finding needs text");
    if (confidence !== undefined && !(confidence >= 0 && confidence <= 1))
      throw new PlantrailError("confidence must be between 0 and 1");
    const t = text.trim();
    return this.tx(() => {
      const parent = this.getNode(parentId);
      if (parent.kind === "finding") throw new PlantrailError(`${parentId} is a finding; attach to the question it informs`);
      if (answers) {
        if (parent.kind !== "question") throw new PlantrailError(`${parentId} is a ${parent.kind}; only questions can be answered`);
        this.checkClosable(parent);
      }
      const id = this.nextId("n");
      const now = this.ts();
      this.db
        .prepare(
          `INSERT INTO nodes (id, thread_id, parent_id, kind, title, status, summary, refs, confidence, created_at, updated_at)
           VALUES (?, ?, ?, 'finding', ?, 'done', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parent.thread_id,
          parent.id,
          clip(t.split("\n")[0], 100),
          t,
          sources?.length ? JSON.stringify(sources) : null,
          confidence ?? null,
          now,
          now,
        );
      let closed = null;
      if (answers) {
        this.db.prepare("INSERT INTO edges (from_id, to_id, type) VALUES (?, ?, 'answers')").run(id, parent.id);
        closed = this.complete(parent, `Answered by ${id}: ${t}`, sources, now);
      }
      this.touch(parent.thread_id);
      return { node: this.getNode(id), closed };
    });
  }

  update(
    id: string,
    fields: {
      title?: string;
      body?: string;
      status?: NodeStatus;
      priority?: number;
      summary?: string;
      kind?: NodeKind;
      /** New parent id, or null to move to the top level. */
      parent?: string | null;
    },
  ): { node: Node; unblocked: Node[] } {
    if (fields.status === "done")
      throw new PlantrailError("Use done(id, summary) to complete a node");
    if (fields.status === "active") throw new PlantrailError("Use start(id) to activate a node");
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const k of ["title", "body", "status", "priority", "summary", "kind"] as const) {
      if (fields[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(fields[k] as string | number);
      }
    }
    if (fields.parent !== undefined) {
      sets.push("parent_id = ?");
      vals.push(fields.parent);
    }
    if (!sets.length) throw new PlantrailError("No fields to update");
    return this.tx(() => {
      const node = this.getNode(id);
      if (fields.parent) this.checkMove(node, fields.parent);
      if (fields.status === "abandoned" && !(fields.summary ?? node.summary)?.trim())
        throw new PlantrailError("Abandoning requires a summary explaining why");
      const now = this.ts();
      this.db.prepare(`UPDATE nodes SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, now, id);
      const unblocked = fields.status === "abandoned" ? this.releaseDependents(id, now) : [];
      this.touch(node.thread_id);
      return { node: this.getNode(id), unblocked };
    });
  }

  /** A node can move under another node of its thread, but not under itself or its own subtree. */
  private checkMove(node: Node, parentId: string): void {
    const parent = this.getNode(parentId);
    if (parent.thread_id !== node.thread_id) throw new PlantrailError(`${parentId} belongs to thread ${parent.thread_id}`);
    if (parent.kind === "finding") throw new PlantrailError(`${parentId} is a finding and can't have children`);
    const seen = new Set<string>();
    for (let p: Node | null = parent; p && !seen.has(p.id); p = p.parent_id ? this.getNode(p.parent_id) : null)
      if (seen.add(p.id) && p.id === node.id) throw new PlantrailError(`Can't move ${node.id} under its own subtree (${parentId})`);
  }

  /**
   * Add an edge after creation. `blocks` stays within a thread and may not form
   * a cycle; derived_from/contradicts may cross threads (reusing research).
   * `answers` edges are managed by recordFinding.
   */
  addEdge(from: string, type: EdgeType, to: string): { from: Node; to: Node } {
    return this.tx(() => {
      const [a, b] = [this.getNode(from), this.getNode(to)];
      if (a.id === b.id) throw new PlantrailError("A node cannot have an edge to itself");
      if (type === "blocks" && a.thread_id !== b.thread_id)
        throw new PlantrailError(`${to} belongs to thread ${b.thread_id}; blocks edges stay within a thread`);
      const added =
        type === "blocks"
          ? this.blockEdge(a.id, b.id)
          : this.db.prepare("INSERT OR IGNORE INTO edges (from_id, to_id, type) VALUES (?, ?, ?)").run(a.id, b.id, type).changes > 0;
      if (!added) throw new PlantrailError(`${from} ${type} ${to} already exists`);
      this.touch(a.thread_id);
      return { from: a, to: this.getNode(b.id) };
    });
  }

  /** Insert `from blocks to` unless it would form a cycle. Call inside tx(). Returns false if it already existed. */
  private blockEdge(from: string, to: string): boolean {
    if (from === to) throw new PlantrailError("A node cannot block itself");
    const reach = this.db
      .prepare(
        `WITH RECURSIVE r(id) AS (SELECT ? UNION SELECT e.to_id FROM edges e JOIN r ON e.from_id = r.id WHERE e.type = 'blocks')
         SELECT 1 FROM r WHERE id = ?`,
      )
      .get(to, from);
    if (reach) throw new PlantrailError(`${to} already (transitively) blocks ${from}; that would be a cycle`);
    return this.db.prepare("INSERT OR IGNORE INTO edges (from_id, to_id, type) VALUES (?, ?, 'blocks')").run(from, to).changes > 0;
  }

  /** Remove an edge. Removing the last open blocker reopens a `blocked` target. */
  removeEdge(from: string, type: EdgeType, to: string): { unblocked: Node[] } {
    return this.tx(() => {
      const a = this.getNode(from);
      const r = this.db.prepare("DELETE FROM edges WHERE from_id = ? AND to_id = ? AND type = ?").run(from, to, type);
      if (!r.changes) throw new PlantrailError(`No edge ${from} ${type} ${to}`);
      const now = this.ts();
      let unblocked: Node[] = [];
      if (type === "blocks" && !RESOLVED.includes(a.status)) {
        const t = this.getNode(to);
        if (!RESOLVED.includes(t.status) && !this.blockers(to).length) {
          if (t.status === "blocked") this.db.prepare("UPDATE nodes SET status = 'open', updated_at = ? WHERE id = ?").run(now, to);
          unblocked = [this.getNode(to)];
        }
      }
      this.touch(a.thread_id);
      return { unblocked };
    });
  }

  /** Delete a mistaken node. Only leaves with no edges, so nothing else loses context. */
  deleteNode(id: string): Node {
    return this.tx(() => {
      const node = this.getNode(id);
      const kids = this.children(id);
      if (kids.length)
        throw new PlantrailError(`${id} has children (${kids.map((c) => c.id).join(", ")}); move or delete them first, or abandon it`);
      const edges = this.db
        .prepare("SELECT from_id, to_id, type FROM edges WHERE from_id = ? OR to_id = ?")
        .all(id, id) as { from_id: string; to_id: string; type: string }[];
      if (edges.length)
        throw new PlantrailError(
          `${id} has edges (${edges.map((e) => `${e.from_id} ${e.type} ${e.to_id}`).join(", ")}); abandon it instead`,
        );
      this.db.prepare("DELETE FROM nodes WHERE id = ?").run(id);
      this.touch(node.thread_id);
      return node;
    });
  }

  // ---------- ranking ----------

  /**
   * Rank open, unblocked tasks/questions. Leaves beat containers, explicit
   * priority dominates, deeper (more concrete) nodes get a small boost, and
   * nodes untouched for a while float up so nothing rots. Questions with no
   * findings (unexplored), only low-confidence ones, or a pair of findings
   * that contradict each other (contested) get a boost so research goes where
   * the uncertainty is.
   */
  nextOptions(n = 3, threadId?: string): Option[] {
    return this.rank(this.graph(threadId ?? this.current().id), n);
  }

  private rank(g: Graph, n: number): Option[] {
    const now = this.now().getTime();
    const opts: Option[] = [];
    for (const node of g.nodes.values()) {
      if (node.status !== "open" || (node.kind !== "task" && node.kind !== "question")) continue;
      if (g.blockers.has(node.id)) continue;
      const kids = g.kids.get(node.id) ?? [];
      const openKids = kids.filter((c) => !RESOLVED.includes(c.status)).length;
      let depth = 0;
      // Guard against parent cycles in existing data.
      for (let p = node.parent_id, seen = new Set([node.id]); p && g.nodes.has(p) && !seen.has(p); p = g.nodes.get(p)!.parent_id) {
        seen.add(p);
        depth++;
      }
      const staleDays = Math.min(7, (now - Date.parse(node.updated_at)) / DAY);
      const leaf = openKids === 0 ? 5 : 0;
      let research = 0;
      let researchWhy: string | null = null;
      if (node.kind === "question") {
        const findings = kids.filter((c) => c.kind === "finding");
        const confs = findings.map((f) => f.confidence).filter((c) => c != null);
        const best = confs.length ? Math.max(...confs) : null;
        const ids = new Set(findings.map((f) => f.id));
        const contested = g.contradicts.find((e) => ids.has(e.from_id) && ids.has(e.to_id));
        if (!findings.length) [research, researchWhy] = [3, "unexplored"];
        else if (contested) [research, researchWhy] = [3, `contested ${contested.from_id}⟂${contested.to_id}`];
        else if (best == null || best < 0.7) {
          research = 3 * (1 - (best ?? 0.5));
          researchWhy = `low confidence ${best ?? "unrated"}`;
        }
      }
      const score = node.priority * 10 + leaf + depth * 1.5 + staleDays * 0.5 + research;
      const why = [
        node.priority ? `p${node.priority}` : null,
        openKids ? `${openKids} open children` : "leaf",
        researchWhy,
        depth ? `depth ${depth}` : null,
        staleDays >= 1 ? `idle ${Math.floor(staleDays)}d` : null,
      ]
        .filter(Boolean)
        .join(", ");
      opts.push({ node, score: Math.round(score * 10) / 10, why });
    }
    return opts.sort(byScore).slice(0, n);
  }

  /**
   * A thread's nodes, children by parent, open blockers by node, and
   * contradicts edges, loaded in three queries so ranking doesn't query per
   * candidate.
   */
  private graph(threadId: string): Graph {
    const rows = this.db
      .prepare("SELECT * FROM nodes WHERE thread_id = ? ORDER BY priority DESC, rowid")
      .all(threadId) as unknown as Node[];
    const nodes = new Map(rows.map((n) => [n.id, n]));
    const kids = new Map<string, Node[]>();
    for (const n of rows) if (n.parent_id) kids.set(n.parent_id, [...(kids.get(n.parent_id) ?? []), n]);
    const blockers = new Map<string, string[]>();
    const edges = this.db
      .prepare(
        `SELECT e.from_id, e.to_id FROM edges e JOIN nodes b ON b.id = e.from_id JOIN nodes t ON t.id = e.to_id
         WHERE t.thread_id = ? AND e.type = 'blocks' AND b.status NOT IN ('done','abandoned')`,
      )
      .all(threadId) as { from_id: string; to_id: string }[];
    for (const e of edges) blockers.set(e.to_id, [...(blockers.get(e.to_id) ?? []), e.from_id]);
    const contradicts = this.db
      .prepare(
        `SELECT e.from_id, e.to_id FROM edges e JOIN nodes a ON a.id = e.from_id JOIN nodes b ON b.id = e.to_id
         WHERE (a.thread_id = ? OR b.thread_id = ?) AND e.type = 'contradicts' ORDER BY e.rowid`,
      )
      .all(threadId, threadId) as { from_id: string; to_id: string }[];
    return { nodes, kids, blockers, contradicts };
  }

  /** nextOptions merged across every active thread, each tagged with its thread title. */
  nextOptionsAll(n = 3): Option[] {
    return this.listThreads("active")
      .flatMap((t) => this.nextOptions(n, t.id).map((o) => ({ ...o, thread_title: t.title })))
      .sort(byScore)
      .slice(0, n);
  }

  // ---------- search ----------

  /**
   * Full-text search over node title/summary/body (FTS5, bm25 with title
   * weighted highest). Words are matched as prefixes and all must appear;
   * quote a phrase to match it exactly. Scoped to the current thread unless
   * `all` is set.
   */
  search(query: string, opts: { all?: boolean; kind?: NodeKind; limit?: number } = {}): SearchHit[] {
    const match = ftsQuery(query);
    const tid = opts.all ? null : this.current().id;
    return this.db
      .prepare(
        `SELECT n.*, t.title AS thread_title,
                snippet(nodes_fts, -1, '[', ']', '…', 12) AS snippet
         FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid JOIN threads t ON t.id = n.thread_id
         WHERE nodes_fts MATCH ? AND (? IS NULL OR n.thread_id = ?) AND (? IS NULL OR n.kind = ?)
         ORDER BY bm25(nodes_fts, 10, 5, 1) LIMIT ?`,
      )
      .all(match, tid, tid, opts.kind ?? null, opts.kind ?? null, opts.limit ?? 10)
      .map((r) => {
        const { thread_title, snippet, ...node } = r as unknown as Node & { thread_title: string; snippet: string };
        return { node, snippet, thread_title };
      });
  }

  /**
   * Findings/decisions from other threads that share words with this thread's
   * title and goal (any word matches, ranked by bm25). Capped for status().
   */
  related(threadId: string, limit = 3): SearchHit[] {
    const t = this.getThread(threadId);
    const words = [...new Set(
      `${t.title} ${t.goal ?? ""}`.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [],
    )].filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    if (!words.length) return [];
    return this.db
      .prepare(
        `SELECT n.*, t.title AS thread_title,
                snippet(nodes_fts, -1, '[', ']', '…', 8) AS snippet
         FROM nodes_fts JOIN nodes n ON n.rowid = nodes_fts.rowid JOIN threads t ON t.id = n.thread_id
         WHERE nodes_fts MATCH ? AND n.thread_id != ? AND n.kind IN ('finding','decision') AND n.status = 'done'
         ORDER BY bm25(nodes_fts, 10, 5, 1) LIMIT ?`,
      )
      .all(words.map((w) => `"${w}"*`).join(" OR "), t.id, limit)
      .map((r) => {
        const { thread_title, snippet, ...node } = r as unknown as Node & { thread_title: string; snippet: string };
        return { node, snippet, thread_title };
      });
  }

  // ---------- checkpoints & status ----------

  checkpoint(note: string): { id: number } {
    if (!note?.trim()) throw new PlantrailError("checkpoint requires a note");
    const t = this.current();
    const active = this.db
      .prepare("SELECT id FROM nodes WHERE thread_id = ? AND status = 'active'")
      .all(t.id) as { id: string }[];
    const frontier = {
      active: active.map((a) => a.id),
      next: this.nextOptions(5, t.id).map((o) => o.node.id),
    };
    return this.tx(() => {
      const r = this.db
        .prepare("INSERT INTO checkpoints (thread_id, note, frontier_json, created_at) VALUES (?, ?, ?, ?)")
        .run(t.id, note.trim(), JSON.stringify(frontier), this.ts());
      this.touch(t.id);
      return { id: Number(r.lastInsertRowid) };
    });
  }

  /**
   * Recent history of a thread (default: bound), newest first: checkpoints and
   * resolved (done/abandoned) nodes, timed by their last update.
   */
  log(n = 10, threadId?: string): LogEntry[] {
    const t = threadId ? this.getThread(threadId) : this.current();
    const cps = this.db
      .prepare("SELECT note, created_at FROM checkpoints WHERE thread_id = ? ORDER BY id DESC LIMIT ?")
      .all(t.id, n) as { note: string; created_at: string }[];
    const nodes = this.db
      .prepare(
        "SELECT * FROM nodes WHERE thread_id = ? AND status IN ('done','abandoned') ORDER BY updated_at DESC, rowid DESC LIMIT ?",
      )
      .all(t.id, n) as unknown as Node[];
    const entries: LogEntry[] = [
      ...cps.map((c) => ({ at: c.created_at, checkpoint: c.note })),
      ...nodes.map((node) => ({ at: node.updated_at, node })),
    ];
    // Stable sort keeps checkpoints ahead of nodes resolved in the same instant.
    return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, n);
  }

  statusText(threadId?: string): string {
    const t = threadId ? this.getThread(threadId) : this.current();
    const g = this.graph(t.id);
    const all = [...g.nodes.values()];
    const counts: Record<string, number> = {};
    for (const n of all) counts[n.status] = (counts[n.status] ?? 0) + 1;
    const active = all.filter((n) => n.status === "active");
    const blocked = all.filter(
      (n) => n.status === "blocked" || (n.status === "open" && g.blockers.has(n.id)),
    );
    const cp = this.db
      .prepare("SELECT note, created_at FROM checkpoints WHERE thread_id = ? ORDER BY id DESC LIMIT 1")
      .get(t.id) as { note: string; created_at: string } | undefined;
    const lines = [`[plantrail] ${t.id} "${t.title}" (${t.status})`];
    if (t.goal) lines.push(`Goal: ${clip(t.goal, 200)}`);
    const countStr = NODE_STATUSES
      .filter((s) => counts[s])
      .map((s) => `${counts[s]} ${s}`)
      .join(", ");
    lines.push(`Nodes: ${countStr || "none"}`);
    if (active.length) {
      const now = this.now().getTime();
      const flag = (n: Node) => {
        const d = Math.floor((now - Date.parse(n.updated_at)) / DAY);
        return d >= STALE_ACTIVE_DAYS ? ` [active ${d}d with no updates — finish, split, or mark blocked?]` : "";
      };
      lines.push(`Active: ${active.map((n) => fmt(n) + flag(n)).join("; ")}`);
    }
    const next = this.rank(g, 3);
    if (next.length) {
      lines.push("Next:");
      for (const o of next) lines.push(`  ${fmt(o.node)}`);
    }
    if (blocked.length) {
      lines.push("Blocked:");
      for (const b of blocked.slice(0, 5)) {
        const by = g.blockers.get(b.id) ?? [];
        lines.push(`  ${fmt(b)}${by.length ? ` ← ${by.join(", ")}` : ""}`);
      }
      if (blocked.length > 5) lines.push(`  …${blocked.length - 5} more`);
    }
    // Contradictions stay listed until the question they sit under is resolved.
    const unsettled = (id: string) => {
      const n = g.nodes.get(id);
      if (!n) return false;
      const p = n.parent_id ? g.nodes.get(n.parent_id) : undefined;
      return n.status !== "abandoned" && !(p && RESOLVED.includes(p.status));
    };
    const contra = g.contradicts.filter((e) => unsettled(e.from_id) || unsettled(e.to_id));
    if (contra.length) {
      lines.push("Contradictions:");
      const side = (id: string) => (g.nodes.has(id) ? fmt(g.nodes.get(id)!) : `${id} [other thread]`);
      for (const e of contra.slice(0, 5)) lines.push(`  ${side(e.from_id)} ⟂ ${side(e.to_id)}`);
      if (contra.length > 5) lines.push(`  …${contra.length - 5} more`);
    }
    const rel = this.related(t.id);
    if (rel.length) {
      lines.push("Related (other threads):");
      for (const h of rel) lines.push(`  ${fmt(h.node)} [${h.node.thread_id}]: ${clip(h.node.summary ?? h.snippet, 120)}`);
    }
    if (cp) lines.push(`Last checkpoint (${cp.created_at.slice(0, 16)}): ${clip(cp.note, 400)}`);
    return lines.join("\n");
  }

  getText(id: string, depth = 0): string {
    const n = this.getNode(id);
    const lines = [
      `${n.id} [${n.kind}/${n.status}${n.priority ? ` p${n.priority}` : ""}${n.confidence != null ? ` conf ${n.confidence}` : ""}] ${n.title}`,
      `thread ${n.thread_id}${n.parent_id ? `, parent ${n.parent_id}` : ""}, updated ${n.updated_at.slice(0, 16)}`,
    ];
    if (n.body) lines.push(`Body: ${n.body}`);
    if (n.summary) lines.push(`Summary: ${n.summary}`);
    if (n.refs) lines.push(`Refs: ${(JSON.parse(n.refs) as string[]).join(", ")}`);
    const by = this.blockers(id);
    if (by.length) lines.push(`Blocked by: ${by.map(fmt).join("; ")}`);
    const blocks = this.db
      .prepare("SELECT to_id FROM edges WHERE from_id = ? AND type = 'blocks'")
      .all(id) as { to_id: string }[];
    if (blocks.length) lines.push(`Blocks: ${blocks.map((b) => b.to_id).join(", ")}`);
    const rel = this.db
      .prepare(
        `SELECT from_id, to_id, type FROM edges WHERE (from_id = ? OR to_id = ?) AND type IN ('derived_from','contradicts')`,
      )
      .all(id, id) as { from_id: string; to_id: string; type: string }[];
    for (const e of rel)
      lines.push(e.from_id === id ? `${e.type === "contradicts" ? "Contradicts" : "Derived from"}: ${e.to_id}` : `${e.type === "contradicts" ? "Contradicted by" : "Source of"}: ${e.from_id}`);
    const walk = (pid: string, d: number, indent: string) => {
      for (const c of this.children(pid)) {
        lines.push(`${indent}${fmt(c)}${c.confidence != null ? ` (conf ${c.confidence})` : ""}${c.summary ? ` — ${clip(c.summary, 120)}` : ""}`);
        if (d > 1) walk(c.id, d - 1, indent + "  ");
      }
    };
    if (depth > 0) {
      lines.push("Children:");
      walk(id, depth, "  ");
    } else {
      const k = this.children(id).length;
      if (k) lines.push(`${k} children (use depth>0 to list)`);
    }
    return lines.join("\n");
  }

  // ---------- history & undo ----------

  /** Recorded ops touching a thread (default: bound), newest first, with their changes described. */
  history(n = 10, threadId?: string): OpEntry[] {
    const t = threadId ? this.getThread(threadId) : this.current();
    const ops = this.db
      .prepare("SELECT id, at, label, undoes, undone_by FROM ops WHERE thread_id = ? AND NOT open ORDER BY id DESC LIMIT ?")
      .all(t.id, n) as unknown as Omit<OpEntry, "changes">[];
    return ops.map((o) => ({ ...o, changes: this.opEvents(o.id).map(describeEvent) }));
  }

  private opEvents(opId: number, newestFirst = false): EventRow[] {
    return this.db
      .prepare(`SELECT seq, tbl, action, row_key, old, new FROM events WHERE op_id = ? ORDER BY seq ${newestFirst ? "DESC" : ""}`)
      .all(opId) as unknown as EventRow[];
  }

  /**
   * Revert the latest op on the bound thread that isn't an undo or already
   * undone, so repeated undos walk back. Refuses if any row it touched has
   * changed since (e.g. by a later, unrecorded write) or if it created a thread.
   * With `dryRun`, only reports what would be reverted.
   */
  undo(dryRun = false): OpEntry {
    const t = this.current();
    return this.tx(() => {
      const op = this.db
        .prepare(
          `SELECT id, at, label, undoes, undone_by FROM ops
           WHERE thread_id = ? AND NOT open AND undoes IS NULL AND undone_by IS NULL ORDER BY id DESC LIMIT 1`,
        )
        .get(t.id) as Omit<OpEntry, "changes"> | undefined;
      if (!op) throw new PlantrailError(`Nothing to undo in ${t.id}`);
      const events = this.opEvents(op.id, true);
      for (const e of events) {
        if (e.tbl === "threads" && e.action === "insert")
          throw new PlantrailError(`op ${op.id} created thread ${JSON.parse(e.row_key).id}; undo can't remove threads (use \`plantrail finish\`)`);
        const { pk } = AUDITED[e.tbl];
        const where = pk.map((c) => `${c} = json_extract(:key, '$.${c}')`).join(" AND ");
        const cur = this.db.prepare(`SELECT ${rowJson(e.tbl)} AS j FROM ${e.tbl} WHERE ${where}`).get({ key: e.row_key }) as
          | { j: string }
          | undefined;
        if ((cur?.j ?? null) !== e.new)
          throw new PlantrailError(`Can't undo op ${op.id}: ${describeEvent(e).split(":")[0]} has changed since`);
      }
      const entry = { ...op, changes: [...events].reverse().map(describeEvent) };
      if (dryRun) return entry;
      for (const e of events) {
        const { pk, cols } = AUDITED[e.tbl];
        const where = pk.map((c) => `${c} = json_extract(:key, '$.${c}')`).join(" AND ");
        const val = (c: string) => `json_extract(:row, '$.${c}')`;
        const sql =
          e.action === "insert"
            ? `DELETE FROM ${e.tbl} WHERE ${where}`
            : e.action === "delete"
              ? `INSERT INTO ${e.tbl} (${cols.join(", ")}) SELECT ${cols.map(val).join(", ")}`
              : `UPDATE ${e.tbl} SET ${cols.map((c) => `${c} = ${val(c)}`).join(", ")} WHERE ${where}`;
        const params: Record<string, string> = {};
        if (e.action !== "delete") params.key = e.row_key;
        if (e.action !== "insert") params.row = e.old!;
        this.db.prepare(sql).run(params);
      }
      this.db.prepare("UPDATE ops SET undoes = ? WHERE open").run(op.id);
      this.db.prepare("UPDATE ops SET undone_by = (SELECT id FROM ops WHERE open) WHERE id = ?").run(op.id);
      this.touch(t.id);
      return entry;
    });
  }

  // ---------- export ----------

  /** Full dump of a thread (default: bound): nodes in tree order, edges, links, checkpoints. */
  exportData(threadId?: string): ThreadExport {
    const t = threadId ? this.getThread(threadId) : this.current();
    const all = this.db
      .prepare("SELECT * FROM nodes WHERE thread_id = ? ORDER BY priority DESC, rowid")
      .all(t.id) as unknown as Node[];
    const kids = new Map<string | null, Node[]>();
    for (const n of all) kids.set(n.parent_id, [...(kids.get(n.parent_id) ?? []), n]);
    const nodes: Node[] = [];
    const walk = (pid: string | null) => {
      for (const n of kids.get(pid) ?? []) {
        nodes.push(n);
        walk(n.id);
      }
    };
    walk(null);
    return {
      version: 1,
      exported_at: this.ts(),
      thread: t,
      nodes: nodes.map((n) => ({ ...n, refs: n.refs ? (JSON.parse(n.refs) as string[]) : null })),
      edges: this.db
        .prepare(
          `SELECT e.from_id, e.to_id, e.type FROM edges e JOIN nodes n ON n.id = e.from_id
           WHERE n.thread_id = ? ORDER BY e.rowid`,
        )
        .all(t.id) as unknown as ThreadExport["edges"],
      links: this.links(t.id),
      checkpoints: this.db
        .prepare("SELECT id, note, frontier_json, created_at FROM checkpoints WHERE thread_id = ? ORDER BY id")
        .all(t.id)
        .map((c: any) => ({ id: c.id, note: c.note, frontier: JSON.parse(c.frontier_json), created_at: c.created_at })),
    };
  }

  exportMarkdown(threadId?: string): string {
    const x = this.exportData(threadId);
    const blockedBy = new Map<string, string[]>();
    for (const e of x.edges) if (e.type === "blocks") blockedBy.set(e.to_id, [...(blockedBy.get(e.to_id) ?? []), e.from_id]);
    const mark: Record<NodeStatus, string> = { open: "[ ]", active: "[~]", blocked: "[!]", done: "[x]", abandoned: "[-]" };
    const depthOf = new Map<string, number>();
    const L = [`# ${x.thread.title} (${x.thread.id})`, "", `Status: ${x.thread.status} · created ${x.thread.created_at.slice(0, 10)} · touched ${x.thread.touched_at.slice(0, 10)}`];
    if (x.thread.goal) L.push("", `**Goal:** ${x.thread.goal}`);
    if (x.links.length) L.push("", `Links: ${x.links.map((l) => `${l.kind}:${l.value}`).join(", ")}`);
    L.push("", "## Nodes", "");
    if (!x.nodes.length) L.push("_none_");
    for (const n of x.nodes) {
      const d = n.parent_id ? (depthOf.get(n.parent_id) ?? 0) + 1 : 0;
      depthOf.set(n.id, d);
      const pad = "  ".repeat(d);
      const tags = [
        n.kind !== "task" ? n.kind : "",
        n.priority ? `p${n.priority}` : "",
        n.confidence != null ? `conf ${n.confidence}` : "",
        blockedBy.has(n.id) ? `blocked by ${blockedBy.get(n.id)!.join(", ")}` : "",
      ].filter(Boolean);
      L.push(`${pad}- ${mark[n.status]} **${n.id}** ${n.title}${tags.length ? ` _(${tags.join("; ")})_` : ""}`);
      const sub = (label: string, text: string) => L.push(`${pad}  - ${label}: ${text.replace(/\n+/g, " ")}`);
      if (n.body) sub("Body", n.body);
      if (n.summary) sub("Summary", n.summary);
      if (n.refs?.length) sub("Refs", n.refs.map((r) => `\`${r}\``).join(", "));
    }
    if (x.checkpoints.length) {
      L.push("", "## Checkpoints", "");
      for (const c of x.checkpoints) L.push(`- ${c.created_at.slice(0, 16)} — ${c.note.replace(/\n+/g, " ")}`);
    }
    return L.join("\n") + "\n";
  }

  // ---------- lifecycle hooks ----------

  /** Thread for a hook: current(), as `sessionId`. Null when none. */
  private hookThread(sessionId = this.session): Thread | null {
    this.session = sessionId;
    try {
      return this.current();
    } catch (e) {
      if (e instanceof PlantrailError) return null;
      throw e;
    }
  }

  /** PostToolUse(ExitPlanMode): tell Claude how to track the approved plan saved at `file`. */
  planHint(file: string, sessionId = this.session): string {
    const t = this.hookThread(sessionId);
    const cmd = `~/.plantrail/bin/plantrail import ${file}`;
    return t
      ? `[plantrail] Plan saved to ${file}. Bound thread ${t.id} "${t.title}". If its steps aren't already nodes, ` +
          `preview with \`${cmd} --dry-run\`, then import (add \`--parent nN\` to nest under an existing node).`
      : `[plantrail] Plan saved to ${file}. No thread is bound here; to track it, ` +
          `\`~/.plantrail/bin/plantrail create "<title>" --goal "<goal>"\` then \`${cmd}\`.`;
  }

  /**
   * Nodes with recorded changes after the thread's last checkpoint (and after
   * event `since`, if later), in order of first change. Deleted nodes drop out.
   */
  private changedSince(threadId: string, since?: number | null): Node[] {
    const cp = this.db
      .prepare("SELECT max(seq) AS seq FROM events WHERE thread_id = ? AND tbl = 'checkpoints' AND action = 'insert'")
      .get(threadId) as { seq: number | null };
    const mark = Math.max(cp.seq ?? 0, since ?? 0);
    return this.db
      .prepare(
        `SELECT n.* FROM nodes n JOIN (
           SELECT json_extract(row_key, '$.id') AS id, min(seq) AS first FROM events
           WHERE thread_id = ? AND tbl = 'nodes' AND seq > ? GROUP BY 1
         ) e ON e.id = n.id ORDER BY e.first`,
      )
      .all(threadId, mark) as unknown as Node[];
  }

  /**
   * Stop hook: if nodes changed since the last checkpoint, return a one-time
   * reminder to record progress (null otherwise). Nudges again only after
   * further changes.
   */
  stopNudge(sessionId = this.session): string | null {
    const t = this.hookThread(sessionId);
    if (!t) return null;
    const changed = this.changedSince(t.id, t.nudged_seq);
    if (!changed.length) return null;
    this.db.prepare("UPDATE threads SET nudged_seq = (SELECT max(seq) FROM events) WHERE id = ?").run(t.id);
    const list = changed.slice(0, 5).map((n) => `${n.id} (${n.status})`).join(", ");
    const unpushed = unpushedCount(this.cwd);
    const active = this.db
      .prepare("SELECT * FROM nodes WHERE thread_id = ? AND status = 'active' ORDER BY updated_at")
      .all(t.id) as unknown as Node[];
    // Suggest --commit when HEAD was committed after the node was last touched (i.e. during its work).
    const head = active.length ? headTime(this.cwd) : null;
    const doneCmd = (n: Node) =>
      `\`~/.plantrail/bin/plantrail done ${n.id} --summary "<what changed, where>"${head != null && head > Date.parse(n.updated_at) ? " --commit" : ""}\``;
    const activeNote = active.length
      ? ` Still active: ${active.slice(0, 3).map((n) => `${fmt(n)}; if finished: ${doneCmd(n)}`).join(". ")}${active.length > 3 ? ` (+${active.length - 3} more)` : ""}.`
      : "";
    return (
      `[plantrail] ${t.id}: ${changed.length} node(s) changed since the last checkpoint: ${list}${changed.length > 5 ? ", …" : ""}.` +
      activeNote +
      " Before stopping: mark finished nodes done with a summary, add any new work you found, and run " +
      "`plantrail checkpoint \"<state, next step, gotchas>\"`. If that's already covered, just stop." +
      (unpushed ? ` Note: ${unpushed} commit(s) on this branch aren't pushed; say so in the checkpoint.` : "")
    );
  }

  /** PreCompact hook: save an automatic checkpoint if anything changed since the last one. */
  autoCheckpoint(sessionId = this.session, trigger = "compaction"): { id: number; thread: string } | null {
    const t = this.hookThread(sessionId);
    if (!t) return null;
    const changed = this.changedSince(t.id);
    if (!changed.length) return null;
    const active = changed.filter((n) => n.status === "active").map(fmt);
    const note = [
      `auto (before ${trigger}); no manual checkpoint since these changes.`,
      active.length ? `Active: ${active.join("; ")}.` : null,
      `Changed: ${changed.slice(0, 10).map((n) => `${n.id} ${n.status} "${clip(n.title, 60)}"`).join(", ")}${changed.length > 10 ? `, +${changed.length - 10} more` : ""}.`,
    ]
      .filter(Boolean)
      .join(" ");
    return { ...this.checkpoint(note), thread: t.id };
  }

  /** Active thread most recently bound by another session of this Claude process, if any. */
  private processThread(sessionId: string | null): string | null {
    if (this.pid === null) return null;
    const r = this.db
      .prepare(
        `SELECT s.thread_id FROM sessions s JOIN threads t ON t.id = s.thread_id
         WHERE s.pid = ? AND s.session_id IS NOT ? AND t.status = 'active' ORDER BY s.bound_at DESC LIMIT 1`,
      )
      .get(this.pid, sessionId) as { thread_id: string } | undefined;
    return r?.thread_id ?? null;
  }

  /**
   * SessionStart: bind the session to its previous thread, or after /clear
   * (`source` "clear": same process, new session id) the process's last
   * thread, or the one linked here, and describe it. Only /clear inherits by
   * pid, so a new process that reuses an old pid doesn't.
   */
  resume(sessionId = this.session, source?: string): string {
    this.autoPark();
    const prev = this.sessionThread(sessionId) ?? (source === "clear" ? this.processThread(sessionId) : null);
    if (prev) {
      this.bindInner(prev, sessionId);
      return this.statusText(prev);
    }
    const keys = locationKeys(this.cwd);
    const { id, ranked } = this.locate(keys, null);
    if (id) {
      this.bindInner(id, sessionId);
      return this.statusText(id);
    }
    if (ranked.length) {
      const inUse = this.inUseElsewhere(sessionId);
      const note = (t: Thread) => (inUse.has(t.id) ? `; bound by another session ${inUse.get(t.id)} ago` : "");
      return [
        "[plantrail] Several active threads are linked to this location, none more specifically than the others. Ask the user which one, then run `plantrail bind <thread_id>`" +
          (ranked.some((t) => inUse.has(t.id)) ? "; threads another session bound recently are likely in use there:" : ":"),
        ...ranked.map((t) => `  ${t.id} "${t.title}" (touched ${t.touched_at.slice(0, 10)}${note(t)})`),
      ].join("\n");
    }
    return this.inactiveHere(keys);
  }

  /**
   * Threads bound in the last day by other Claude sessions (not this one or its
   * process), mapped to how long ago, e.g. "12m".
   */
  private inUseElsewhere(sessionId: string | null): Map<string, string> {
    const now = this.now().getTime();
    const rows = this.db
      .prepare(
        `SELECT thread_id, MAX(bound_at) AS at FROM sessions
         WHERE bound_at >= ? AND session_id NOT LIKE 'cwd:%' AND session_id IS NOT ? AND (pid IS NULL OR pid IS NOT ?)
         GROUP BY thread_id`,
      )
      .all(new Date(now - DAY).toISOString(), sessionId, this.pid) as { thread_id: string; at: string }[];
    return new Map(
      rows.map((r) => {
        const min = Math.max(0, Math.floor((now - Date.parse(r.at)) / 60_000));
        return [r.thread_id, min < 60 ? `${min}m` : `${Math.floor(min / 60)}h`];
      }),
    );
  }

  /** Recent parked and done threads linked here, shown when no active thread is (empty if none). */
  private inactiveHere(keys: LinkKey[]): string {
    const ts = [...this.threadsForLocation(keys, "parked", 3), ...this.threadsForLocation(keys, "done", 3)];
    if (!ts.length) return "";
    return [
      "[plantrail] No active thread is linked here. Recent inactive ones (not resumed); if the user's task continues one, run `plantrail bind <thread_id>` (parked) or `plantrail reopen <thread_id>` (done):",
      ...ts.map((t) => `  ${t.id} [${t.status}] "${t.title}" (touched ${t.touched_at.slice(0, 10)})`),
    ].join("\n");
  }
}

/** Turn free text into a safe FTS5 query: quoted phrases kept, other words become prefix terms. */
function ftsQuery(q: string): string {
  const terms: string[] = [];
  for (const m of q.matchAll(/"([^"]*)"|(\S+)/g)) {
    if (m[1] !== undefined) {
      const words = m[1].match(/[\p{L}\p{N}_]+/gu);
      if (words) terms.push(`"${words.join(" ")}"`);
    } else {
      for (const w of m[2].match(/[\p{L}\p{N}_]+/gu) ?? []) terms.push(`"${w}"*`);
    }
  }
  if (!terms.length) throw new PlantrailError("search needs at least one word");
  return terms.join(" ");
}

const STOPWORDS = new Set(
  "and are but can for has how its not the use was why about after also been before being both could does from have into just like more most much only other over same should some such than that their them then there these they this those through very what when where which while will with would your".split(" "),
);

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** One-line description of a recorded change, e.g. `n3: status open→done, summary`. */
function describeEvent(e: EventRow): string {
  const row = JSON.parse((e.new ?? e.old)!) as Record<string, unknown>;
  const sign = e.action === "insert" ? "+" : e.action === "delete" ? "-" : "";
  const what =
    e.tbl === "nodes"
      ? `${sign}${row.id}`
      : e.tbl === "edges"
        ? `${sign}edge ${row.from_id} ${row.type} ${row.to_id}`
        : e.tbl === "links"
          ? `${sign}link ${row.kind}:${row.value}`
          : e.tbl === "checkpoints"
            ? `${sign}checkpoint #${row.id}`
            : `${sign}thread ${row.id}`;
  if (e.action !== "update") return e.tbl === "nodes" ? `${what} ${clip(String(row.title), 60)}` : what;
  const old = JSON.parse(e.old!) as Record<string, unknown>;
  const diffs = Object.keys(row)
    .filter((k) => k !== "updated_at" && old[k] !== row[k])
    .map((k) => (k === "status" || k === "priority" || k === "parent_id" ? `${k} ${old[k] ?? "∅"}→${row[k] ?? "∅"}` : k));
  return `${what}: ${diffs.join(", ") || "touched"}`;
}

function fmt(n: Node): string {
  return `${n.id} ${n.kind === "task" ? "" : `(${n.kind}) `}${n.title}`;
}

/** Parse `kind:value`, splitting at the first colon (values such as URLs may contain more). */
function parseLink(spec: string): LinkKey {
  const i = spec.indexOf(":");
  if (i <= 0 || i === spec.length - 1) throw new PlantrailError(`Link must be kind:value (e.g. url:https://...), got '${spec}'`);
  const kind = spec.slice(0, i);
  if (!["repo", "dir", "worktree", "branch", "url", "ticket"].includes(kind))
    throw new PlantrailError(`Link kind must be repo, dir, worktree, branch, url or ticket, got '${kind}'`);
  return { kind, value: spec.slice(i + 1) } as LinkKey;
}
