import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "../src/cli.ts");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "autoplan-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "autoplan-cwd-"));
  return (args: string[], input?: string) => {
    const r = spawnSync("node", [CLI, "--cwd", cwd, ...args], { input, encoding: "utf8", env: { ...process.env, AUTOPLAN_HOME: home } });
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
  assert.ok(existsSync(join(r.home, "bin", "autoplan")));
});
