import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DB = DatabaseSync;

export function plantrailHome(): string {
  if (process.env.PLANTRAIL_HOME) return process.env.PLANTRAIL_HOME;
  const home = join(homedir(), ".plantrail");
  moveLegacyHome(join(homedir(), ".autoplan"), home);
  return home;
}

/** One-time move of state from the pre-rename ~/.autoplan dir; drops its old `autoplan` shim. */
export function moveLegacyHome(legacy: string, home: string): void {
  if (existsSync(home) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, home);
    rmSync(join(home, "bin", "autoplan"), { force: true });
  } catch {
    // Non-fatal: fall through to a fresh home.
  }
}

/**
 * Tables whose row changes the events migration records: primary key, the
 * columns captured as JSON, and how to find the row's thread. Threads record
 * only their user-facing columns (touched_at/nudged_seq are bookkeeping). A
 * migration that adds a column to one of these must recreate its triggers.
 */
export const AUDITED = {
  nodes: {
    pk: ["id"],
    cols: ["id", "thread_id", "parent_id", "kind", "title", "status", "summary", "body", "refs", "priority", "confidence", "created_at", "updated_at"],
    thread: (r: string) => `${r}.thread_id`,
  },
  edges: {
    pk: ["from_id", "to_id", "type"],
    cols: ["from_id", "to_id", "type"],
    thread: (r: string) => `(SELECT thread_id FROM nodes WHERE id = ${r}.from_id)`,
  },
  links: { pk: ["thread_id", "kind", "value"], cols: ["thread_id", "kind", "value"], thread: (r: string) => `${r}.thread_id` },
  checkpoints: {
    pk: ["id"],
    cols: ["id", "thread_id", "note", "frontier_json", "created_at"],
    thread: (r: string) => `${r}.thread_id`,
  },
  threads: { pk: ["id"], cols: ["id", "title", "goal", "status", "created_at"], thread: (r: string) => `${r}.id` },
} as const;
export type AuditedTable = keyof typeof AUDITED;

/** `json_object(...)` over an audited table's columns, read from `r` (a row alias, NEW or OLD). */
export function rowJson(table: AuditedTable, r?: string): string {
  return `json_object(${AUDITED[table].cols.map((c) => `'${c}', ${r ? `${r}.` : ""}${c}`).join(", ")})`;
}

/**
 * Every recorded change lands in events under the open op (the Store's tx()
 * opens one per command); writes outside an op aren't recorded.
 */
function eventTriggers(tables = Object.keys(AUDITED) as AuditedTable[]): string {
  const op = "(SELECT id FROM ops WHERE open)";
  const out: string[] = [];
  for (const table of tables) {
    const { pk, cols, thread } = AUDITED[table];
    const key = (r: string) => `json_object(${pk.map((c) => `'${c}', ${r}.${c}`).join(", ")})`;
    const changed = cols.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ");
    const ev = (action: string, r: string, oldJ: string, newJ: string) =>
      `INSERT INTO events (op_id, thread_id, tbl, action, row_key, old, new) VALUES (${op}, ${thread(r)}, '${table}', '${action}', ${key(r)}, ${oldJ}, ${newJ});`;
    out.push(
      `CREATE TRIGGER ${table}_ev_i AFTER INSERT ON ${table} WHEN EXISTS ${op} BEGIN ${ev("insert", "NEW", "NULL", rowJson(table, "NEW"))} END;`,
      `CREATE TRIGGER ${table}_ev_u AFTER UPDATE ON ${table} WHEN EXISTS ${op} AND (${changed}) BEGIN ${ev("update", "NEW", rowJson(table, "OLD"), rowJson(table, "NEW"))} END;`,
      `CREATE TRIGGER ${table}_ev_d AFTER DELETE ON ${table} WHEN EXISTS ${op} BEGIN ${ev("delete", "OLD", rowJson(table, "OLD"), "NULL")} END;`,
    );
  }
  return out.join("\n");
}

