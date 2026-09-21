import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { openDb } from "./db.ts";
import { AutoplanError, Store } from "./store.ts";

const USAGE = `usage: autoplan <command> [options]
  resume [--cwd DIR] [--session ID] [--hook]   bind session to thread for DIR and print status
                                               (--hook: read {cwd, session_id} JSON from stdin)
  status [--cwd DIR] [--thread ID]             print status of thread for DIR (or ID)
  threads [--all]                              list threads`;

function readHookInput(): { cwd?: string; session_id?: string } {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function main(): number {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" },
      session: { type: "string" },
      thread: { type: "string" },
      hook: { type: "boolean" },
      all: { type: "boolean" },
    },
  });
  const [cmd] = positionals;
  let cwd = values.cwd;
  let session = values.session;
  if (values.hook) {
    const input = readHookInput();
    cwd ??= input.cwd;
    session ??= input.session_id;
  }
  const store = new Store(openDb(), cwd ?? process.cwd());
  switch (cmd) {
    case "resume": {
      const text = store.resume(session);
      if (text) console.log(text);
      return 0;
    }
    case "status":
      console.log(store.statusText(values.thread));
      return 0;
    case "threads":
      for (const t of store.listThreads(values.all ? "all" : "active"))
        console.log(`${t.id} [${t.status}] ${t.title} (touched ${t.touched_at.slice(0, 10)})`);
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

try {
  process.exitCode = main();
} catch (e) {
  if (!(e instanceof AutoplanError)) throw e;
  console.error(e.message);
  process.exitCode = 1;
}
