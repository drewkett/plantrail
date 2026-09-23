import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "../src/cli.ts");

function setup() {
  const home = mkdtempSync(join(tmpdir(), "plantrail-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "plantrail-cwd-"));
  return Object.assign((args: string[], input?: string, session?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PLANTRAIL_HOME: home };
    delete env.CLAUDE_CODE_SESSION_ID;
    if (session) env.CLAUDE_CODE_SESSION_ID = session;
    const r = spawnSync("node", [CLI, "--cwd", cwd, ...args], { input, encoding: "utf8", env });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim(), home };
  }, { cwd });
}

test("cli: create, add via stdin, workflow rules, status", () => {
  const ap = setup();
  assert.match(ap(["create", "Demo", "--goal", "g"]).out, /Created and bound t1/);
  const add = ap(["add", "-"], JSON.stringify([{ title: "a", blocks: ["#2"] }, { title: "b", kind: "question" }]));
  assert.equal(add.out, "n1 [task/open] a\nn2 [question/open] b");
  assert.match(ap(["start", "n2"]).err, /blocked by n1/);
  assert.match(ap(["done", "n1"]).err, /Missing --summary/);
  assert.match(ap(["done", "n1", "--summary", "did it", "--ref", "x.ts"]).out, /Unblocked: n2/);
  assert.match(ap(["next"]).out, /^n2 /);
  assert.match(ap(["next", "--all"]).out, /^n2 \[question\/open\] b \(t1 "Demo"\)  \(score /);
  assert.equal(ap(["checkpoint", "note"]).code, 0);
  assert.match(ap(["status"]).out, /Last checkpoint .*: note/);
  assert.equal(ap(["finding", "n2", "it", "works", "--confidence", "0.7", "--source", "a.md"]).out, "Recorded n3 [finding/done] it works (conf 0.7) under n2");
  assert.match(ap(["finding", "n2", "x", "--confidence", "high"]).err, /must be a number/);
  assert.match(ap(["finding", "n2", "x", "--confidence", ""]).err, /must be a number/);
  assert.match(ap(["add", "c", "--kind", "bug"]).err, /--kind must be one of task, question, finding, decision/);
  assert.match(ap(["update", "n1", "--status", "done"]).err, /--status must be one of open, blocked, abandoned \(use start\/done/);
  assert.match(ap(["edge", "n1", "follows", "n2"]).err, /TYPE must be one of blocks, derived_from, contradicts/);
  assert.match(ap(["edge", "n1"]).err, /Missing TYPE/);
});

test("cli: done --ref HEAD / --commit store the short SHA", () => {
  const ap = setup();
  ap(["create", "Demo", "--goal", "g"]);
  ap(["add", "-"], JSON.stringify([{ title: "a" }, { title: "b" }]));
  assert.match(ap(["done", "n1", "--summary", "s", "--commit"]).err, /HEAD doesn't resolve to a commit/);
  const git = (...a: string[]) => execFileSync("git", ["-C", ap.cwd, ...a], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two");
  const [head, prev] = [git("rev-parse", "--short", "HEAD"), git("rev-parse", "--short", "HEAD~1")];
  assert.equal(ap(["done", "n1", "--summary", "s", "--commit", "--ref", "x.ts"]).code, 0);
  assert.match(ap(["get", "n1"]).out, new RegExp(`Refs: x\\.ts, ${head}\\b`));
  ap(["done", "n2", "--summary", "s", "--ref", "HEAD~1"]);
  assert.match(ap(["get", "n2"]).out, new RegExp(`Refs: ${prev}\\b`));
});

test("cli: import a markdown plan; ExitPlanMode hook saves it and suggests import", () => {
  const ap = setup();
  ap(["create", "Demo", "--goal", "g"]);
  const md = "# Plan\n## Setup\n- [x] done already\n- install deps\n## Build\n";
  assert.equal(ap(["import", "-", "--dry-run"], md).out, "Setup\n  install deps\nBuild\n(skipped 1 checked item)");
  assert.equal(ap(["status"]).out.match(/Nodes: (.*)/)?.[1], "none");
  assert.equal(ap(["import", "-"], md).out, "n1 [task/open] Setup\n  n2 [task/open] install deps\nn3 [task/open] Build\n(skipped 1 checked item)");
  assert.match(ap(["import", "-"], "prose only").err, /No headings or list items/);

  const hook = ap(["planhook", "--hook"], JSON.stringify({ cwd: ap.cwd, tool_name: "ExitPlanMode", tool_input: { plan: md } }));
  const ctx = JSON.parse(hook.out).hookSpecificOutput.additionalContext as string;
  const file = /Plan saved to (\S+)\./.exec(ctx)?.[1];
  assert.ok(file && existsSync(file) && file.startsWith(join(hook.home, "plans")));
  assert.match(ctx, /Bound thread t1 "Demo".*import .* --dry-run/);
  assert.equal(ap(["planhook", "--hook"], JSON.stringify({ cwd: ap.cwd, tool_input: { plan: "no steps" } })).out, "");
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
  ap(["add", "-"], JSON.stringify([{ title: "dep" }, { title: "parent" }, { title: "child", parent: "#2", blocked_by: ["#1"] }]));
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

test("cli: link attaches url:/ticket: links, rejects hand-made repo/dir links", () => {
  const ap = setup();
  ap(["create", "Demo", "--goal", "g"]);
  const r = ap(["link", "url:https://github.com/x/y/issues/1"]);
  assert.match(r.out, /Added: url:https:\/\/github.com\/x\/y\/issues\/1\nLinks: .*url:https:\/\/github.com\/x\/y\/issues\/1/);
  assert.match(ap(["link", "ticket:ABC-12", "--thread", "t1"]).out, /Added: ticket:ABC-12/);
  assert.doesNotMatch(ap(["link", "ticket:ABC-12"]).out, /Added/);
  assert.match(ap(["export", "--format", "md"]).out, /Links: .*ticket:ABC-12/);
  assert.match(ap(["link", "repo:/elsewhere"]).err, /Only url: and ticket:/);
  assert.match(ap(["link", "bogus:x"]).err, /repo, dir, worktree, branch, url or ticket/);
  assert.match(ap(["link", "url:"]).err, /kind:value/);
  assert.match(ap(["unlink", "ticket:ABC-12"]).out, /Removed: ticket:ABC-12/);
});

test("cli: status/next exit 0 with guidance when no thread is bound", () => {
  const ap = setup();
  for (const cmd of ["status", "next"]) {
    const r = ap([cmd]);
    assert.equal(r.code, 0);
    assert.match(r.out, /No thread bound\. Run `plantrail bind <thread_id>`/);
  }
  const other = mkdtempSync(join(tmpdir(), "plantrail-cwd-"));
  ap(["--cwd", other, "create", "Elsewhere", "--goal", "g"]);
  assert.match(ap(["status"]).out, /Active threads:\nt1 \[active\] Elsewhere/);
  // Commands that need a thread still fail.
  assert.equal(ap(["add", "x"]).code, 1);
});

test("cli: sessions sharing a cwd keep their own thread via CLAUDE_CODE_SESSION_ID", () => {
  const ap = setup();
  ap(["create", "One", "--goal", "g"], undefined, "sA");
  ap(["create", "Two", "--goal", "g"], undefined, "sB");
  assert.match(ap(["status"], undefined, "sA").out, /t1 "One"/);
  assert.match(ap(["status"], undefined, "sB").out, /t2 "Two"/);
  ap(["add", "for one"], undefined, "sA");
  assert.match(ap(["get", "n1"], undefined, "sA").out, /thread t1/);
  // No session id: most recent binding in this cwd.
  assert.match(ap(["status"]).out, /t2 "Two"/);
  // The hook's session_id and the env var name the same binding.
  assert.match(ap(["resume", "--hook"], JSON.stringify({ session_id: "sA" }), "sA").out, /t1 \\"One\\"/);
});
