import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";
import { acquireServerLock } from "../lock.js";
import { moonDetail, snapshot } from "../commands/query.js";
import { COOKIE_NAME, checkRequest, isApiPath, rawPath, tokenMatches } from "./auth.js";
import { createFeed, type Feed } from "./feed.js";
import { BadRequest, errorResponse, runCommand } from "./commands.js";
import { createVoyageRunner, type VoyageRunner } from "./runner.js";
import { createScheduler } from "../scheduler/loop.js";
import { plan } from "../scheduler/plan.js";

export { checkRequest } from "./auth.js";

export type NexusServer = { port: number; token: string; url: string; close(): Promise<void> };
export type ApiContext = { g: Galaxy; req: http.IncomingMessage; res: http.ServerResponse; query: URLSearchParams; feed: Feed; runner: VoyageRunner };
export type ApiHandler = (ctx: ApiContext) => void | Promise<void>;

export function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
}
function sendText(res: http.ServerResponse, status: number, text: string, extra: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(text), ...extra });
  res.end(text);
}

/**
 * The one place API routes are registered, keyed "METHOD /api/path". Requests reach this table only
 * through the dispatcher below, after checkRequest, so a route here cannot skip the access checks.
 */
const API_ROUTES: Record<string, ApiHandler> = {
  "GET /api/ping": ({ res }) => sendJson(res, 200, { ok: true }),
  "GET /api/snapshot": ({ g, res, runner }) => {
    const owner = { ownPid: process.pid, tracks: (id: string) => runner.tracks(id) };
    // What raising the rung to roundabout would start right now, whatever the rung is.
    // If planning fails the scheduler's own pass shows the notice; the page must still load.
    let readyToSend = 0;
    try { readyToSend = plan(g, { ...owner, rung: "roundabout" }).filter((a) => a.action === "send" && a.first).length; } catch { /* reported by the scheduler */ }
    sendJson(res, 200, snapshot(g, { ...owner, failures: runner.failures(), readyToSend }));
  },
  "GET /api/events": ({ req, res, query, feed }) => feed.handle(req, res, query),
};
type PrefixApiHandler = (ctx: ApiContext, remainder: string) => void | Promise<void>;
const API_PREFIX_ROUTES: Record<string, PrefixApiHandler> = {
  "GET /api/moons/": ({ g, res, runner }, taskId) => {
    try { sendJson(res, 200, moonDetail(g, taskId, { ownPid: process.pid, tracks: (id) => runner.tracks(id) })); }
    catch (e) { if (e instanceof Refusal) return sendJson(res, 404, { error: e.message }); throw e; }
  },
  "POST /api/commands/": async ({ g, req, res, runner }, name) => {
    const contentType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== "application/json") return sendJson(res, 415, { error: "content-type must be application/json" });
    try {
      const read = await readJsonBody(req);
      if (read.tooLarge) return sendJson(res, 413, { error: "request body is too large" });
      const outcome = await runCommand(g, runner, name, read.body);
      sendJson(res, outcome.status, outcome.body);
    } catch (e) {
      const response = errorResponse(e);
      sendJson(res, response.status, response.body);
    }
  },
};

const MAX_COMMAND_BODY = 1024 * 1024;
/** How much of an oversized body is read and thrown away so the client can finish sending before the 413. */
const MAX_DISCARDED_BODY = 16 * MAX_COMMAND_BODY;
async function readJsonBody(req: http.IncomingMessage): Promise<{ tooLarge: true } | { tooLarge: false; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_COMMAND_BODY) { chunks.push(chunk); return; }
      // Too large: stop buffering but keep reading to the end before answering. Answering while the client is
      // still sending closes the connection under its writes, and it sees a reset instead of the 413.
      chunks.length = 0;
      if (size > MAX_DISCARDED_BODY) {
        // Not worth reading further: answer now and discard whatever else arrives.
        req.off("data", onData);
        req.on("data", () => { /* discard the remainder without buffering it */ });
        req.resume();
        resolve({ tooLarge: true });
      }
    };
    req.on("data", onData);
    req.once("end", () => {
      if (size > MAX_COMMAND_BODY) return resolve({ tooLarge: true });
      try { resolve({ tooLarge: false, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }); }
      catch { reject(new BadRequest("body is not valid JSON")); }
    });
    req.once("error", reject);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
};

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, webRoot: string, pathname: string): void {
  if (req.method !== "GET" && req.method !== "HEAD") return sendText(res, 405, "method not allowed", { allow: "GET, HEAD" });
  let rel: string;
  try { rel = decodeURIComponent(pathname); } catch { return sendText(res, 400, "bad request"); }
  if (rel.includes("\0") || rel.includes("\\")) return sendText(res, 403, "forbidden");
  const isRoot = rel === "/";
  const root = path.resolve(webRoot);
  const target = path.resolve(root, "." + (isRoot ? "/index.html" : rel));
  if (!inside(root, target)) return sendText(res, 403, "forbidden");
  let real: string;
  try {
    real = fs.realpathSync(target);
    if (!inside(fs.realpathSync(root), real)) return sendText(res, 403, "forbidden"); // symlink out of webRoot
    if (!fs.statSync(real).isFile()) throw new Error("not a file");
  } catch {
    if (isRoot) return sendText(res, 503, "the page is not built — run npm run build");
    return sendText(res, 404, "not found");
  }
  const body = fs.readFileSync(real);
  res.writeHead(200, { "content-type": MIME[path.extname(real).toLowerCase()] ?? "application/octet-stream", "content-length": body.length });
  res.end(req.method === "HEAD" ? undefined : body);
}

