import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { worldWithMoon } from "../fixtures/world.mjs";

/** One raw request; resolves { status, headers, text, json }. Pass headers.host to override the Host header. */
export function rawRequest(port, { method = "GET", path: p = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json; try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Open and parse the authenticated server-sent event feed. */
export function readFeed(srv, { since, lastEventId } = {}) {
  const events = [];
  let server = 0;
  let response;
  let buffer = "";
  const waiters = new Set();
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let resolveStatus, rejectStatus;
  const status = new Promise((resolve, reject) => { resolveStatus = resolve; rejectStatus = reject; });

  const check = () => {
    for (const waiter of [...waiters]) {
      let ready = false;
      try { ready = typeof waiter.want === "function" ? waiter.want(events) : events.length >= waiter.want; }
      catch (error) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.reject(error); continue; }
      if (ready) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(); }
    }
  };
  const parse = () => {
    for (;;) {
      const end = buffer.indexOf("\n\n");
      if (end < 0) return;
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      let type = "message", id;
      const data = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trimStart();
        else if (line.startsWith("id:")) id = line.slice(3).trimStart();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (type === "server") server++;
      else if (id !== undefined) events.push(JSON.parse(data.join("\n")));
      check();
    }
  };
  const query = since === undefined ? "" : `?since=${encodeURIComponent(String(since))}`;
  const headers = { cookie: `nexus_token=${srv.token}`, host: `127.0.0.1:${srv.port}` };
  if (lastEventId !== undefined) headers["last-event-id"] = String(lastEventId);
  const req = http.request({ host: "127.0.0.1", port: srv.port, method: "GET", path: `/api/events${query}`, headers, agent: false }, (res) => {
    response = res; resolveStatus(res.statusCode);
    res.setEncoding("utf8");
    res.on("data", (chunk) => { buffer += chunk.replaceAll("\r\n", "\n"); parse(); });
    res.on("end", resolveClosed); res.on("close", resolveClosed);
  });
  req.on("error", (error) => { rejectStatus(error); resolveClosed(); });
  req.end();
  return {
    events,
    get server() { return server; },
    status,
    waitFor(want, ms = 5000) {
      if (typeof want === "function" ? want(events) : events.length >= want) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const waiter = { want, resolve, reject, timer: undefined };
        waiter.timer = setTimeout(() => { waiters.delete(waiter); reject(new Error(`timed out waiting for feed (${events.length} events)`)); }, ms);
        waiters.add(waiter);
      });
    },
    closed,
    close() { response?.destroy(); req.destroy(); },
  };
}

/** A galaxy with a running server on an ephemeral port and an empty webRoot (override via opts.webRoot). */
export async function startWorld(script, patchConfig, opts = {}) {
  const { startServer } = await import("../../dist/server/http/server.js");
  const w = await worldWithMoon(script, patchConfig);
  const ownsWebRoot = opts.webRoot === undefined;
  const webRoot = opts.webRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "nexus-web-"));
  let srv;
  try { srv = await startServer(w.g, { port: 0, webRoot, ...opts.server }); }
  catch (e) { w.cleanup(); if (ownsWebRoot) fs.rmSync(webRoot, { recursive: true, force: true }); throw e; }
  const origin = `http://127.0.0.1:${srv.port}`;
  const api = (p, { method = "GET", body, headers = {} } = {}) => rawRequest(srv.port, {
    method, path: p,
    headers: { cookie: `nexus_token=${srv.token}`, origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try { await srv.close(); } finally { w.cleanup(); if (ownsWebRoot) fs.rmSync(webRoot, { recursive: true, force: true }); }
  };
  return { w, srv, webRoot, origin, api, close };
}
