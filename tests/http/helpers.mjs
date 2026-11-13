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

/** A galaxy with a running server on an ephemeral port and an empty webRoot (override via opts.webRoot). */
export async function startWorld(script, patchConfig, opts = {}) {
  const { startServer } = await import("../../dist/server/http/server.js");
  const w = await worldWithMoon(script, patchConfig);
  const webRoot = opts.webRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "nexus-web-"));
  let srv;
  try { srv = await startServer(w.g, { port: 0, webRoot, ...opts.server }); }
  catch (e) { w.cleanup(); fs.rmSync(webRoot, { recursive: true, force: true }); throw e; }
  const origin = `http://127.0.0.1:${srv.port}`;
  const api = (p, { method = "GET", body, headers = {} } = {}) => rawRequest(srv.port, {
    method, path: p,
    headers: { cookie: `nexus_token=${srv.token}`, origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let closed = false;
  const close = async () => {
    if (closed) return; closed = true;
    try { await srv.close(); } finally { w.cleanup(); fs.rmSync(webRoot, { recursive: true, force: true }); }
  };
  return { w, srv, webRoot, origin, api, close };
}
