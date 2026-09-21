import type { DB } from "./db.ts";
import { locationKeys, type LinkKey } from "./repo.ts";

export type NodeKind = "task" | "question" | "finding" | "decision";
export type NodeStatus = "open" | "active" | "blocked" | "done" | "abandoned";
export type ThreadStatus = "active" | "parked" | "done";

export interface Thread {
  id: string;
  title: string;
  goal: string;
  status: ThreadStatus;
  created_at: string;
  touched_at: string;
}

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
  /** Node id, or `#i` referencing the i-th item of the same add() call. */
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
}

export interface SearchHit {
  node: Node;
  /** Matching excerpt with hits wrapped in [ ]. */
  snippet: string;
  thread_title: string;
}

export class AutoplanError extends Error {}

const RESOLVED: NodeStatus[] = ["done", "abandoned"];

export class Store {
  /** Thread bound to this process (one MCP server per Claude session). */
  bound: string | null = null;

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

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  private touch(threadId: string): void {
    this.db.prepare("UPDATE threads SET touched_at = ? WHERE id = ?").run(this.ts(), threadId);
  }

  getThread(id: string): Thread {
    const t = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as Thread | undefined;
    if (!t) throw new AutoplanError(`No thread ${id}`);
    return t;
  }

  getNode(id: string): Node {
    const n = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as Node | undefined;
    if (!n) throw new AutoplanError(`No node ${id}`);
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

  private depth(node: Node): number {
    let d = 0;
    let p = node.parent_id;
    while (p) {
      d++;
      p = (this.db.prepare("SELECT parent_id FROM nodes WHERE id = ?").get(p) as { parent_id: string | null })
        .parent_id;
    }
    return d;
  }

  // ---------- threads & binding ----------

  createThread(title: string, goal: string, linkCwd = true, sessionId?: string): Thread {
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

  listThreads(filter: "active" | "parked" | "done" | "all" = "active"): Thread[] {
    const sql =
      filter === "all"
        ? "SELECT * FROM threads ORDER BY touched_at DESC"
        : "SELECT * FROM threads WHERE status = ? ORDER BY touched_at DESC";
    const stmt = this.db.prepare(sql);
    return (filter === "all" ? stmt.all() : stmt.all(filter)) as unknown as Thread[];
  }

  /** Active threads linked to any of the given location keys. */
  threadsForLocation(keys: LinkKey[]): Thread[] {
    if (!keys.length) return [];
    const cond = keys.map(() => "(l.kind = ? AND l.value = ?)").join(" OR ");
    return this.db
      .prepare(
        `SELECT DISTINCT t.* FROM threads t JOIN links l ON l.thread_id = t.id
         WHERE t.status = 'active' AND (${cond}) ORDER BY t.touched_at DESC`,
      )
      .all(...keys.flatMap((k) => [k.kind, k.value])) as unknown as Thread[];
  }

  private bindInner(threadId: string, sessionId?: string): void {
    this.bound = threadId;
    // Record under the real session id if known; otherwise a per-cwd pseudo session
    // so later processes in the same directory can pick the binding up.
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, thread_id, cwd, bound_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET thread_id = excluded.thread_id, cwd = excluded.cwd, bound_at = excluded.bound_at`,
      )
      .run(sessionId ?? `cwd:${this.cwd}`, threadId, this.cwd, this.ts());
    this.touch(threadId);
  }

  bind(threadId: string, sessionId?: string): Thread {
    const t = this.getThread(threadId);
    this.bindInner(t.id, sessionId);
    return t;
  }

  /**
   * Thread for the current process: explicit binding, else the most recent
   * session binding in this cwd (written by the SessionStart hook), else the
   * single active thread linked to this location.
   */
  current(): Thread {
    if (this.bound) return this.getThread(this.bound);
    const recent = this.db
      .prepare(
        `SELECT s.thread_id FROM sessions s JOIN threads t ON t.id = s.thread_id
         WHERE s.cwd = ? AND t.status = 'active' ORDER BY s.bound_at DESC LIMIT 1`,
      )
      .get(this.cwd) as { thread_id: string } | undefined;
    if (recent) {
      this.bound = recent.thread_id;
      return this.getThread(recent.thread_id);
    }
    const linked = this.threadsForLocation(locationKeys(this.cwd));
    if (linked.length === 1) {
      this.bound = linked[0].id;
      return linked[0];
    }
    const hint = linked.length
      ? `Linked threads here: ${linked.map((t) => `${t.id} "${t.title}"`).join(", ")}.`
      : "Use `autoplan threads` or `autoplan create`.";
    throw new AutoplanError(`No thread bound. Run \`autoplan bind <thread_id>\`. ${hint}`);
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
          const id = ids[Number(m[1])];
          if (!id) throw new AutoplanError(`Reference ${ref} must point to an earlier item in this call`);
          return id;
        }
        const n = this.getNode(ref);
        if (n.thread_id !== thread.id) throw new AutoplanError(`${ref} belongs to thread ${n.thread_id}`);
        return n.id;
      };
      const insert = this.db.prepare(
        `INSERT INTO nodes (id, thread_id, parent_id, kind, title, body, priority, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const edge = this.db.prepare("INSERT OR IGNORE INTO edges (from_id, to_id, type) VALUES (?, ?, 'blocks')");
      const deferred: [string, string][] = [];
      for (const it of items) {
        const id = this.nextId("n");
        ids.push(id);
        insert.run(
          id,
          thread.id,
          it.parent ? resolve(it.parent) : null,
          it.kind ?? "task",
          it.title,
          it.body ?? null,
          it.priority ?? 0,
          now,
          now,
        );
        for (const b of it.blocked_by ?? []) edge.run(resolve(b), id);
        // `blocks` may point forward within the batch; resolve after all inserts.
        for (const b of it.blocks ?? []) deferred.push([id, b]);
      }
      for (const [from, ref] of deferred) {
        const to = resolve(ref);
        if (to === from) throw new AutoplanError("A node cannot block itself");
        edge.run(from, to);
      }
      this.touch(thread.id);
      return ids.map((id) => this.getNode(id));
    });
  }

  start(id: string): { node: Node; demoted: string[] } {
    const node = this.getNode(id);
    if (RESOLVED.includes(node.status)) throw new AutoplanError(`${id} is ${node.status}; reopen it with update first`);
    const blockers = this.blockers(id);
    if (blockers.length)
      throw new AutoplanError(`${id} is blocked by ${blockers.map((b) => `${b.id} "${b.title}"`).join(", ")}`);
    if (node.status === "blocked")
      throw new AutoplanError(`${id} is marked blocked; update its status to open first`);
    return this.tx(() => {
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
    if (!summary?.trim()) throw new AutoplanError("done requires a non-empty summary");
    const node = this.getNode(id);
    if (node.status === "done") throw new AutoplanError(`${id} is already done`);
    const open = this.children(id).filter((c) => !RESOLVED.includes(c.status));
    if (open.length)
      throw new AutoplanError(`${id} has unresolved children: ${open.map((c) => c.id).join(", ")}`);
    return this.tx(() => this.complete(node, summary.trim(), refs, this.ts()));
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
    if (!text?.trim()) throw new AutoplanError("A finding needs text");
    if (confidence !== undefined && !(confidence >= 0 && confidence <= 1))
      throw new AutoplanError("confidence must be between 0 and 1");
    const parent = this.getNode(parentId);
    if (parent.kind === "finding") throw new AutoplanError(`${parentId} is a finding; attach to the question it informs`);
    if (answers) {
      if (parent.kind !== "question") throw new AutoplanError(`${parentId} is a ${parent.kind}; only questions can be answered`);
      if (RESOLVED.includes(parent.status)) throw new AutoplanError(`${parentId} is already ${parent.status}`);
      const open = this.children(parentId).filter((c) => !RESOLVED.includes(c.status));
      if (open.length)
        throw new AutoplanError(`${parentId} has unresolved children: ${open.map((c) => c.id).join(", ")}`);
    }
    const t = text.trim();
    return this.tx(() => {
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

  /** Finding count and best confidence under a node (null if none recorded a confidence). */
  private evidence(id: string): { count: number; best: number | null } {
    const r = this.db
      .prepare("SELECT COUNT(*) AS count, MAX(confidence) AS best FROM nodes WHERE parent_id = ? AND kind = 'finding'")
      .get(id) as { count: number; best: number | null };
    return { count: Number(r.count), best: r.best };
  }

  update(
    id: string,
    fields: { title?: string; body?: string; status?: NodeStatus; priority?: number; summary?: string; kind?: NodeKind },
  ): { node: Node; unblocked: Node[] } {
    const node = this.getNode(id);
    if (fields.status === "done")
      throw new AutoplanError("Use done(id, summary) to complete a node");
    if (fields.status === "abandoned" && !(fields.summary ?? node.summary)?.trim())
      throw new AutoplanError("Abandoning requires a summary explaining why");
    if (fields.status === "active") throw new AutoplanError("Use start(id) to activate a node");
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    for (const k of ["title", "body", "status", "priority", "summary", "kind"] as const) {
      if (fields[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(fields[k] as string | number);
      }
    }
    if (!sets.length) throw new AutoplanError("No fields to update");
    return this.tx(() => {
      const now = this.ts();
      this.db.prepare(`UPDATE nodes SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, now, id);
      const unblocked = fields.status === "abandoned" ? this.releaseDependents(id, now) : [];
      this.touch(node.thread_id);
      return { node: this.getNode(id), unblocked };
    });
  }

  // ---------- ranking ----------

  /**
   * Rank open, unblocked tasks/questions. Leaves beat containers, explicit
   * priority dominates, deeper (more concrete) nodes get a small boost, and
   * nodes untouched for a while float up so nothing rots. Questions with no
   * findings (unexplored) or only low-confidence ones get a boost so research
   * goes where the uncertainty is.
   */
  nextOptions(n = 3, threadId?: string): Option[] {
    const tid = threadId ?? this.current().id;
    const cands = this.db
      .prepare(
        `SELECT * FROM nodes WHERE thread_id = ? AND status = 'open' AND kind IN ('task','question')`,
      )
      .all(tid) as unknown as Node[];
    const now = this.now().getTime();
    const opts: Option[] = [];
    for (const node of cands) {
      if (this.blockers(node.id).length) continue;
      const openKids = this.children(node.id).filter((c) => !RESOLVED.includes(c.status)).length;
      const depth = this.depth(node);
      const staleDays = Math.min(7, (now - Date.parse(node.updated_at)) / 86_400_000);
      const leaf = openKids === 0 ? 5 : 0;
      let research = 0;
      let researchWhy: string | null = null;
      if (node.kind === "question") {
        const ev = this.evidence(node.id);
        if (!ev.count) [research, researchWhy] = [3, "unexplored"];
        else if (ev.best == null || ev.best < 0.7) {
          research = 3 * (1 - (ev.best ?? 0.5));
          researchWhy = `low confidence ${ev.best ?? "unrated"}`;
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
    opts.sort((a, b) => b.score - a.score || a.node.created_at.localeCompare(b.node.created_at) || a.node.id.localeCompare(b.node.id, undefined, { numeric: true }));
    return opts.slice(0, n);
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
    if (!note?.trim()) throw new AutoplanError("checkpoint requires a note");
    const t = this.current();
    const active = this.db
      .prepare("SELECT id FROM nodes WHERE thread_id = ? AND status = 'active'")
      .all(t.id) as { id: string }[];
    const frontier = {
      active: active.map((a) => a.id),
      next: this.nextOptions(5, t.id).map((o) => o.node.id),
    };
    const r = this.db
      .prepare("INSERT INTO checkpoints (thread_id, note, frontier_json, created_at) VALUES (?, ?, ?, ?)")
      .run(t.id, note.trim(), JSON.stringify(frontier), this.ts());
    this.touch(t.id);
    return { id: Number(r.lastInsertRowid) };
  }

  statusText(threadId?: string): string {
    const t = threadId ? this.getThread(threadId) : this.current();
    const counts = Object.fromEntries(
      (
        this.db
          .prepare("SELECT status, COUNT(*) AS c FROM nodes WHERE thread_id = ? GROUP BY status")
          .all(t.id) as { status: string; c: number }[]
      ).map((r) => [r.status, r.c]),
    );
    const active = this.db
      .prepare("SELECT * FROM nodes WHERE thread_id = ? AND status = 'active'")
      .all(t.id) as unknown as Node[];
    const blocked = (
      this.db
        .prepare("SELECT * FROM nodes WHERE thread_id = ? AND status IN ('open','blocked') ORDER BY priority DESC")
        .all(t.id) as unknown as Node[]
    ).filter((n) => n.status === "blocked" || this.blockers(n.id).length);
    const cp = this.db
      .prepare("SELECT note, created_at FROM checkpoints WHERE thread_id = ? ORDER BY id DESC LIMIT 1")
      .get(t.id) as { note: string; created_at: string } | undefined;
    const lines = [`[autoplan] ${t.id} "${t.title}" (${t.status})`];
    if (t.goal) lines.push(`Goal: ${clip(t.goal, 200)}`);
    const countStr = ["open", "active", "blocked", "done", "abandoned"]
      .filter((s) => counts[s])
      .map((s) => `${counts[s]} ${s}`)
      .join(", ");
    lines.push(`Nodes: ${countStr || "none"}`);
    if (active.length) lines.push(`Active: ${active.map(fmt).join("; ")}`);
    const next = this.nextOptions(3, t.id);
    if (next.length) {
      lines.push("Next:");
      for (const o of next) lines.push(`  ${fmt(o.node)}`);
    }
    if (blocked.length) {
      lines.push("Blocked:");
      for (const b of blocked.slice(0, 5)) {
        const by = this.blockers(b.id).map((x) => x.id);
        lines.push(`  ${fmt(b)}${by.length ? ` ← ${by.join(", ")}` : ""}`);
      }
      if (blocked.length > 5) lines.push(`  …${blocked.length - 5} more`);
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

  /** SessionStart helper: bind session to the thread for cwd and describe it. */
  resume(sessionId?: string): string {
    const keys = locationKeys(this.cwd);
    const linked = this.threadsForLocation(keys);
    if (sessionId) {
      const prev = this.db
        .prepare(
          `SELECT s.thread_id FROM sessions s JOIN threads t ON t.id = s.thread_id
           WHERE s.session_id = ? AND t.status = 'active'`,
        )
        .get(sessionId) as { thread_id: string } | undefined;
      if (prev) {
        this.bindInner(prev.thread_id, sessionId);
        return this.statusText(prev.thread_id);
      }
    }
    if (linked.length === 1) {
      this.bindInner(linked[0].id, sessionId);
      return this.statusText(linked[0].id);
    }
    if (linked.length > 1) {
      return [
        "[autoplan] Multiple active threads are linked to this location. Ask the user which one, then run `autoplan bind <thread_id>`:",
        ...linked.map((t) => `  ${t.id} "${t.title}" (touched ${t.touched_at.slice(0, 10)})`),
      ].join("\n");
    }
    return "";
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
  if (!terms.length) throw new AutoplanError("search needs at least one word");
  return terms.join(" ");
}

const STOPWORDS = new Set(
  "and are but can for has how its not the use was why about after also been before being both could does from have into just like more most much only other over same should some such than that their them then there these they this those through very what when where which while will with would your".split(" "),
);

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function fmt(n: Node): string {
  return `${n.id} ${n.kind === "task" ? "" : `(${n.kind}) `}${n.title}`;
}
