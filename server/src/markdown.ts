import type { AddItem } from "./store.ts";

/**
 * Turn a markdown plan into add() items. Headings and list items become
 * tasks, nested by heading level then list indentation; other text becomes
 * the body of the item above it. Checked items (`- [x]`) and their
 * sub-items are skipped. A lone top-level heading that opens the document is
 * the plan's title, so it is dropped. Fenced code is kept verbatim in bodies.
 */
export function planItems(md: string, parent?: string): { items: AddItem[]; skipped: number } {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let inFence = false;
  const headings: number[] = [];
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    else if (!inFence) {
      const d = /^(#{1,6})\s+\S/.exec(l)?.[1].length;
      if (d) headings.push(d);
    }
  }
  const top = Math.min(...headings);
  const lead = /^(#{1,6})\s/.exec(lines.find((l) => l.trim()) ?? "")?.[1].length;
  const dropTitle = lead === top && headings.filter((d) => d === top).length === 1;

  const items: AddItem[] = [];
  // Open ancestors: depth is heading level (1-6) or 10 + list indent for list items.
  const stack: { depth: number; ref: string | undefined; skip: boolean }[] = [];
  let body: string[] | null = null;
  let skipped = 0;
  let fence: string | null = null;
  const flush = () => {
    if (body && items.length) {
      const text = body.join("\n").trim();
      if (text) items[items.length - 1].body = text;
    }
    body = null;
  };
  const open = (depth: number, title: string, skip: boolean) => {
    flush();
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const up = stack[stack.length - 1];
    if (skip || up?.skip) {
      skipped++;
      stack.push({ depth, ref: undefined, skip: true });
      return;
    }
    items.push({ title: clean(title), ...((up?.ref ?? parent) ? { parent: up?.ref ?? parent } : {}) });
    stack.push({ depth, ref: `#${items.length}`, skip: false });
    body = [];
  };

  let first = true;
  for (const l of lines) {
    if (fence) {
      if (l.trimStart().startsWith(fence)) fence = null;
      (body as string[] | null)?.push(l);
      continue;
    }
    const f = /^\s*(```|~~~)/.exec(l);
    if (f) {
      fence = f[1];
      (body as string[] | null)?.push(l);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      if (first && dropTitle) {
        first = false;
        flush();
        continue;
      }
      first = false;
      open(h[1].length, h[2], false);
      continue;
    }
    const li = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*\S)/.exec(l);
    if (li) {
      first = false;
      open(10 + li[1].replace(/\t/g, "    ").length, li[3], li[2] === "x" || li[2] === "X");
      continue;
    }
    if (l.trim()) first = false;
    (body as string[] | null)?.push(l.replace(/^\s+/, ""));
  }
  flush();
  return { items, skipped };
}

/** Strip emphasis/code markers that read as noise in a node title. */
function clean(title: string): string {
  return title.replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/`([^`]+)`/g, "$1").trim();
}
