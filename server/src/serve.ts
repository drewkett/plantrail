import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { exportHtml, indexHtml, locations } from "./html.ts";
import { PlantrailError, type Store } from "./store.ts";

/** Change token for a thread: hash of its export minus the timestamp. */
function version(store: Store, id: string): string {
  const { exported_at: _, ...rest } = store.exportData(id);
  return createHash("sha1").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

/** Read-only local web view of threads; pages poll /v/tN and reload on change. */
export function serve(store: Store, port: number, host = "127.0.0.1"): Server {
  const server = createServer((req, res) => {
    const send = (code: number, type: string, body: string) => {
      res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
      res.end(body);
    };
    try {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      let m: RegExpMatchArray | null;
      if (req.method !== "GET") return send(405, "text/plain", "GET only\n");
      if (path === "/") {
        let bound: string | null = null;
        try {
          bound = store.current().id;
        } catch {}
        return send(200, "text/html", indexHtml(store.listThreads("all").map((t) => ({ ...t, locations: locations(store.exportData(t.id).links) })), bound));
      }
      if ((m = path.match(/^\/t\/(t\d+)$/))) {
        const x = store.exportData(m[1]);
        return send(200, "text/html", exportHtml(x, { poll: `/v/${m[1]}`, version: version(store, m[1]) }));
      }
      if ((m = path.match(/^\/v\/(t\d+)$/))) return send(200, "text/plain", version(store, m[1]));
      if ((m = path.match(/^\/api\/(t\d+)$/))) return send(200, "application/json", JSON.stringify(store.exportData(m[1])));
      return send(404, "text/plain", "not found\n");
    } catch (e) {
      if (e instanceof PlantrailError) return send(404, "text/plain", e.message + "\n");
      return send(500, "text/plain", String(e) + "\n");
    }
  });
  server.listen(port, host);
  return server;
}
