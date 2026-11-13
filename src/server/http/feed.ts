import http from "node:http";
import { rowToEvent, type EventRow } from "../../db/events.js";
import type { Row } from "../../db/open.js";
import { followEvents } from "../follow.js";
import type { Galaxy } from "../galaxy.js";

export type Feed = {
  handle(req: http.IncomingMessage, res: http.ServerResponse, query: URLSearchParams): void;
  notify(): void;
  close(): void;
};

type Client = { res: http.ServerResponse; lastId: number; lastWrite: number };

function parseCursor(value: string | string[]): number | undefined {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

function badCursor(res: http.ServerResponse): void {
  const body = JSON.stringify({ error: "cursor must be a non-negative integer" });
  res.writeHead(400, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

export function createFeed(g: Galaxy, opts: { pollMs: number; heartbeatMs?: number }): Feed {
  const clients = new Set<Client>();
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  let closed = false;

  const drop = (client: Client): void => { clients.delete(client); };
  const write = (client: Client, text: string): void => {
    if (client.res.destroyed || client.res.writableEnded) return drop(client);
    try {
      client.res.write(text);
      client.lastWrite = Date.now();
    } catch {
      drop(client);
      try { client.res.destroy(); } catch { /* already unusable */ }
    }
  };
  const sendRows = (client: Client, rows: EventRow[]): void => {
    for (const row of rows) {
      if (row.id <= client.lastId) continue;
      write(client, `id: ${row.id}\ndata: ${JSON.stringify(row)}\n\n`);
      if (!clients.has(client) && client.res.destroyed) return;
      client.lastId = row.id;
    }
  };

  const start = g.db.get<{ id: number }>("events.maxId")?.id ?? 0;
  const follower = followEvents(g.db, {
    since: start,
    pollMs: opts.pollMs,
    onEvents: (rows) => {
      for (const client of [...clients]) sendRows(client, rows);
    },
  });
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const client of [...clients]) if (now - client.lastWrite >= heartbeatMs) write(client, ": hb\n\n");
  }, heartbeatMs);
  heartbeat.unref();

  return {
    handle(req, res, query) {
      if (closed) { res.end(); return; }
      const header = req.headers["last-event-id"];
      let cursor: number;
      if (header !== undefined) {
        const parsed = parseCursor(header);
        if (parsed === undefined) return badCursor(res);
        cursor = parsed;
      } else if (query.has("since")) {
        const parsed = parseCursor(query.get("since") ?? "");
        if (parsed === undefined) return badCursor(res);
        cursor = parsed;
      } else {
        cursor = g.db.get<{ id: number }>("events.maxId")?.id ?? 0;
      }

      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" });
      res.flushHeaders();
      const client: Client = { res, lastId: cursor, lastWrite: Date.now() };
      const remove = (): void => drop(client);
      res.on("close", remove);
      res.on("error", remove);
      for (;;) {
        const rows = g.db.all<Row>("events.page", { id: client.lastId, limit: 500 }).map(rowToEvent);
        if (rows.length === 0) break;
        sendRows(client, rows);
        if (rows.length < 500) break;
      }
      if (!res.destroyed && !res.writableEnded) clients.add(client);
    },
    notify() {
      if (closed) return;
      for (const client of [...clients]) write(client, "event: server\ndata: {}\n\n");
    },
    close() {
      if (closed) return;
      closed = true;
      follower.stop();
      clearInterval(heartbeat);
      for (const client of [...clients]) {
        drop(client);
        try { client.res.end(); } catch { try { client.res.destroy(); } catch { /* already closed */ } }
      }
    },
  };
}
