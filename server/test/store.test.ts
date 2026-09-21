import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveLegacyHome, openDb } from "../src/db.ts";
import { PlantrailError, Store } from "../src/store.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plantrail-test-"));
  let t = Date.parse("2026-01-01T00:00:00Z");
  const clock = { advance: (ms: number) => (t += ms) };
  const db = openDb(":memory:");
  const store = new Store(db, dir, () => new Date(t));
  store.createThread("Test", "goal");
  return { store, db, dir, clock };
}

test("ids are short and sequential", () => {
  const { store } = setup();
  const [a, b] = store.add([{ title: "a" }, { title: "b" }]);
  assert.equal(a.id, "n1");
  assert.equal(b.id, "n2");
  assert.equal(store.current().id, "t1");
});

test("done requires summary and unblocks dependents", () => {
  const { store } = setup();
  const [a, b] = store.add([{ title: "a", blocks: ["#1"] }, { title: "b" }]);
  assert.throws(() => store.start(b.id), /blocked by n1/);
  assert.throws(() => store.done(a.id, "  "), PlantrailError);
  const r = store.done(a.id, "did a", ["file.ts"]);
  assert.deepEqual(r.unblocked.map((n) => n.id), [b.id]);
  assert.equal(store.start(b.id).node.status, "active");
});

test("manually blocked node reopens when last blocker resolves", () => {
  const { store } = setup();
  const [a, b, c] = store.add([{ title: "a" }, { title: "b" }, { title: "c", blocked_by: ["#0", "#1"] }]);
  store.update(c.id, { status: "blocked" });
  assert.deepEqual(store.done(a.id, "x").unblocked, []);
  assert.equal(store.getNode(c.id).status, "blocked");
  const r = store.update(b.id, { status: "abandoned", summary: "not needed" });
  assert.deepEqual(r.unblocked.map((n) => n.id), [c.id]);
  assert.equal(store.getNode(c.id).status, "open");
});

test("guards on status transitions", () => {
  const { store } = setup();
  const [a] = store.add([{ title: "a" }]);
  assert.throws(() => store.update(a.id, { status: "done" as never }), /Use done/);
  assert.throws(() => store.update(a.id, { status: "abandoned" }), /summary/);
  store.update(a.id, { status: "blocked" });
  assert.throws(() => store.start(a.id), /marked blocked/);
  store.update(a.id, { status: "open" });
  store.done(a.id, "ok");
  assert.throws(() => store.done(a.id, "again"), /already done/);
  assert.throws(() => store.start(a.id), /reopen/);
});

test("start demotes the previous active node", () => {
  const { store } = setup();
  const [a, b] = store.add([{ title: "a" }, { title: "b" }]);
  store.start(a.id);
  const r = store.start(b.id);
  assert.deepEqual(r.demoted, [a.id]);
  assert.equal(store.getNode(a.id).status, "open");
});

test("parent cannot be done with open children; reports when ready", () => {
  const { store } = setup();
  const [p, c1, c2] = store.add([{ title: "p" }, { title: "c1", parent: "#0" }, { title: "c2", parent: "#0" }]);
  assert.throws(() => store.done(p.id, "x"), /unresolved children/);
  assert.equal(store.done(c1.id, "x").parentReady, null);
  assert.equal(store.update(c2.id, { status: "abandoned", summary: "dup" }).node.status, "abandoned");
  assert.equal(store.done(p.id, "all done").node.status, "done");
});

test("add rejects forward refs for parent and cross-thread ids", () => {
  const { store } = setup();
  assert.throws(() => store.add([{ title: "a", parent: "#1" }, { title: "b" }]), /earlier item/);
  const [x] = store.add([{ title: "x" }]);
  store.createThread("Other", "g", false);
  assert.throws(() => store.add([{ title: "y", parent: x.id }]), /belongs to thread t1/);
});

test("next_options: priority > leaf > depth, skips blocked and non-actionable kinds", () => {
  const { store } = setup();
  const [epic, leafDeep, , , hi, blocked] = store.add([
    { title: "epic" },
    { title: "deep leaf", parent: "#0" },
    { title: "shallow leaf" },
    { title: "a finding", kind: "finding" },
    { title: "urgent", priority: 2 },
    { title: "blocked", priority: 5, blocked_by: ["#2"] },
  ]);
  const ids = store.nextOptions(10).map((o) => o.node.id);
  assert.equal(ids[0], hi.id);
  assert.equal(ids[1], leafDeep.id);
  assert.equal(ids.at(-1), epic.id);
  assert.ok(!ids.includes(blocked.id));
  assert.ok(!ids.includes("n4"));
});

