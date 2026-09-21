import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "../src/cli.ts");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "plantrail-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "plantrail-cwd-"));
  return (args: string[], input?: string) => {
    const r = spawnSync("node", [CLI, "--cwd", cwd, ...args], { input, encoding: "utf8", env: { ...process.env, PLANTRAIL_HOME: home } });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), home };
  };
}

test("cli: create, add via stdin, workflow rules, status", () => {
  const ap = setup();
  assert.equal(ap(["status"]).code, 1);
  assert.match(ap(["create", "Demo", "--goal", "g"]).out, /Created and bound t1/);
  const add = ap(["add", "-"], JSON.stringify([{ title: "a", blocks: ["#1"] }, { title: "b", kind: "question" }]));
  assert.equal(add.out, "n1 [task/open] a\nn2 [question/open] b");
  assert.match(ap(["start", "n2"]).err, /blocked by n1/);
  assert.match(ap(["done", "n1"]).err, /Missing --summary/);
  assert.match(ap(["done", "n1", "--summary", "did it", "--ref", "x.ts"]).out, /Unblocked: n2/);
  assert.match(ap(["next"]).out, /^n2 /);
  assert.equal(ap(["checkpoint", "note"]).code, 0);
  assert.match(ap(["status"]).out, /Last checkpoint .*: note/);
  assert.equal(ap(["finding", "n2", "it", "works", "--confidence", "0.7", "--source", "a.md"]).out, "Recorded n3 [finding/done] it works (conf 0.7) under n2");
  assert.match(ap(["finding", "n2", "x", "--confidence", "high"]).err, /must be a number/);
});

test("cli: bad input exits 1/2 without a stack trace", () => {
  const ap = setup();
  ap(["create", "Demo", "--goal", "g"]);
  assert.equal(ap(["bogus"]).code, 2);
  const bad = ap(["add", "x", "--wat"]);
  assert.equal(bad.code, 1);
  assert.doesNotMatch(bad.err, /\n\s+at /);
  assert.match(ap(["add", "-"], "not json").err, /not valid JSON/);
  assert.match(ap(["add", "x", "--kind", "nope"]).err, /--kind must be/);
});

test("cli: resume installs the shim", () => {
  const ap = setup();
  const r = ap(["resume"]);
  assert.equal(r.code, 0);
  assert.ok(existsSync(join(r.home, "bin", "plantrail")));
});

test("cli: stop/precompact hooks emit JSON only when there is something to record", () => {
  const ap = setup();
  assert.equal(ap(["stop", "--hook"], "{}").out, "");
  ap(["create", "Demo", "--goal", "g"]);
  ap(["add", "x"]);
  const stop = JSON.parse(ap(["stop", "--hook"], "{}").out);
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /checkpoint/);
  assert.equal(ap(["stop", "--hook"], JSON.stringify({ stop_hook_active: true })).out, "");
  assert.match(JSON.parse(ap(["precompact", "--hook"], "{}").out).systemMessage, /saved checkpoint #1 on t1/);
  assert.equal(ap(["precompact", "--hook"], "{}").out, "");
});

test("cli: export md and json", () => {
  const ap = setup();
  ap(["create", "Demo", "--goal", "ship it"]);
  ap(["add", "-"], JSON.stringify([{ title: "dep" }, { title: "parent" }, { title: "child", parent: "#1", blocked_by: ["#0"] }]));
  ap(["done", "n1", "--summary", "dep done", "--ref", "a.ts"]);
  ap(["checkpoint", "cp note"]);
  const md = ap(["export"]).out;
  assert.match(md, /^# Demo \(t1\)/);
  assert.match(md, /\*\*Goal:\*\* ship it/);
  assert.match(md, /^- \[ \] \*\*n2\*\* parent\n  - \[ \] \*\*n3\*\* child _\(blocked by n1\)_/m);
  assert.match(md, /- \[x\] \*\*n1\*\* dep\n  - Summary: dep done\n  - Refs: `a.ts`/);
  assert.match(md, /## Checkpoints\n\n- .* — cp note/);
  const j = JSON.parse(ap(["export", "t1", "--format", "json"]).out);
  assert.deepEqual(j.nodes.map((n: any) => n.id), ["n1", "n2", "n3"]);
  assert.deepEqual(j.nodes[0].refs, ["a.ts"]);
  assert.deepEqual(j.edges, [{ from_id: "n1", to_id: "n3", type: "blocks" }]);
  assert.equal(j.checkpoints[0].note, "cp note");
  assert.match(ap(["export", "--format", "xml"]).err, /md, json or html/);
});

test("cli: unlink reports bad input as a clean error", () => {
  const ap = setup();
  ap(["create", "Demo", "--goal", "g"]);
  for (const args of [["unlink"], ["unlink", "nocolon"], ["unlink", "repo:nope"]]) {
    const r = ap(args);
    assert.equal(r.code, 1);
    assert.doesNotMatch(r.err, /\n\s+at /);
  }
});
