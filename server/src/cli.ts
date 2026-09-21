import { parseArgs } from "node:util";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plantrailHome, openDb } from "./db.ts";
import { exportHtml } from "./html.ts";
import { serve } from "./serve.ts";
import { PlantrailError, Store, type AddItem, type Node, type NodeKind, type NodeStatus } from "./store.ts";

const USAGE = `usage: plantrail <command> [args] [--cwd DIR] [--thread ID]
  status                                   compact view of the bound thread
  threads [--all]                          list threads (* = bound here)
  create TITLE --goal G [--no-link]        create thread, link this dir, bind
  bind THREAD_ID                           bind this dir to a thread (reactivates a parked one)
  park [THREAD_ID]                         park a thread (default: bound); threads idle 30d auto-park
  rename TITLE                             rename the bound thread (or --thread ID)
  link [THREAD_ID] [--prune]               link this dir/repo to a thread (default: bound), e.g. after
                                           a repo moved; --prune drops links to paths that no longer exist
  add TITLE [--kind K] [--parent ID] [--body B] [--priority N] [--blocks ID,..] [--blocked-by ID,..]
  add -                                    add items from a JSON array on stdin
                                           ({title, kind?, parent?, body?, priority?, blocks?, blocked_by?};
                                            "#i" refers to the i-th item of the same array)
  start ID                                 mark active (refuses if blocked)
  done ID --summary S [--ref R]...         complete; summary required
  finding ID TEXT [--confidence 0..1] [--source S]... [--answers]
                                           record a finding under question/node ID
                                           (--answers: also close question ID with it)
  update ID [--title T] [--body B] [--status open|blocked|abandoned] [--priority N] [--summary S] [--kind K]
  next [-n N]                              ranked options to work on next
  get ID [--depth D]                       full node detail (+ subtree)
  search QUERY [--all] [--kind K] [-n N]   full-text search this thread (--all: every thread);
                                           words match as prefixes, "quoted phrases" exactly
  export [THREAD_ID] [--format md|json|html] [-o FILE]
                                           dump a thread (default: bound) as markdown, JSON, or HTML
  serve [--port P]                         local live web view of all threads (default port 7847)
  checkpoint NOTE                          save handoff note
  resume [--session ID] [--hook]           SessionStart: bind + print status
                                           (--hook: read {cwd, session_id} JSON from stdin)
  stop --hook                              Stop hook: remind once to checkpoint after changes
  precompact --hook                        PreCompact hook: auto-checkpoint if anything changed`;

const KINDS = ["task", "question", "finding", "decision"];

function readStdin(): string {
  return readFileSync(0, "utf8");
}

function readHookInput(): { cwd?: string; session_id?: string; stop_hook_active?: boolean; trigger?: string } {
  try {
    return JSON.parse(readStdin());
  } catch {
    return {};
  }
}

/** Write ~/.plantrail/bin/plantrail pointing at this bundle, so Claude has a stable command to call. */
function installShim(): void {
  try {
    const dir = join(plantrailHome(), "bin");
    mkdirSync(dir, { recursive: true });
    const shim = join(dir, "plantrail");
    writeFileSync(shim, `#!/bin/sh\nexec node "${fileURLToPath(import.meta.url)}" "$@"\n`);
    chmodSync(shim, 0o755);
  } catch {
    // Non-fatal: the hook must never break session start.
  }
}

const line = (n: Node) => `${n.id} [${n.kind}/${n.status}] ${n.title}`;

function need(v: string | undefined, what: string): string {
  if (!v) throw new PlantrailError(`Missing ${what}. Run 'plantrail help' for usage.`);
  return v;
}

function kindOf(v: string | undefined): NodeKind | undefined {
  if (v !== undefined && !KINDS.includes(v)) throw new PlantrailError(`--kind must be one of ${KINDS.join(", ")}`);
  return v as NodeKind | undefined;
}

function intOf(v: string | undefined, what: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new PlantrailError(`${what} must be an integer`);
  return n;
}

const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