export async function startServer(g: Galaxy, opts: { port?: number; token?: string; webRoot?: string; pollMs?: number; schedulerTickMs?: number } = {}): Promise<NexusServer> {
  const wantPort = opts.port ?? g.config.server.port;
  const token = opts.token ?? crypto.randomBytes(32).toString("hex");
  const webRoot = opts.webRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
  const lock = acquireServerLock(g, { port: wantPort });
  const state = { port: wantPort, token };
  const feed = createFeed(g, { pollMs: opts.pollMs ?? 250 });
  const runner = createVoyageRunner({ onFailure: () => feed.notify() });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const gate = checkRequest(req, state);
    if (!gate.ok) return sendJson(res, gate.status, { error: gate.message });
    const pathname = rawPath(req.url);
    const query = new URLSearchParams(req.url?.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "");
    if (isApiPath(pathname)) {
      const key = `${req.method} ${pathname}`;
      const handler = Object.hasOwn(API_ROUTES, key) ? API_ROUTES[key] : undefined;
      if (handler) return await handler({ g, req, res, query, feed, runner });
      for (const prefixKey of Object.keys(API_PREFIX_ROUTES)) {
        if (!key.startsWith(prefixKey) || !Object.hasOwn(API_PREFIX_ROUTES, prefixKey)) continue;
        const raw = key.slice(prefixKey.length);
        let remainder: string;
        try { remainder = decodeURIComponent(raw); } catch { return sendJson(res, 404, { error: "not found" }); }
        if (!remainder || remainder.includes("/")) return sendJson(res, 404, { error: "not found" });
        return await API_PREFIX_ROUTES[prefixKey]!({ g, req, res, query, feed, runner }, remainder);
      }
      return sendJson(res, 404, { error: "not found" });
    }
    if (pathname === "/" && req.method === "GET" && query.has("token")) {
      if (!tokenMatches(query.get("token") ?? "", token)) return sendJson(res, 403, { error: "invalid token" });
      res.writeHead(302, { location: "/", "set-cookie": `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`, "cache-control": "no-store" });
      return void res.end();
    }
    serveStatic(req, res, webRoot, pathname);
  }

  const server = http.createServer((req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    handle(req, res).catch((e) => { console.error(e); if (!res.headersSent) sendJson(res, 500, { error: "internal error" }); else res.destroy(); });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: wantPort, host: "127.0.0.1", exclusive: true }, () => { server.off("error", reject); resolve(); });
    });
  } catch (e) {
    feed.close();
    lock.release();
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Refusal(`port ${wantPort} is in use — pass --port or set server.port in .nexus/config.json`);
    throw e;
  }
  const port = (server.address() as { port: number }).port;
  state.port = port;
  if (port !== wantPort) lock.setPort(port);

  const scheduler = createScheduler(g, { runner, pollMs: opts.pollMs ?? 250, tickMs: opts.schedulerTickMs ?? 5000 });
  scheduler.wake();

  let closing: Promise<void> | undefined;
  return {
    port, token, url: `http://127.0.0.1:${port}/?token=${token}`,
    close: () => closing ??= (async () => {
      // The scheduler first, so nothing new is started while the voyages in flight are being interrupted.
      await scheduler.stop();
      await runner.abortAll();
      feed.close();
      await new Promise<void>((resolve) => {
        server.close(() => { lock.release(); resolve(); });
        server.closeAllConnections();
      });
    })(),
  };
}
