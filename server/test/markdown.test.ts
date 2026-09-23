import { test } from "node:test";
import assert from "node:assert/strict";
import { planItems } from "../src/markdown.ts";

test("planItems: headings and lists nest, text becomes body, title and checked items dropped", () => {
  const md = [
    "# Plan: ship it",
    "Intro text.",
    "",
    "## Phase 1: **schema**",
    "Why this first.",
    "",
    "1. Add `users` table",
    "   - index on email",
    "     keep it unique",
    "2. [x] Already done",
    "   - also done",
    "",
    "## Phase 2",
    "```sh",
    "# not a heading",
    "  indented",
    "```",
    "- [ ] Wire API",
  ].join("\n");
  const { items, skipped } = planItems(md);
  assert.equal(skipped, 2);
  assert.deepEqual(items, [
    { title: "Phase 1: schema", body: "Why this first." },
    { title: "Add users table", parent: "#1" },
    { title: "index on email", parent: "#2", body: "keep it unique" },
    { title: "Phase 2", body: "```sh\n# not a heading\n  indented\n```" },
    { title: "Wire API", parent: "#4" },
  ]);
});

test("planItems: several top-level headings are all kept; --parent applies to roots", () => {
  const { items } = planItems("# A\n- a1\n# B\n", "n9");
  assert.deepEqual(items, [
    { title: "A", parent: "n9" },
    { title: "a1", parent: "#1" },
    { title: "B", parent: "n9" },
  ]);
  assert.deepEqual(planItems("just prose\n").items, []);
});