test("next_options: stale nodes float up", () => {
  const { store, clock } = setup();
  const [old] = store.add([{ title: "old" }]);
  clock.advance(5 * 86_400_000);
  store.add([{ title: "new" }]);
  assert.equal(store.nextOptions(1)[0].node.id, old.id);
  assert.match(store.nextOptions(1)[0].why, /idle 5d/);
});

test("status is compact and includes checkpoint", () => {
  const { store } = setup();
  const [a] = store.add([{ title: "a" }, { title: "b", blocked_by: ["#0"] }]);
  store.start(a.id);
  store.checkpoint("halfway through a");
  const s = store.statusText();
  assert.match(s, /Active: n1 a/);
  assert.match(s, /Blocked:\n  n2 b ← n1/);
  assert.match(s, /halfway through a/);
  assert.ok(s.length < 1500);
});

test("resume binds by session, then by linked location", () => {
  const { store, db, dir } = setup();
  const now = store.now;
  const fresh = new Store(db, dir, now);
  assert.match(fresh.resume("s1"), /t1 "Test"/);
  assert.equal(fresh.bound, "t1");
  // A second thread linked here makes location ambiguous, but session s1 stays bound.
  new Store(db, dir, now).createThread("Second", "g");
  assert.match(new Store(db, dir, now).resume("s1"), /t1 "Test"/);
  assert.match(new Store(db, dir, now).resume("s2"), /Multiple active threads/);
});

test("current() falls back to latest binding in cwd", () => {
  const { store, db, dir } = setup();
  const now = store.now;
  const hook = new Store(db, dir, now);
  hook.resume("sess");
  const server = new Store(db, dir, now);
  assert.equal(server.current().id, "t1");
  assert.throws(() => new Store(db, join(dir, "elsewhere"), now).current(), /No thread bound/);
});

test("recordFinding attaches a done finding with confidence and sources", () => {
  const { store } = setup();
  const [q] = store.add([{ title: "Is WAL safe on NFS?", kind: "question" }]);
  const { node: f } = store.recordFinding(q.id, "No: WAL needs shared memory.\nSee docs.", 0.9, ["https://sqlite.org/wal.html"]);
  assert.equal(f.kind, "finding");
  assert.equal(f.status, "done");
  assert.equal(f.parent_id, q.id);
  assert.equal(f.title, "No: WAL needs shared memory.");
  assert.equal(f.confidence, 0.9);
  assert.deepEqual(JSON.parse(f.refs!), ["https://sqlite.org/wal.html"]);
  assert.match(store.getText(q.id, 1), /\(finding\) No: WAL.*\(conf 0\.9\)/);
  // Findings don't hold up closing the question.
  assert.equal(store.done(q.id, "answered").node.status, "done");
});

test("recordFinding validates input", () => {
  const { store } = setup();
  const [q] = store.add([{ title: "q", kind: "question" }]);
  assert.throws(() => store.recordFinding(q.id, " "), /needs text/);
  assert.throws(() => store.recordFinding(q.id, "x", 1.5), /between 0 and 1/);
  assert.throws(() => store.recordFinding("n99", "x"), /No node n99/);
  const { node: f } = store.recordFinding(q.id, "x");
  assert.equal(f.confidence, null);
  assert.throws(() => store.recordFinding(f.id, "y"), /is a finding/);
});

test("recordFinding --answers closes the question and unblocks dependents", () => {
  const { store, db } = setup();
  const [q, t] = store.add([{ title: "q", kind: "question", blocks: ["#1"] }, { title: "t" }]);
  const { node: f, closed } = store.recordFinding(q.id, "yes", 0.8, ["src"], true);
  assert.equal(closed!.node.status, "done");
  assert.match(closed!.node.summary!, new RegExp(`Answered by ${f.id}: yes`));
  assert.deepEqual(closed!.unblocked.map((n) => n.id), [t.id]);
  assert.ok(db.prepare("SELECT 1 FROM edges WHERE from_id = ? AND to_id = ? AND type = 'answers'").get(f.id, q.id));
  assert.throws(() => store.recordFinding(q.id, "again", undefined, undefined, true), /already done/);
  assert.throws(() => store.recordFinding(t.id, "x", undefined, undefined, true), /only questions/);
});

