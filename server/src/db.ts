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
];

export function openDb(path?: string): DB {
  let file = path;
  if (!file) {
    const home = plantrailHome();
    mkdirSync(home, { recursive: true });
    file = join(home, "state.db");
  }
  const db = new DatabaseSync(file);
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
