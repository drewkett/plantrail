import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "./db.ts";
import { PlantrailError, Store, type Node } from "./store.ts";

const store = new Store(openDb(), process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const server = new McpServer({ name: "plantrail", version: "0.1.0" });

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

function run(fn: () => string): Result {
  try {
    return { content: [{ type: "text", text: fn() }] };
  } catch (e) {
    if (e instanceof PlantrailError) return { content: [{ type: "text", text: e.message }], isError: true };
    throw e;
  }
}

const line = (n: Node) => `${n.id} [${n.kind}/${n.status}] ${n.title}`;

const kind = z.enum(["task", "question", "finding", "decision"]);

server.registerTool(
  "thread_create",
  {
    description:
      "Create a new plantrail thread (a long-running task or research effort) and bind this session to it. Links the current repo/dir by default so future sessions here resume it automatically.",
    inputSchema: {
      title: z.string(),
      goal: z.string().describe("What 'done' looks like, one or two sentences"),
      link_cwd: z.boolean().default(true),
    },
  },
  ({ title, goal, link_cwd }) =>
    run(() => {
      const t = store.createThread(title, goal, link_cwd);
      return `Created and bound ${t.id} "${t.title}".`;
    }),
);

server.registerTool(
  "list_threads",
  {
    description: "List threads, most recently touched first.",
    inputSchema: { filter: z.enum(["active", "parked", "done", "all"]).default("active") },
  },
  ({ filter }) =>
    run(() => {
      const ts = store.listThreads(filter);
      if (!ts.length) return `No ${filter === "all" ? "" : filter + " "}threads.`;
      return ts
        .map((t) => `${t.id}${t.id === store.bound ? "*" : ""} [${t.status}] ${t.title} (touched ${t.touched_at.slice(0, 10)})`)
        .join("\n");
    }),
);

server.registerTool(
  "bind",
  {
    description: "Bind this session to an existing thread. Returns its status.",
    inputSchema: { thread_id: z.string() },
  },
  ({ thread_id }) =>
    run(() => {
      store.bind(thread_id);
      return store.statusText();
    }),
);

server.registerTool(
  "park",
  {
    description:
      "Park a thread (default: the bound one) so it stops auto-resuming here. Binding it again reactivates it. Threads idle 30 days are parked automatically.",
    inputSchema: { thread_id: z.string().optional() },
  },
  ({ thread_id }) =>
    run(() => {
      const t = store.setThreadStatus(thread_id ?? store.current().id, "parked");
      return `Parked ${t.id} "${t.title}".`;
    }),
);

server.registerTool(
  "link",
  {
    description:
      "Link the current repo/dir to a thread (default: the bound one) so sessions here resume it, e.g. after a repo moved. prune drops links to paths that no longer exist.",
    inputSchema: { thread_id: z.string().optional(), prune: z.boolean().default(false) },
  },
  ({ thread_id, prune }) =>
    run(() => {
      const r = store.relink(thread_id, prune);
      const fmt = (ks: { kind: string; value: string }[]) => ks.map((k) => `${k.kind}:${k.value}`).join(", ");
      return [
        r.added.length ? `Added: ${fmt(r.added)}` : null,
        r.removed.length ? `Removed: ${fmt(r.removed)}` : null,
        `Links: ${fmt(r.links) || "(none)"}`,
      ]
        .filter(Boolean)
        .join("\n");
    }),
);

server.registerTool(
  "status",
  {
    description:
      "Compact view of the bound thread: goal, active node, top next options, blockers, last checkpoint. Call this instead of re-reading plan files.",
    inputSchema: {},
  },
  () => run(() => store.statusText()),
);

server.registerTool(
  "add",
  {
    description:
      "Add one or more nodes to the bound thread. For a breakdown, pass several items; `parent`, `blocks`, `blocked_by` accept node ids or `#i` to reference the i-th item of this same call (`parent`/`blocked_by` must reference earlier items).",
    inputSchema: {
      items: z
        .array(
          z.object({
            title: z.string(),
            kind: kind.optional(),
            parent: z.string().optional(),
            body: z.string().optional(),
            priority: z.number().int().optional().describe("Higher = sooner. Default 0."),
            blocks: z.array(z.string()).optional(),
            blocked_by: z.array(z.string()).optional(),
          }),
        )
        .min(1),
    },
  },
  ({ items }) => run(() => store.add(items).map(line).join("\n")),
);

server.registerTool(
  "start",
  {
    description: "Mark a node active (the one you're working on now). Refuses if it is blocked. Demotes any other active node to open.",
    inputSchema: { id: z.string() },
  },
  ({ id }) =>
    run(() => {
      const { node, demoted } = store.start(id);
      return `Started ${line(node)}${demoted.length ? `\nReturned to open: ${demoted.join(", ")}` : ""}`;
    }),
);

server.registerTool(
  "done",
  {
    description:
      "Complete a node. `summary` is required: what was done / learned, enough that nobody needs to re-derive it. Unblocks dependents.",
    inputSchema: {
      id: z.string(),
      summary: z.string(),
      refs: z.array(z.string()).optional().describe("Files, commits, URLs backing the summary"),
    },
  },
  ({ id, summary, refs }) =>
    run(() => {
      const { node, unblocked, parentReady } = store.done(id, summary, refs);
      const out = [`Done ${line(node)}`];
      if (unblocked.length) out.push(`Unblocked: ${unblocked.map(line).join("; ")}`);
      if (parentReady) out.push(`All children of ${parentReady.id} "${parentReady.title}" are resolved — consider done(${parentReady.id}).`);
      return out.join("\n");
    }),
);

server.registerTool(
  "record_finding",
  {
    description:
      "Record a finding (a fact learned) under a question or other node. Be honest about confidence. Set `answers` to also close the parent question with this finding. next_options ranks unexplored and low-confidence questions higher.",
    inputSchema: {
      id: z.string().describe("Question (or node) the finding informs"),
      text: z.string().describe("What was found; first line becomes the title"),
      confidence: z.number().min(0).max(1).optional(),
      sources: z.array(z.string()).optional().describe("URLs, files, commits backing the finding"),
      answers: z.boolean().optional().describe("Close the parent question with this finding"),
    },
  },
  ({ id, text, confidence, sources, answers }) =>
    run(() => {
      const { node, closed } = store.recordFinding(id, text, confidence, sources, answers ?? false);
      const out = [`Recorded ${line(node)}${node.confidence != null ? ` (conf ${node.confidence})` : ""} under ${node.parent_id}`];
      if (closed) {
        out.push(`Answered ${line(closed.node)}`);
        if (closed.unblocked.length) out.push(`Unblocked: ${closed.unblocked.map(line).join("; ")}`);
        if (closed.parentReady)
          out.push(`All children of ${closed.parentReady.id} "${closed.parentReady.title}" are resolved — consider done(${closed.parentReady.id}).`);
      }
      return out.join("\n");
    }),
);

server.registerTool(
  "update",
  {
    description:
      "Edit a node's title/body/priority/kind, or change status to open, blocked, or abandoned (abandoning needs a summary saying why). Use start/done for active/done.",
    inputSchema: {
      id: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      status: z.enum(["open", "blocked", "abandoned"]).optional(),
      priority: z.number().int().optional(),
      summary: z.string().optional(),
      kind: kind.optional(),
    },
  },
  ({ id, ...fields }) =>
    run(() => {
      const { node, unblocked } = store.update(id, fields);
      return `Updated ${line(node)}${unblocked.length ? `\nUnblocked: ${unblocked.map(line).join("; ")}` : ""}`;
    }),
);

server.registerTool(
  "next_options",
  {
    description: "Ranked open, unblocked tasks/questions to work on next, with the reason for each ranking.",
    inputSchema: { n: z.number().int().min(1).max(20).default(3) },
  },
  ({ n }) =>
    run(() => {
      const opts = store.nextOptions(n);
      if (!opts.length) return "Nothing open and unblocked.";
      return opts.map((o) => `${line(o.node)}  (score ${o.score}: ${o.why})`).join("\n");
    }),
);

server.registerTool(
  "get",
  {
    description: "Full detail for a node (body, summary, refs, edges), optionally with its subtree to `depth` levels.",
    inputSchema: { id: z.string(), depth: z.number().int().min(0).max(5).default(0) },
  },
  ({ id, depth }) => run(() => store.getText(id, depth)),
);

const searchInput = {
  query: z.string().describe('Words (matched as prefixes, all required) and/or "quoted phrases"'),
  kind: kind.optional(),
  limit: z.number().int().min(1).max(50).default(10),
};

function searchText(query: string, opts: { all?: boolean; kind?: Node["kind"]; limit: number }): string {
  const hits = store.search(query, opts);
  if (!hits.length) return "No matches.";
  return hits
    .map((h) => `${line(h.node)}${opts.all ? ` (${h.node.thread_id} "${h.thread_title}")` : ""}\n    ${h.snippet.replace(/\s+/g, " ")}`)
    .join("\n");
}

server.registerTool(
  "search",
  {
    description:
      "Full-text search over node titles, summaries, and bodies in the bound thread. Use before re-deriving something that may already be recorded (findings, decisions, done summaries).",
    inputSchema: searchInput,
  },
  ({ query, kind, limit }) => run(() => searchText(query, { kind, limit })),
);

server.registerTool(
  "search_all",
  {
    description: "Like search, but across every thread (including parked/done), to reuse findings and decisions from other work.",
    inputSchema: searchInput,
  },
  ({ query, kind, limit }) => run(() => searchText(query, { all: true, kind, limit })),
);

server.registerTool(
  "checkpoint",
  {
    description:
      "Save a handoff note for the bound thread (what you were doing, what's next, anything non-obvious). Do this before stopping, before compaction, and after meaningful progress.",
    inputSchema: { note: z.string() },
  },
  ({ note }) =>
    run(() => {
      const { id } = store.checkpoint(note);
      return `Checkpoint #${id} saved.`;
    }),
);

server.registerTool(
  "export",
  {
    description:
      "Export a whole thread (default: bound) as markdown (readable tree with summaries and checkpoints) or JSON (nodes, edges, links, checkpoints). For sharing or archiving; use status/get for normal work.",
    inputSchema: { thread_id: z.string().optional(), format: z.enum(["md", "json"]).optional() },
  },
  ({ thread_id, format }) =>
    run(() => (format === "json" ? JSON.stringify(store.exportData(thread_id), null, 2) : store.exportMarkdown(thread_id))),
);

server.registerTool(
  "resume",
  {
    description: "Resolve and bind the thread for the current directory and return its status. Normally done automatically at session start.",
    inputSchema: {},
  },
  () => run(() => store.resume() || "No active thread is linked to this location. Use list_threads + bind, or thread_create."),
);

await server.connect(new StdioServerTransport());