test("recordFinding --answers refuses a question with open children, leaving no finding", () => {
  const { store } = setup();
  const [q] = store.add([{ title: "q", kind: "question" }, { title: "sub", parent: "#0" }]);
  assert.throws(() => store.recordFinding(q.id, "x", undefined, undefined, true), /unresolved children/);
  assert.equal(store.children(q.id).filter((c) => c.kind === "finding").length, 0);
});

test("nextOptions favors unexplored and low-confidence questions", () => {
  const { store } = setup();
  const [task, unexplored, weak, solid] = store.add([
    { title: "task" },
    { title: "unexplored", kind: "question" },
    { title: "weak", kind: "question" },
    { title: "solid", kind: "question" },
  ]);
  store.recordFinding(weak.id, "maybe", 0.2);
  store.recordFinding(solid.id, "surely", 0.95);
  const opts = store.nextOptions(4);
  assert.deepEqual(opts.map((o) => o.node.id), [unexplored.id, weak.id, task.id, solid.id]);
  assert.match(opts[0].why, /unexplored/);
  assert.match(opts[1].why, /low confidence 0\.2/);
});

test("search ranks title hits, matches prefixes/phrases, and scopes to thread", () => {
  const { store } = setup();
  const [a, b] = store.add([
    { title: "Configure WAL mode", body: "journal settings" },
    { title: "Other", body: "we might use wal later" },
  ]);
  const hits = store.search("wal");
  assert.deepEqual(hits.map((h) => h.node.id), [a.id, b.id]);
  assert.match(hits[0].snippet, /\[WAL\]/);
  assert.deepEqual(store.search("journ").map((h) => h.node.id), [a.id]);
  assert.deepEqual(store.search('"use wal"').map((h) => h.node.id), [b.id]);
  assert.deepEqual(store.search("wal AND OR (").map((h) => h.node.id), []); // operators treated as words
  store.done(a.id, "enabled via pragma");
  assert.deepEqual(store.search("pragma").map((h) => h.node.id), [a.id]);
  assert.throws(() => store.search(" *( "), /at least one word/);

  store.createThread("Other thread", "g", false);
  store.add([{ title: "wal elsewhere", kind: "question" }]);
  assert.equal(store.search("wal").length, 1);
  assert.equal(store.search("wal", { all: true }).length, 3);
  assert.equal(store.search("wal", { all: true, kind: "question" }).length, 1);
});

test("status shows capped related findings/decisions from other threads", () => {
  const { store } = setup();
  const [q] = store.add([{ title: "Is SQLite WAL safe?", kind: "question" }]);
  store.recordFinding(q.id, "WAL breaks on network filesystems", 0.8);
  store.add([{ title: "Unrelated decision about colors", kind: "decision" }]);
  store.createThread("Tune WAL checkpointing", "faster writes", false);
  const s = store.statusText();
  assert.match(s, /Related \(other threads\):\n  n\d+ \(finding\) WAL breaks/);
  assert.doesNotMatch(s, /colors/);
  store.createThread("Nothing in common here", "zzz", false);
  assert.doesNotMatch(store.statusText(), /Related/);
});

test("stop hook nudges once per batch of changes; precompact auto-checkpoints", () => {
  const { store, clock } = setup();
  assert.equal(store.stopNudge(), null);
  const [a] = store.add([{ title: "a" }]);
  clock.advance(1000);
  store.start(a.id);
  assert.match(store.stopNudge() ?? "", /1 node\(s\) changed since the last checkpoint: n1 \(active\)/);
  clock.advance(1000);
  assert.equal(store.stopNudge(), null); // already nudged, nothing new
  clock.advance(1000);
  store.checkpoint("manual");
  assert.equal(store.autoCheckpoint(), null); // nothing since manual checkpoint
  clock.advance(1000);
  store.done(a.id, "did a");
  assert.match(store.stopNudge() ?? "", /n1 \(done\)/);
  const cp = store.autoCheckpoint(undefined, "/compact");
  assert.ok(cp);
  assert.match(store.statusText(), /Last checkpoint .*auto \(before \/compact\).*Changed: n1 done/);
  clock.advance(1000);
  assert.equal(store.stopNudge(), null);
});

