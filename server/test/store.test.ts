import { test } from "node:test";
import { execFileSync } from "node:child_process";
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
  const [a, b] = store.add([{ title: "a", blocks: ["#2"] }, { title: "b" }]);
  assert.throws(() => store.start(b.id), /blocked by n1/);
  assert.throws(() => store.done(a.id, "  "), PlantrailError);
  const r = store.done(a.id, "did a", ["file.ts"]);
  assert.deepEqual(r.unblocked.map((n) => n.id), [b.id]);
  assert.equal(store.start(b.id).node.status, "active");
});

test("manually blocked node reopens when last blocker resolves", () => {
  const { store } = setup();
  const [a, b, c] = store.add([{ title: "a" }, { title: "b" }, { title: "c", blocked_by: ["#1", "#2"] }]);
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
  const [p, c1, c2] = store.add([{ title: "p" }, { title: "c1", parent: "#1" }, { title: "c2", parent: "#1" }]);
  assert.throws(() => store.done(p.id, "x"), /unresolved children/);
  assert.equal(store.done(c1.id, "x").parentReady, null);
  assert.equal(store.update(c2.id, { status: "abandoned", summary: "dup" }).node.status, "abandoned");
  assert.equal(store.done(p.id, "all done").node.status, "done");
});

test("add rejects forward refs for parent and cross-thread ids", () => {
  const { store } = setup();
  assert.throws(() => store.add([{ title: "a", parent: "#2" }, { title: "b" }]), /earlier item/);
  assert.throws(() => store.add([{ title: "a", parent: "#1" }]), /earlier item/);
  assert.throws(() => store.add([{ title: "a", blocked_by: ["#1"] }]), /earlier item/);
  assert.throws(() => store.add([{ title: "a", blocks: ["#2"] }]), /#2 is out of range: this call has 1 item\(s\), #1\.\.#1/);
  assert.throws(() => store.add([{ title: "a" }, { title: "b", parent: "#3" }]), /out of range.*#1 is the first/);
  assert.throws(() => store.add([{ title: "a" }, { title: "b", parent: "#0" }]), /#0 is out of range/);
  assert.throws(() => store.add([{ title: "a", blocks: ["#1"] }]), /cannot block itself/);
  const [x] = store.add([{ title: "x" }]);
  store.createThread("Other", "g", false);
  assert.throws(() => store.add([{ title: "y", parent: x.id }]), /belongs to thread t1/);
});

test("next_options: priority > leaf > depth, skips blocked and non-actionable kinds", () => {
  const { store } = setup();
  const [epic, leafDeep, , , hi, blocked] = store.add([
    { title: "epic" },
    { title: "deep leaf", parent: "#1" },
    { title: "shallow leaf" },
    { title: "a finding", kind: "finding" },
    { title: "urgent", priority: 2 },
    { title: "blocked", priority: 5, blocked_by: ["#3"] },
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

test("nextOptionsAll ranks across active threads only", () => {
  const { store } = setup();
  store.add([{ title: "here" }]);
  const t2 = store.createThread("Second", "g");
  const [urgent] = store.add([{ title: "urgent", priority: 2 }]);
  const t3 = store.createThread("Finished", "g");
  store.add([{ title: "hidden", priority: 9 }]);
  store.finishThread(t3.id);
  const opts = store.nextOptionsAll(5);
  assert.deepEqual(opts.map((o) => [o.node.id, o.thread_title]), [[urgent.id, "Second"], ["n1", "Test"]]);
  assert.equal(store.nextOptions(5, t2.id)[0].thread_title, undefined);
});

test("status is compact and includes checkpoint", () => {
  const { store } = setup();
  const [a] = store.add([{ title: "a" }, { title: "b", blocked_by: ["#1"] }]);
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

test("current() prefers this session's binding over the cwd's latest", () => {
  const { store, db, dir } = setup();
  const now = store.now;
  const a = new Store(db, dir, now);
  a.session = "sA";
  a.resume();
  const b = new Store(db, dir, now);
  b.session = "sB";
  const t2 = b.createThread("Second", "g");
  const later = new Store(db, dir, now);
  later.session = "sA";
  assert.equal(later.current().id, "t1");
  assert.equal(new Store(db, dir, now).current().id, t2.id);
  // A parked session thread falls through to the cwd's latest binding.
  store.setThreadStatus("t1", "parked");
  const parked = new Store(db, dir, now);
  parked.session = "sA";
  assert.equal(parked.current().id, t2.id);
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
  const [q, t] = store.add([{ title: "q", kind: "question", blocks: ["#2"] }, { title: "t" }]);
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
  const [q] = store.add([{ title: "q", kind: "question" }, { title: "sub", parent: "#1" }]);
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

test("contradicting findings mark a question contested in next and status", () => {
  const { store } = setup();
  const [task, q] = store.add([{ title: "task" }, { title: "q", kind: "question" }]);
  const a = store.recordFinding(q.id, "yes", 0.9).node;
  const b = store.recordFinding(q.id, "no", 0.9).node;
  assert.deepEqual(store.nextOptions(2).map((o) => o.node.id), [task.id, q.id]);
  assert.doesNotMatch(store.statusText(), /Contradictions/);
  store.addEdge(b.id, "contradicts", a.id);
  const opts = store.nextOptions(2);
  assert.deepEqual(opts.map((o) => o.node.id), [q.id, task.id]);
  assert.match(opts[0].why, new RegExp(`contested ${b.id}⟂${a.id}`));
  assert.match(store.statusText(), new RegExp(`Contradictions:\\n  ${b.id} \\(finding\\) no ⟂ ${a.id} \\(finding\\) yes`));
  store.done(q.id, "settled: yes");
  assert.doesNotMatch(store.statusText(), /Contradictions/);
});

test("changes are tracked by event order, not timestamps", () => {
  const { store } = setup(); // clock never advances: every write shares one timestamp
  const [a, b] = store.add([{ title: "a" }, { title: "b" }]);
  store.checkpoint("cp");
  assert.equal(store.autoCheckpoint(), null);
  store.start(b.id);
  assert.match(store.stopNudge() ?? "", /1 node\(s\) changed since the last checkpoint: n2 \(active\)/);
  assert.equal(store.stopNudge(), null);
  store.done(a.id, "did a");
  assert.match(store.stopNudge() ?? "", /: n1 \(done\)/);
});

test("history records each op; undo walks back and refuses conflicts", () => {
  const { store, clock } = setup();
  store.label = "add";
  const [a, b] = store.add([{ title: "a" }, { title: "b", blocked_by: ["#1"] }]);
  clock.advance(1000);
  store.label = "done";
  store.start(a.id);
  store.done(a.id, "did a");
  const [latest] = store.history(1);
  assert.equal(latest.label, "done");
  assert.deepEqual(latest.changes, ["n1: status active→done, summary"]);
  assert.match(store.history().map((o) => o.changes.join(";")).join("\n"), /\+n2 b.*\+edge n1 blocks n2/s);

  assert.equal(store.undo(true).label, "done");
  assert.equal(store.getNode(a.id).status, "done"); // dry run changed nothing
  const u = store.undo();
  assert.deepEqual(u.changes, ["n1: status active→done, summary"]);
  const n1 = store.getNode(a.id);
  assert.equal(n1.status, "active");
  assert.equal(n1.summary, null);
  assert.equal(store.search("did").length, 0); // FTS follows restored rows
  assert.match(store.history(1)[0].label ?? "", /done/);
  assert.equal(store.history(1)[0].undoes, u.id);

  assert.equal(store.undo().label, "done"); // the start
  assert.equal(store.getNode(a.id).status, "open");
  store.undo(); // the add
  assert.throws(() => store.getNode(b.id), /No node/);
  assert.equal(store.search("b").length, 0);
  assert.throws(() => store.undo(), /created thread t1; undo can.t remove threads/);
});

test("undo refuses when a touched row changed outside recorded ops, and restores deletes", () => {
  const { store, db } = setup();
  const [a] = store.add([{ title: "a" }]);
  store.update(a.id, { title: "a2" });
  db.prepare("UPDATE nodes SET title = 'sneaky' WHERE id = ?").run(a.id);
  assert.throws(() => store.undo(), /Can't undo op \d+: n1 has changed since/);
  db.prepare("UPDATE nodes SET title = 'a2' WHERE id = ?").run(a.id);
  const [c] = store.add([{ title: "c" }]);
  store.deleteNode(c.id);
  assert.match(store.undo().changes[0], /^-n2 c/);
  assert.equal(store.getNode(c.id).title, "c");
  assert.equal(store.search("c").length, 1);
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

test("stop nudge mentions unpushed commits", () => {
  const { store, clock, dir } = setup();
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { stdio: "ignore" });
  const remote = mkdtempSync(join(tmpdir(), "plantrail-remote-"));
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "one");
  git("remote", "add", "origin", remote);
  git("push", "-q", "-u", "origin", "HEAD");
  const [a] = store.add([{ title: "a" }]);
  clock.advance(1000);
  store.start(a.id);
  assert.doesNotMatch(store.stopNudge() ?? "", /unpushed|aren't pushed/);
  git("commit", "-q", "--allow-empty", "-m", "two");
  clock.advance(1000);
  store.done(a.id, "did a");
  assert.match(store.stopNudge() ?? "", /1 commit\(s\) on this branch aren't pushed/);
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

test("finish and reopen threads", () => {
  const { store, dir, db } = setup();
  const t = store.current();
  store.add([{ title: "a" }]);
  const r = store.finishThread(t.id);
  assert.equal(r.thread.status, "done");
  assert.equal(r.open, 1);
  assert.throws(() => store.finishThread(t.id), /already done/);
  // A fresh process in the same dir no longer auto-resumes the done thread.
  assert.throws(() => new Store(db, dir).current(), PlantrailError);
  assert.equal(store.reopenThread(t.id).status, "active");
  assert.throws(() => store.reopenThread(t.id), /already active/);
  assert.equal(new Store(db, dir).current().id, t.id);
});

test("move and delete nodes", () => {
  const { store } = setup();
  const [a, b, c, d] = store.add([{ title: "a" }, { title: "b", parent: "#1" }, { title: "c" }, { title: "d", blocks: ["#3"] }]);
  assert.equal(store.update(c.id, { parent: b.id }).node.parent_id, b.id);
  assert.throws(() => store.update(a.id, { parent: c.id }), /own subtree/);
  assert.throws(() => store.update(a.id, { parent: a.id }), /own subtree/);
  assert.equal(store.update(c.id, { parent: null }).node.parent_id, null);
  store.createThread("Other", "g");
  const [x] = store.add([{ title: "x" }]);
  assert.throws(() => store.update(x.id, { parent: a.id }), /belongs to thread/);
  assert.throws(() => store.deleteNode(a.id), /has children/);
  assert.throws(() => store.deleteNode(d.id), /has edges/);
  assert.equal(store.deleteNode(b.id).id, b.id);
  assert.throws(() => store.getNode(b.id));
  assert.equal(store.search("b").length, 0);
});

test("add and remove edges", () => {
  const { store } = setup();
  const [a, b, c] = store.add([{ title: "a" }, { title: "b" }, { title: "c" }]);
  store.addEdge(a.id, "blocks", b.id);
  store.addEdge(b.id, "blocks", c.id);
  assert.throws(() => store.addEdge(c.id, "blocks", a.id), /cycle/);
  assert.throws(() => store.addEdge(a.id, "blocks", b.id), /already exists/);
  assert.throws(() => store.addEdge(a.id, "blocks", a.id), /itself/);
  assert.throws(() => store.start(b.id), /blocked by/);
  store.update(b.id, { status: "blocked" });
  assert.deepEqual(store.removeEdge(a.id, "blocks", b.id).unblocked.map((n) => n.id), [b.id]);
  assert.equal(store.getNode(b.id).status, "open");
  assert.throws(() => store.removeEdge(a.id, "blocks", b.id), /No edge/);
  store.addEdge(c.id, "contradicts", a.id);
  assert.match(store.getText(c.id), /Contradicts: n1/);
  assert.match(store.getText(a.id), /Contradicted by: n3/);
});

test("log interleaves checkpoints and resolved nodes, newest first", () => {
  const { store, clock } = setup();
  const [a, b, c] = store.add([{ title: "a" }, { title: "b" }, { title: "c" }]);
  clock.advance(1000);
  store.done(a.id, "did a");
  clock.advance(1000);
  store.checkpoint("cp1");
  clock.advance(1000);
  store.update(b.id, { status: "abandoned", summary: "dropped" });
  const log = store.log();
  assert.deepEqual(
    log.map((e) => e.node?.id ?? e.checkpoint),
    [b.id, "cp1", a.id],
  );
  assert.equal(store.log(1).length, 1);
  assert.ok(!log.some((e) => e.node?.id === c.id));
});

test("add rejects blocks cycles, direct or transitive, and rolls back", () => {
  const { store, db } = setup();
  const [a, b] = store.add([{ title: "a" }, { title: "b", blocked_by: ["#1"] }]);
  assert.throws(() => store.add([{ title: "c", blocked_by: [a.id], blocks: [a.id] }]), /cycle/);
  assert.throws(() => store.add([{ title: "c", blocked_by: [b.id], blocks: [a.id] }]), /cycle/);
  assert.throws(() => store.add([{ title: "c", blocks: ["#2"] }, { title: "d", blocks: ["#1"] }]), /cycle/);
  assert.equal(db.isTransaction, false);
  assert.equal(store.search("c").length, 0);
  assert.equal(store.add([{ title: "e", blocked_by: [a.id, a.id] }]).length, 1);
});

test("concurrent opens of a fresh db migrate once", async () => {
  const { spawn } = await import("node:child_process");
  const file = join(mkdtempSync(join(tmpdir(), "plantrail-test-")), "state.db");
  const code = `import { openDb } from ${JSON.stringify(new URL("../src/db.ts", import.meta.url).href)}; openDb(${JSON.stringify(file)});`;
  const runs = Array.from({ length: 8 }, () =>
    new Promise<{ status: number | null; err: string }>((res) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", code]);
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (status) => res({ status, err }));
    }),
  );
  for (const r of await Promise.all(runs)) assert.equal(r.status, 0, r.err);
  const db = openDb(file);
  assert.equal((db.prepare("SELECT count(*) AS c FROM counters").get() as { c: number }).c, 2);
});
