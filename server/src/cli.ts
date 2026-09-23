import { parseArgs } from "node:util";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { plantrailHome, openDb } from "./db.ts";
import { exportHtml } from "./html.ts";
import { serve } from "./serve.ts";
import * as fmt from "./format.ts";
import { shortSha } from "./repo.ts";
import { planItems } from "./markdown.ts";
import { EDGE_TYPES, NODE_KINDS, NotBoundError, PlantrailError, Store, type AddItem, type EdgeType, type NodeKind, type NodeStatus } from "./store.ts";

const USAGE = `usage: plantrail <command> [args] [--cwd DIR] [--thread ID]
  status                                   compact view of the bound thread
  threads [--all]                          list threads (* = bound here)
  create TITLE --goal G [--no-link]        create thread, link this dir, bind
  bind THREAD_ID                           bind this dir to a thread (reactivates a parked one)
  park [THREAD_ID]                         park a thread (default: bound); threads idle 30d auto-park
  finish [THREAD_ID]                       mark a thread (default: bound) done; it stops auto-resuming
  reopen THREAD_ID                         reactivate a done or parked thread
  rename [TITLE] [--goal G]                change the bound thread's title and/or goal (or --thread ID)
  link [THREAD_ID] [--prune]               link this dir/repo to a thread (default: bound), e.g. after
                                           a repo moved; --prune drops links to paths that no longer exist
  link url:URL | ticket:ID                 attach an issue/PR/doc link to the bound thread (or --thread ID)
  unlink KIND:VALUE                        remove one link, as printed by 'link' (or --thread ID)
  add TITLE [--kind K] [--parent ID] [--body B] [--priority N] [--blocks ID,..] [--blocked-by ID,..]
  add -                                    add items from a JSON array on stdin
                                           ({title, kind?, parent?, body?, priority?, blocks?, blocked_by?};
                                            "#i" refers to the i-th item of the same array; #1 is the first)
  import FILE|- [--parent ID] [--dry-run]  add a markdown plan as nodes: headings and list items become
                                           tasks (nested), other text their bodies; [x] items skipped
  start ID                                 mark active (refuses if blocked)
  done ID --summary S [--ref R]... [--commit]
                                           complete; summary required. --ref HEAD (or HEAD~N)
                                           is stored as its short SHA; --commit adds HEAD's
  finding ID TEXT [--confidence 0..1] [--source S]... [--answers]
                                           record a finding under question/node ID
                                           (--answers: also close question ID with it)
  update ID [--title T] [--body B] [--status open|blocked|abandoned] [--priority N] [--summary S] [--kind K]
            [--parent ID|none]             (--parent moves the node; none = top level)
  edge FROM TYPE TO [--remove]             add/remove an edge; TYPE: blocks, derived_from, contradicts
  delete ID                                delete a mistaken leaf node with no edges
  next [-n N] [--all]                      ranked options to work on next (--all: across every active thread)
  log [-n N]                               recent checkpoints and done/abandoned nodes (default 10)
  history [-n N]                           recent commands on the bound thread and every row they changed
  undo [--dry-run]                         revert the latest command on the bound thread (repeat to walk back)
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
  precompact --hook                        PreCompact hook: auto-checkpoint if anything changed
  planhook --hook                          PostToolUse(ExitPlanMode) hook: save the plan, suggest import`;

const UPDATE_STATUSES = ["open", "blocked", "abandoned"] as const;

function readStdin(): string {
  return readFileSync(0, "utf8");
}

function readHookInput(): {
  cwd?: string;
  session_id?: string;
  stop_hook_active?: boolean;
  trigger?: string;
  tool_input?: { plan?: string };
} {
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

const doneHint = (id: string) => `plantrail done ${id}`;

function need(v: string | undefined, what: string): string {
  if (!v) throw new PlantrailError(`Missing ${what}. Run 'plantrail help' for usage.`);
  return v;
}

function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], what: string, hint = ""): T | undefined {
  if (v !== undefined && !(allowed as readonly string[]).includes(v))
    throw new PlantrailError(`${what} must be one of ${allowed.join(", ")}${hint}`);
  return v as T | undefined;
}