test("resume auto-parks idle threads; bind reactivates; status flags long-active nodes", () => {
  const { store, db, dir, clock } = setup();
  const [a] = store.add([{ title: "a" }]);
  store.start(a.id);
  clock.advance(4 * 86_400_000);
  assert.match(store.statusText(), /n1 a \[active 4d with no updates/);
  clock.advance(30 * 86_400_000);
  const fresh = new Store(db, dir, store.now);
  const text = fresh.resume("s1");
  assert.match(text, /Parked threads linked here/);
  assert.match(text, /t1 "Test"/);
  assert.equal(fresh.getThread("t1").status, "parked");
  assert.equal(fresh.bind("t1").status, "active");
  assert.match(fresh.resume("s1"), /^\[plantrail\] t1 "Test" \(active\)/);
  store.setThreadStatus("t1", "parked");
  assert.deepEqual(fresh.listThreads("parked").map((t) => t.id), ["t1"]);
});

test("renameThread updates the title and rejects empty titles", () => {
  const { store } = setup();
  assert.equal(store.renameThread("t1", "  Renamed ").title, "Renamed");
  assert.throws(() => store.renameThread("t1", " "), /must not be empty/);
  assert.throws(() => store.renameThread("t9", "x"));
});

test("renameThread updates the goal alone or with the title", () => {
  const { store } = setup();
  const before = store.getThread("t1").title;
  assert.equal(store.renameThread("t1", undefined, " New goal ").goal, "New goal");
  assert.equal(store.getThread("t1").title, before);
  const t = store.renameThread("t1", "T2", "G2");
  assert.deepEqual([t.title, t.goal], ["T2", "G2"]);
  assert.throws(() => store.renameThread("t1"), /Nothing to change/);
});

test("link: relinks after a move, prunes dead paths, resume self-heals via other keys", () => {
  const { store, db, dir } = setup();
  const moved = mkdtempSync(join(tmpdir(), "plantrail-moved-"));
  const here = new Store(db, moved, store.now);
  assert.throws(() => here.current(), /No thread bound/);
  here.addLink("t1", { kind: "dir", value: "/nonexistent/old/path" });
  const r = here.relink("t1", true);
  assert.equal(r.added.length, 1);
  assert.deepEqual(r.removed, [{ kind: "dir", value: "/nonexistent/old/path" }]);
  assert.equal(r.links.length, 2);
  assert.equal(new Store(db, moved, store.now).current().id, "t1");
  assert.equal(here.relink("t1").added.length, 0);
  // resume matching on one key adds the location's other keys
  db.prepare("DELETE FROM links WHERE value = ?").run(realpathSync(dir));
  here.addLink("t1", { kind: "dir", value: realpathSync(dir) });
  assert.match(new Store(db, dir, store.now).resume("s9"), /^\[plantrail\] t1/);
});

test("unlink removes one link by kind:value", () => {
  const { store } = setup();
  store.addLink("t1", { kind: "repo", value: "https://example.com/old.git" });
  const r = store.unlink("t1", "repo:https://example.com/old.git");
  assert.deepEqual(r.removed, { kind: "repo", value: "https://example.com/old.git" });
  assert.ok(!r.links.some((l) => l.value.includes("old.git")));
  assert.throws(() => store.unlink("t1", "repo:https://example.com/old.git"), /has no link/);
  assert.throws(() => store.unlink("t1", "nocolon"), (e: Error) => e instanceof PlantrailError && /kind:value/.test(e.message));
});

test("legacy ~/.autoplan home moves once and drops old shim", () => {
  const root = mkdtempSync(join(tmpdir(), "plantrail-home-"));
  const legacy = join(root, ".autoplan");
  const home = join(root, ".plantrail");
  mkdirSync(join(legacy, "bin"), { recursive: true });
  writeFileSync(join(legacy, "state.db"), "db");
  writeFileSync(join(legacy, "bin", "autoplan"), "shim");
  moveLegacyHome(legacy, home);
  assert.equal(readFileSync(join(home, "state.db"), "utf8"), "db");
  assert.ok(!existsSync(legacy));
  assert.ok(!existsSync(join(home, "bin", "autoplan")));
  mkdirSync(legacy);
  writeFileSync(join(legacy, "state.db"), "newer");
  moveLegacyHome(legacy, home);
  assert.equal(readFileSync(join(home, "state.db"), "utf8"), "db");
});