/** Ordered migrations; index + 1 is the schema version stored in PRAGMA user_version. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE counters (name TEXT PRIMARY KEY, next INTEGER NOT NULL);
  INSERT INTO counters VALUES ('t', 1), ('n', 1);

  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','parked','done')),
    created_at TEXT NOT NULL,
    touched_at TEXT NOT NULL
  );

  CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    parent_id TEXT REFERENCES nodes(id),
    kind TEXT NOT NULL DEFAULT 'task' CHECK (kind IN ('task','question','finding','decision')),
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','active','blocked','done','abandoned')),
    summary TEXT,
    body TEXT,
    refs TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX nodes_thread ON nodes(thread_id, status);
  CREATE INDEX nodes_parent ON nodes(parent_id);

  CREATE TABLE edges (
    from_id TEXT NOT NULL REFERENCES nodes(id),
    to_id TEXT NOT NULL REFERENCES nodes(id),
    type TEXT NOT NULL CHECK (type IN ('blocks','answers','derived_from','contradicts')),
    PRIMARY KEY (from_id, to_id, type)
  );
  CREATE INDEX edges_to ON edges(to_id, type);

  CREATE TABLE links (
    thread_id TEXT NOT NULL REFERENCES threads(id),
    kind TEXT NOT NULL CHECK (kind IN ('repo','dir','url','ticket')),
    value TEXT NOT NULL,
    PRIMARY KEY (thread_id, kind, value)
  );
  CREATE INDEX links_value ON links(kind, value);

  CREATE TABLE checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    note TEXT NOT NULL,
    frontier_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    session_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES threads(id),
    cwd TEXT,
    bound_at TEXT NOT NULL
  );
  CREATE INDEX sessions_cwd ON sessions(cwd, bound_at);

  CREATE VIRTUAL TABLE nodes_fts USING fts5(title, summary, body, content='nodes', content_rowid='rowid');
  CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, title, summary, body) VALUES (new.rowid, new.title, new.summary, new.body);
  END;
  CREATE TRIGGER nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, title, summary, body) VALUES ('delete', old.rowid, old.title, old.summary, old.body);
  END;
  CREATE TRIGGER nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, title, summary, body) VALUES ('delete', old.rowid, old.title, old.summary, old.body);
    INSERT INTO nodes_fts(rowid, title, summary, body) VALUES (new.rowid, new.title, new.summary, new.body);
  END;
  `,
  `ALTER TABLE nodes ADD COLUMN confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));`,
  `ALTER TABLE threads ADD COLUMN nudged_at TEXT;`,
  `
  CREATE TABLE ops (
    id INTEGER PRIMARY KEY,
    thread_id TEXT,
    label TEXT,
    session_id TEXT,
    at TEXT NOT NULL,
    open INTEGER NOT NULL DEFAULT 1,
    undoes INTEGER REFERENCES ops(id),
    undone_by INTEGER REFERENCES ops(id)
  );
  CREATE INDEX ops_open ON ops(id) WHERE open;
  CREATE INDEX ops_thread ON ops(thread_id, id);
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY,
    op_id INTEGER NOT NULL REFERENCES ops(id),
    thread_id TEXT,
    tbl TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('insert','update','delete')),
    row_key TEXT NOT NULL,
    old TEXT,
    new TEXT
  );
  CREATE INDEX events_op ON events(op_id);
  CREATE INDEX events_thread ON events(thread_id, tbl, seq);
  ALTER TABLE threads DROP COLUMN nudged_at;
  ALTER TABLE threads ADD COLUMN nudged_seq INTEGER;
  ${eventTriggers()}
  `,
  // Worktree/branch link kinds: widen the CHECK by rebuilding links (dropping it drops its triggers).
  `
  CREATE TABLE links_new (
    thread_id TEXT NOT NULL REFERENCES threads(id),
    kind TEXT NOT NULL CHECK (kind IN ('repo','dir','worktree','branch','url','ticket')),
    value TEXT NOT NULL,
    PRIMARY KEY (thread_id, kind, value)
  );
  INSERT INTO links_new SELECT thread_id, kind, value FROM links;
  DROP TABLE links;
  ALTER TABLE links_new RENAME TO links;
  CREATE INDEX links_value ON links(kind, value);
  ${eventTriggers(["links"])}
  `,
];

export function openDb(path?: string): DB {
  let file = path;
  if (!file) {
    const home = plantrailHome();
    mkdirSync(home, { recursive: true });
    file = join(home, "state.db");
  }
  const db = new DatabaseSync(file);
  // busy_timeout first: switching to WAL needs a lock that concurrent openers may hold.
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  if (file !== ":memory:") enableWal(db);
  migrate(db);
  return db;
}

/**
 * The switch to WAL (persistent, so only a fresh db's first opens pay it) takes a lock
 * upgrade that SQLite won't wait on via busy_timeout; retry briefly instead.
 */
function enableWal(db: DB): void {
  for (let attempt = 0; ; attempt++) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (e) {
      if ((e as { errcode?: number }).errcode !== 5 || attempt >= 50) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function userVersion(db: DB): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

/** Concurrent openers serialize on BEGIN IMMEDIATE and re-read the version under the lock. */
function migrate(db: DB): void {
  if (userVersion(db) >= MIGRATIONS.length) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let v = userVersion(db); v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
