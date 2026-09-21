import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openDb } from "./db.ts";
import * as fmt from "./format.ts";
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

const doneHint = (id: string) => `done(${id}).`;

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
      return fmt.formatThreads(store.listThreads(filter), store.bound, `No ${filter === "all" ? "" : filter + " "}threads.`);
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
  "finish_thread",
  {
    description:
      "Mark a thread (default: the bound one) done when its goal is met, so it stops auto-resuming. Reports how many nodes are still open. reopen_thread undoes it.",
    inputSchema: { thread_id: z.string().optional() },
  },
  ({ thread_id }) => run(() => fmt.formatFinish(store.finishThread(thread_id ?? store.current().id))),
);

server.registerTool(
  "reopen_thread",
  {
    description: "Reactivate a done or parked thread.",
    inputSchema: { thread_id: z.string() },
  },
  ({ thread_id }) =>
    run(() => {
      const t = store.reopenThread(thread_id);
      return `Reopened ${t.id} "${t.title}".`;
    }),
);

server.registerTool(
  "rename_thread",
  {
    description: "Change a thread's title and/or goal (default: the bound one).",
    inputSchema: { title: z.string().optional(), goal: z.string().optional(), thread_id: z.string().optional() },
  },
  ({ title, goal, thread_id }) =>
    run(() => {
      return fmt.formatRename(store.renameThread(thread_id ?? store.current().id, title, goal), goal !== undefined);
    }),
);

server.registerTool(
  "unlink",
  {
    description: "Remove one link from a thread (default: the bound one), given as kind:value exactly as link prints it, e.g. a stale repo URL.",
    inputSchema: { link: z.string(), thread_id: z.string().optional() },
  },
  ({ link, thread_id }) =>
    run(() => {
      return fmt.formatUnlink(store.unlink(thread_id, link));
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
      return fmt.formatRelink(store.relink(thread_id, prune));
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
  ({ items }) => run(() => store.add(items).map(fmt.line).join("\n")),
);

server.registerTool(
  "start",
  {
    description: "Mark a node active (the one you're working on now). Refuses if it is blocked. Demotes any other active node to open.",
    inputSchema: { id: z.string() },
  },
  ({ id }) =>
    run(() => {
      return fmt.formatStart(store.start(id));
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
      return fmt.formatDone(store.done(id, summary, refs), doneHint);
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
      return fmt.formatFinding(store.recordFinding(id, text, confidence, sources, answers ?? false), doneHint);
    }),
);

server.registerTool(
  "update",
  {
    description:
      "Edit a node's title/body/priority/kind, move it (parent: a node id, or \"none\" for top level), or change status to open, blocked, or abandoned (abandoning needs a summary saying why). Use start/done for active/done.",
    inputSchema: {
      id: z.string(),
      title: z.string().optional(),
      body: z.string().optional(),
      status: z.enum(["open", "blocked", "abandoned"]).optional(),
      priority: z.number().int().optional(),
      summary: z.string().optional(),
      kind: kind.optional(),
      parent: z.string().optional(),
    },
  },
  ({ id, parent, ...fields }) =>
    run(() => {
      return fmt.formatUpdate(store.update(id, { ...fields, parent: parent === "none" ? null : parent }));
    }),
);

server.registerTool(
  "edge",
  {
    description:
      "Add (or with remove, delete) an edge between nodes. from blocks to: to can't start until from is resolved (same thread, no cycles). from derived_from to / from contradicts to: record how findings relate (may cross threads). Removing a node's last blocker reopens it.",
    inputSchema: {
      from: z.string(),
      type: z.enum(["blocks", "derived_from", "contradicts"]),
      to: z.string(),
      remove: z.boolean().default(false),
    },
  },
  ({ from, type, to, remove }) =>
    run(() => {
      if (remove) return fmt.formatEdge(from, type, to, true, store.removeEdge(from, type, to).unblocked);
      store.addEdge(from, type, to);
      return fmt.formatEdge(from, type, to, false);
    }),
);

server.registerTool(
  "delete_node",
  {
    description:
      "Delete a node added by mistake. Only leaves with no edges; abandon (update status) anything with history instead.",
    inputSchema: { id: z.string() },
  },
  ({ id }) =>
    run(() => {
      const n = store.deleteNode(id);
      return `Deleted ${n.id} "${n.title}".`;
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
      return fmt.formatNext(store.nextOptions(n));
    }),
);

server.registerTool(
  "log",
  {
    description: "Recent history of the bound thread, newest first: checkpoint notes and done/abandoned nodes with their summaries.",
    inputSchema: { n: z.number().int().min(1).max(100).default(10) },
  },
  ({ n }) => run(() => fmt.formatLog(store.log(n))),
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
  return fmt.formatSearch(store.search(query, opts), opts.all);
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