function parseItems(text: string): AddItem[] {
  let items: unknown;
  try {
    items = JSON.parse(text);
  } catch (e) {
    throw new PlantrailError(`stdin is not valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(items)) items = [items];
  const arr = items as AddItem[];
  if (!arr.length) throw new PlantrailError("No items to add");
  for (const [i, it] of arr.entries()) {
    if (!it || typeof it.title !== "string" || !it.title.trim()) throw new PlantrailError(`Item #${i} needs a title`);
    kindOf(it.kind);
  }
  return arr;
}

function main(argv = process.argv.slice(2)): number {
  const { values: v, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      session: { type: "string" },
      thread: { type: "string" },
      hook: { type: "boolean" },
      answers: { type: "boolean" },
      all: { type: "boolean" },
      goal: { type: "string" },
      "no-link": { type: "boolean" },
      prune: { type: "boolean" },
      kind: { type: "string" },
      parent: { type: "string" },
      body: { type: "string" },
      priority: { type: "string" },
      blocks: { type: "string" },
      "blocked-by": { type: "string" },
      summary: { type: "string" },
      ref: { type: "string", multiple: true },
      confidence: { type: "string" },
      source: { type: "string", multiple: true },
      title: { type: "string" },
      status: { type: "string" },
      n: { type: "string", short: "n" },
      depth: { type: "string" },
      format: { type: "string" },
      o: { type: "string", short: "o" },
      port: { type: "string" },
    },
  });
  const [cmd, ...args] = positionals;
  const arg = args.join(" ") || undefined;
  let cwd = v.cwd;
  let session = v.session;
  let input: ReturnType<typeof readHookInput> = {};
  if (v.hook) {
    input = readHookInput();
    cwd ??= input.cwd;
    session ??= input.session_id;
  }
  const store = new Store(openDb(), cwd ?? process.cwd());
  if (v.thread) store.bound = store.getThread(v.thread).id;
  const out = (s: string) => console.log(s);

  switch (cmd) {
    case "resume": {
      installShim();
      const text = store.resume(session);
      if (!text) return 0;
      if (v.hook) {
        // JSON output: full status goes to Claude's context, a one-line notice to the user.
        const lines = text.split("\n");
        const nodes = lines.find((l) => l.startsWith("Nodes:"));
        const notice = [lines[0].replace(/^\[plantrail\] /, "plantrail: resumed "), nodes?.replace(/^Nodes: /, "")]
          .filter(Boolean)
          .join(" — ");
        out(JSON.stringify({
          systemMessage: notice,
          hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
        }));
      } else out(text);
      return 0;
    }
    case "stop": {
      // Stop hook: block once with a reminder so Claude records progress.
      if (input.stop_hook_active) return 0;
      const reason = store.stopNudge(session);
      if (reason) out(JSON.stringify({ decision: "block", reason }));
      return 0;
    }
    case "precompact": {
      const cp = store.autoCheckpoint(session, input.trigger === "manual" ? "/compact" : "auto-compaction");
      if (cp) out(JSON.stringify({ systemMessage: `plantrail: saved checkpoint #${cp.id} on ${cp.thread} before compaction` }));
      return 0;
    }
    case "status":
      out(store.statusText());
      return 0;
    case "threads": {
      const ts = store.listThreads(v.all ? "all" : "active");
      let bound: string | null = null;
      try {
        bound = store.current().id;
      } catch {}
      if (!ts.length) out("No threads.");
      for (const t of ts)
        out(`${t.id}${t.id === bound ? "*" : ""} [${t.status}] ${t.title} (touched ${t.touched_at.slice(0, 10)})`);
      return 0;
    }
    case "create": {
      const t = store.createThread(need(arg, "TITLE"), need(v.goal, "--goal"), !v["no-link"]);
      out(`Created and bound ${t.id} "${t.title}".`);
      return 0;
    }
    case "bind":
      store.bind(need(arg, "THREAD_ID"));
      out(store.statusText());
      return 0;
    case "park": {
      const t = store.setThreadStatus(arg ?? store.current().id, "parked");
      out(`Parked ${t.id} "${t.title}". \`plantrail bind ${t.id}\` reactivates it.`);
      return 0;
    }
    case "rename": {
      const t = store.renameThread(store.current().id, need(arg, "TITLE"));
      out(`Renamed ${t.id} to "${t.title}".`);
      return 0;
    }
    case "link": {
      const r = store.relink(arg, !!v.prune);
      const fmt = (ks: { kind: string; value: string }[]) => ks.map((k) => `${k.kind}:${k.value}`).join(", ");
      if (r.added.length) out(`Added: ${fmt(r.added)}`);
      if (r.removed.length) out(`Removed: ${fmt(r.removed)}`);
      out(`Links: ${fmt(r.links) || "(none)"}`);
      return 0;
    }
    case "add": {
      const items: AddItem[] =
        arg === "-"
          ? parseItems(readStdin())
          : [
              {
                title: need(arg, "TITLE (or '-' for JSON on stdin)"),
                kind: kindOf(v.kind),
                parent: v.parent,
                body: v.body,
                priority: intOf(v.priority, "--priority"),
                blocks: list(v.blocks),
                blocked_by: list(v["blocked-by"]),
              },
            ];
      for (const n of store.add(items)) out(line(n));
      return 0;
    }
    case "start": {
      const { node, demoted } = store.start(need(arg, "ID"));
      out(`Started ${line(node)}`);
      if (demoted.length) out(`Returned to open: ${demoted.join(", ")}`);
      return 0;
    }
    case "done": {
      const { node, unblocked, parentReady } = store.done(need(arg, "ID"), need(v.summary, "--summary"), v.ref);
      out(`Done ${line(node)}`);
      if (unblocked.length) out(`Unblocked: ${unblocked.map(line).join("; ")}`);
      if (parentReady)
        out(`All children of ${parentReady.id} "${parentReady.title}" are resolved — consider: plantrail done ${parentReady.id}`);
      return 0;
    }
    case "finding": {
      const [id, ...rest] = args;
      let conf: number | undefined;
      if (v.confidence !== undefined) {
        conf = Number(v.confidence);
        if (Number.isNaN(conf)) throw new PlantrailError("--confidence must be a number between 0 and 1");
      }
      const { node: n, closed } = store.recordFinding(
        need(id, "ID"),
        need(rest.join(" ") || undefined, "TEXT"),
        conf,
        v.source,
        v.answers,
      );
      out(`Recorded ${line(n)}${n.confidence != null ? ` (conf ${n.confidence})` : ""} under ${n.parent_id}`);
      if (closed) {
        out(`Answered ${line(closed.node)}`);
        if (closed.unblocked.length) out(`Unblocked: ${closed.unblocked.map(line).join("; ")}`);
        if (closed.parentReady)
          out(`All children of ${closed.parentReady.id} "${closed.parentReady.title}" are resolved — consider: plantrail done ${closed.parentReady.id}`);
      }
      return 0;
    }
    case "update": {
      if (v.status !== undefined && !["open", "blocked", "abandoned"].includes(v.status))
        throw new PlantrailError("--status must be open, blocked, or abandoned (use start/done otherwise)");
      const { node, unblocked } = store.update(need(arg, "ID"), {
        title: v.title,
        body: v.body,
        status: v.status as NodeStatus | undefined,
        priority: intOf(v.priority, "--priority"),
        summary: v.summary,
        kind: kindOf(v.kind),
      });
      out(`Updated ${line(node)}`);
      if (unblocked.length) out(`Unblocked: ${unblocked.map(line).join("; ")}`);
      return 0;
    }
    case "next": {
      const opts = store.nextOptions(intOf(v.n, "-n") ?? 3);
      if (!opts.length) out("Nothing open and unblocked.");
      for (const o of opts) out(`${line(o.node)}  (score ${o.score}: ${o.why})`);
      return 0;
    }
    case "get":
      out(store.getText(need(arg, "ID"), intOf(v.depth, "--depth") ?? 0));
      return 0;
    case "search": {
      const hits = store.search(need(arg, "QUERY"), { all: v.all, kind: kindOf(v.kind), limit: intOf(v.n, "-n") ?? 10 });
      if (!hits.length) out("No matches.");
      for (const h of hits) out(`${line(h.node)}${v.all ? ` (${h.node.thread_id} "${h.thread_title}")` : ""}\n    ${h.snippet.replace(/\s+/g, " ")}`);
      return 0;
    }
    case "export": {
      const fmt = v.format ?? "md";
      if (fmt !== "md" && fmt !== "json" && fmt !== "html") throw new PlantrailError("--format must be md, json or html");
      const text =
        fmt === "json" ? JSON.stringify(store.exportData(arg), null, 2) + "\n" : fmt === "html" ? exportHtml(store.exportData(arg)) : store.exportMarkdown(arg);
      if (v.o) {
        writeFileSync(v.o, text);
        out(`Wrote ${v.o}`);
      } else process.stdout.write(text);
      return 0;
    }
    case "serve": {
      const port = v.port ? Number(v.port) : 7847;
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new PlantrailError("--port must be 0-65535");
      const srv = serve(store, port);
      srv.on("listening", () => {
        const a = srv.address();
        out(`plantrail serving on http://127.0.0.1:${typeof a === "object" && a ? a.port : port}/ (Ctrl-C to stop)`);
      });
      srv.on("error", (e) => {
        process.stderr.write(`plantrail: ${e.message}\n`);
        process.exitCode = 1;
      });
      return 0;
    }
    case "checkpoint": {
      const { id } = store.checkpoint(need(arg, "NOTE"));
      out(`Checkpoint #${id} saved.`);
      return 0;
    }
    case "help":
    case undefined:
      out(USAGE);
      return cmd ? 0 : 2;
    default:
      console.error(`Unknown command '${cmd}'.\n${USAGE}`);
      return 2;
  }
}

try {
  process.exitCode = main();
} catch (e) {
  if (!(e instanceof PlantrailError) && !(e instanceof TypeError && "code" in e)) throw e;
  console.error(e.message);
  process.exitCode = 1;
}