const kindOf = (v: string | undefined): NodeKind | undefined => oneOf(v, NODE_KINDS, "--kind");

function numOf(v: string | undefined, what: string, range: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (v.trim() === "" || Number.isNaN(n)) throw new PlantrailError(`${what} must be a number ${range}`);
  return n;
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
      remove: { type: "boolean" },
      kind: { type: "string" },
      parent: { type: "string" },
      body: { type: "string" },
      priority: { type: "string" },
      blocks: { type: "string" },
      "blocked-by": { type: "string" },
      summary: { type: "string" },
      ref: { type: "string", multiple: true },
      commit: { type: "boolean" },
      "dry-run": { type: "boolean" },
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
  // Claude Code exports the session id to Bash commands, so CLI calls resolve
  // this session's own binding even when other sessions share the cwd.
  store.session = session ?? process.env.CLAUDE_CODE_SESSION_ID ?? null;
  if (v.thread) store.bound = store.getThread(v.thread).id;
  // Op label for history: the command line minus where/who it ran as.
  store.label = argv
    .filter((a, i) => !/^--(session|cwd)(=|$)/.test(a) && !/^--(session|cwd)$/.test(argv[i - 1] ?? ""))
    .join(" ")
    .slice(0, 200);
  const out = (s: string) => console.log(s);
  // Slash-command templates embed `status`/`next`; a non-zero exit aborts the
  // whole command, so "nothing bound" is reported as normal output.
  const unbound = (f: () => string): string => {
    try {
      return f();
    } catch (e) {
      if (!(e instanceof NotBoundError)) throw e;
      const active = store.listThreads("active");
      return active.length ? `${e.message}\nActive threads:\n${fmt.formatThreads(active, null)}` : e.message;
    }
  };

  switch (cmd) {
    case "resume": {
      installShim();
      const text = store.resume();
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
      const reason = store.stopNudge();
      if (reason) out(JSON.stringify({ decision: "block", reason }));
      return 0;
    }
    case "precompact": {
      const cp = store.autoCheckpoint(undefined, input.trigger === "manual" ? "/compact" : "auto-compaction");
      if (cp) out(JSON.stringify({ systemMessage: `plantrail: saved checkpoint #${cp.id} on ${cp.thread} before compaction` }));
      return 0;
    }
    case "planhook": {
      const plan = input.tool_input?.plan;
      if (!plan?.trim() || !planItems(plan).items.length) return 0;
      const dir = join(plantrailHome(), "plans");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${(session ?? "plan").slice(0, 8)}.md`);
      writeFileSync(file, plan);
      out(JSON.stringify({
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: store.planHint(file) },
      }));
      return 0;
    }
    case "import": {
      const md = need(arg, "FILE (or '-' for stdin)") === "-" ? readStdin() : readFileSync(arg!, "utf8");
      const { items, skipped } = planItems(md, v.parent);
      if (!items.length) throw new PlantrailError("No headings or list items to import");
      const note = skipped ? `(skipped ${skipped} checked item${skipped === 1 ? "" : "s"})` : null;
      out(fmt.formatImport(items, v["dry-run"] ? null : store.add(items)));
      if (note) out(note);
      return 0;
    }
    case "status":
      out(unbound(() => store.statusText()));
      return 0;
    case "threads": {
      const ts = store.listThreads(v.all ? "all" : "active");
      let bound: string | null = null;
      try {
        bound = store.current().id;
      } catch {}
      out(fmt.formatThreads(ts, bound));
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
    case "finish":
      out(fmt.formatFinish(store.finishThread(arg ?? store.current().id)));
      return 0;
    case "reopen": {
      const t = store.reopenThread(need(arg, "THREAD_ID"));
      out(`Reopened ${t.id} "${t.title}".`);
      return 0;
    }
    case "rename": {
      const t = store.renameThread(store.current().id, arg, v.goal);
      out(fmt.formatRename(t, v.goal !== undefined));
      return 0;
    }
    case "link": {
      out(fmt.formatRelink(arg?.includes(":") ? store.linkRef(v.thread, arg) : store.relink(arg, !!v.prune)));
      return 0;
    }
    case "unlink": {
      if (!arg) throw new PlantrailError("Missing link (kind:value). Run 'plantrail link' to list links.");
      out(fmt.formatUnlink(store.unlink(v.thread, arg)));
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
      for (const n of store.add(items)) out(fmt.line(n));
      return 0;
    }
    case "start": {
      out(fmt.formatStart(store.start(need(arg, "ID"))));
      return 0;
    }
    case "done": {
      const refs = [...(v.ref ?? []), ...(v.commit ? ["HEAD"] : [])].map((r) => {
        if (!/^HEAD([~^]\d*)*$/.test(r)) return r;
        const sha = shortSha(store.cwd, r);
        if (!sha) throw new PlantrailError(`${r} doesn't resolve to a commit in ${store.cwd}`);
        return sha;
      });
      out(fmt.formatDone(store.done(need(arg, "ID"), need(v.summary, "--summary"), refs.length ? refs : undefined), doneHint));
      return 0;
    }
    case "finding": {
      const [id, ...rest] = args;
      out(fmt.formatFinding(store.recordFinding(
        need(id, "ID"),
        need(rest.join(" ") || undefined, "TEXT"),
        numOf(v.confidence, "--confidence", "between 0 and 1"),
        v.source,
        v.answers,
      ), doneHint));
      return 0;
    }
    case "update": {
      const status = oneOf<NodeStatus>(v.status, UPDATE_STATUSES, "--status", " (use start/done otherwise)");
      const r = store.update(need(arg, "ID"), {
        title: v.title,
        body: v.body,
        status,
        priority: intOf(v.priority, "--priority"),
        summary: v.summary,
        kind: kindOf(v.kind),
        parent: v.parent === "none" ? null : v.parent,
      });
      out(fmt.formatUpdate(r));
      return 0;
    }
    case "edge": {
      const from = need(args[0], "FROM");
      const type = oneOf<EdgeType>(need(args[1], "TYPE"), EDGE_TYPES, "TYPE")!;
      const to = need(args[2], "TO");
      if (v.remove) out(fmt.formatEdge(from, type, to, true, store.removeEdge(from, type, to).unblocked));
      else {
        store.addEdge(from, type, to);
        out(fmt.formatEdge(from, type, to, false));
      }
      return 0;
    }
    case "delete": {
      const n = store.deleteNode(need(arg, "ID"));
      out(`Deleted ${n.id} "${n.title}".`);
      return 0;
    }
    case "next": {
      const n = intOf(v.n, "-n") ?? 3;
      out(v.all ? fmt.formatNext(store.nextOptionsAll(n)) : unbound(() => fmt.formatNext(store.nextOptions(n))));
      return 0;
    }
    case "log":
      out(fmt.formatLog(store.log(intOf(v.n, "-n") ?? 10)));
      return 0;
    case "history":
      out(fmt.formatHistory(store.history(intOf(v.n, "-n") ?? 10)));
      return 0;
    case "undo": {
      const op = store.undo(v["dry-run"]);
      out(fmt.formatUndo(op, !!v["dry-run"]));
      return 0;
    }
    case "get":
      out(store.getText(need(arg, "ID"), intOf(v.depth, "--depth") ?? 0));
      return 0;
    case "search": {
      const hits = store.search(need(arg, "QUERY"), { all: v.all, kind: kindOf(v.kind), limit: intOf(v.n, "-n") ?? 10 });
      out(fmt.formatSearch(hits, v.all));
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
  // SQLITE_BUSY (incl. extended codes): another process held the write lock past busy_timeout.
  const busy = ((e as { errcode?: number }).errcode ?? 0) % 256 === 5;
  if (!busy && !(e instanceof PlantrailError) && !(e instanceof TypeError && "code" in e)) throw e;
  console.error(busy ? "The plantrail database is locked by another process; try again." : (e as Error).message);
  process.exitCode = 1;
}
