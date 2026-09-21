import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.ts";
import { AutoplanError, Store } from "../src/store.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "autoplan-test-"));
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
  assert.throws(() => store.done(a.id, "  "), AutoplanError);
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
  const fresh = new Store(db, dir);
  assert.match(fresh.resume("s1"), /t1 "Test"/);
  assert.equal(fresh.bound, "t1");
  // A second thread linked here makes location ambiguous, but session s1 stays bound.
  new Store(db, dir).createThread("Second", "g");
  assert.match(new Store(db, dir).resume("s1"), /t1 "Test"/);
  assert.match(new Store(db, dir).resume("s2"), /Multiple active threads/);
});

test("current() falls back to latest binding in cwd", () => {
  const { db, dir } = setup();
  const hook = new Store(db, dir);
  hook.resume("sess");
  const server = new Store(db, dir);
  assert.equal(server.current().id, "t1");
  assert.throws(() => new Store(db, join(dir, "elsewhere")).current(), /No thread bound/);
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
