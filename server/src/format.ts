// Result formatting shared by the CLI and the MCP server. `doneHint` renders
// the "complete the parent" suggestion in each front end's own syntax.
import type { LinkKey } from "./repo.ts";
import type { Node, Option, SearchHit, Thread } from "./store.ts";

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
  return opts.map((o) => `${line(o.node)}  (score ${o.score}: ${o.why})`).join("\n");
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
