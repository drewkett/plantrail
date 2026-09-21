import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db.ts";
import { exportHtml } from "../src/html.ts";
import { serve } from "../src/serve.ts";
import { Store } from "../src/store.ts";

test("html export escapes script-breaking text", () => {
  const store = new Store(openDb(":memory:"), mkdtempSync(join(tmpdir(), "autoplan-test-")));
  store.createThread("A <b>&</b>", "g");
  store.add([{ title: "</script><script>alert(1)</script>" }]);
  const html = exportHtml(store.exportData());
  assert.match(html, /<title>A &#60;b&#62;&#38;&#60;\/b&#62; \(t1\)<\/title>/);
  assert.equal(html.match(/<\/script>/g)?.length, 1);
});

test("serve: index, thread page, version changes on edit, 404s", async () => {
  const store = new Store(openDb(":memory:"), mkdtempSync(join(tmpdir(), "autoplan-test-")));
  store.createThread("Demo", "ship it");
  store.add([{ title: "a", blocks: ["#1"] }, { title: "b" }]);
  const srv = serve(store, 0);
  await once(srv, "listening");
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const get = async (p: string) => {
    const r = await fetch(base + p);
    return { code: r.status, text: await r.text() };
  };
  try {
    assert.match((await get("/")).text, /<a href="\/t\/t1">t1 Demo<\/a> <b>\(bound\)<\/b>/);
    const page = await get("/t/t1");
    assert.equal(page.code, 200);
    assert.match(page.text, /const LOC=\["[^"]+"\]/);
    assert.match(page.text, /fetch\("\/v\/t1"\)/);
    const v1 = (await get("/v/t1")).text;
    assert.equal((await get("/v/t1")).text, v1);
    store.start("n1");
    assert.notEqual((await get("/v/t1")).text, v1);
    assert.equal(JSON.parse((await get("/api/t1")).text).nodes.length, 2);
    assert.equal((await get("/t/t9")).code, 404);
    assert.equal((await get("/nope")).code, 404);
  } finally {
    srv.close();
  }
});
