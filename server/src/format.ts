// Result formatting for the CLI. `doneHint` renders the "complete the parent"
// suggestion in the caller's syntax.
import type { LinkKey } from "./repo.ts";
import type { AddItem, LogEntry, Node, OpEntry, Option, SearchHit, Thread } from "./store.ts";

export type DoneHint = (id: string) => string;
type Closed = { node: Node; unblocked: Node[]; parentReady: Node | null };

export const line = (n: Node) => `${n.id} [${n.kind}/${n.status}] ${n.title}`;

const lines = (xs: (string | number | null | false | undefined)[]) => xs.filter(Boolean).join("\n");
const keys = (ks: LinkKey[]) => ks.map((k) => `${k.kind}:${k.value}`).join(", ");
const unblockedLine = (ns: Node[]) => ns.length && `Unblocked: ${ns.map(line).join("; ")}`;
const readyLine = (p: Node | null, hint: DoneHint) =>
  p && `All children of ${p.id} "${p.title}" are resolved — consider: ${hint(p.id)}`;

export function formatThreads(ts: Thread[], bound: string | null, empty = "No threads."): string {
  if (!ts.length) return empty;
  return ts.map((t) => `${t.id}${t.id === bound ? "*" : ""} [${t.status}] ${t.title} (touched ${t.touched_at.slice(0, 10)})`).join("\n");
}

export function formatRename(t: Thread, goalChanged: boolean): string {
  return `Updated ${t.id} "${t.title}"${goalChanged ? ` — goal: ${t.goal}` : ""}.`;
}

export function formatRelink(r: { added: LinkKey[]; removed: LinkKey[]; links: LinkKey[] }): string {
  return lines([r.added.length && `Added: ${keys(r.added)}`, r.removed.length && `Removed: ${keys(r.removed)}`, `Links: ${keys(r.links) || "(none)"}`]);
}

export function formatUnlink(r: { removed: LinkKey; links: LinkKey[] }): string {
  return lines([`Removed: ${keys([r.removed])}`, `Links: ${keys(r.links) || "(none)"}`]);
}

export function formatStart(r: { node: Node; demoted: string[] }): string {
  return lines([`Started ${line(r.node)}`, r.demoted.length && `Returned to open: ${r.demoted.join(", ")}`]);
}

export function formatDone(r: Closed, hint: DoneHint, verb = "Done"): string {
  return lines([`${verb} ${line(r.node)}`, unblockedLine(r.unblocked), readyLine(r.parentReady, hint)]);
}

export function formatFinding(r: { node: Node; closed: Closed | null }, hint: DoneHint): string {
  const n = r.node;
  return lines([
    `Recorded ${line(n)}${n.confidence != null ? ` (conf ${n.confidence})` : ""} under ${n.parent_id}`,
    r.closed && formatDone(r.closed, hint, "Answered"),
  ]);
}

export function formatUpdate(r: { node: Node; unblocked: Node[] }): string {
  return lines([`Updated ${line(r.node)}`, unblockedLine(r.unblocked)]);
}

export function formatNext(opts: Option[]): string {
  if (!opts.length) return "Nothing open and unblocked.";
  return opts
    .map((o) => `${line(o.node)}${o.thread_title != null ? ` (${o.node.thread_id} "${o.thread_title}")` : ""}  (score ${o.score}: ${o.why})`)
    .join("\n");
}

/** Imported items as an indented tree: the created nodes, or just titles for a dry run. */
export function formatImport(items: AddItem[], nodes: Node[] | null): string {
  const depth: number[] = [];
  return items
    .map((it, i) => {
      const m = /^#(\d+)$/.exec(it.parent ?? "");
      depth[i] = m ? depth[Number(m[1]) - 1] + 1 : 0;
      return "  ".repeat(depth[i]) + (nodes ? line(nodes[i]) : it.title);
    })
    .join("\n");
}

export function formatSearch(hits: SearchHit[], all?: boolean): string {
  if (!hits.length) return "No matches.";
  return hits
    .map((h) => `${line(h.node)}${all ? ` (${h.node.thread_id} "${h.thread_title}")` : ""}\n    ${h.snippet.replace(/\s+/g, " ")}`)
    .join("\n");
}

export function formatFinish(r: { thread: Thread; open: number }): string {
  const left = r.open ? ` (${r.open} node${r.open === 1 ? "" : "s"} still open)` : "";
  return `Finished ${r.thread.id} "${r.thread.title}"${left}. \`plantrail reopen ${r.thread.id}\` reactivates it.`;
}

export function formatEdge(from: string, type: string, to: string, removed: boolean, unblocked: Node[] = []): string {
  return lines([`${removed ? "Removed" : "Added"} ${from} ${type} ${to}.`, unblockedLine(unblocked)]);
}

export function formatLog(es: LogEntry[]): string {
  if (!es.length) return "No checkpoints or resolved nodes yet.";
  return es
    .map((e) => {
      const at = e.at.slice(0, 16);
      if (e.node) return `${at} ${e.node.status} ${e.node.id} ${e.node.title}${e.node.summary ? ` — ${e.node.summary.replace(/\n+/g, " ")}` : ""}`;
      return `${at} checkpoint: ${e.checkpoint.replace(/\n+/g, " ")}`;
    })
    .join("\n");
}

function opHead(o: OpEntry): string {
  const tag = o.undoes != null ? ` (undid op ${o.undoes})` : o.undone_by != null ? ` [undone by op ${o.undone_by}]` : "";
  return `op ${o.id} ${o.at.slice(0, 16)} ${o.label ?? "(no label)"}${tag}`;
}

export function formatHistory(ops: OpEntry[]): string {
  if (!ops.length) return "No recorded changes yet.";
  return ops.map((o) => [opHead(o), ...o.changes.map((c) => `  ${c}`)].join("\n")).join("\n");
}

export function formatUndo(o: OpEntry, dryRun: boolean): string {
  return [`${dryRun ? "Would undo" : "Undid"} ${opHead(o)}`, ...o.changes.map((c) => `  ${c}`)].join("\n");
}
