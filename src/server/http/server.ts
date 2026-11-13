import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";
import { acquireServerLock } from "../lock.js";
import { COOKIE_NAME, checkRequest, isApiPath, rawPath, tokenMatches } from "./auth.js";

export { checkRequest } from "./auth.js";

export type NexusServer = { port: number; token: string; url: string; close(): Promise<void> };
export type ApiContext = { g: Galaxy; req: http.IncomingMessage; res: http.ServerResponse; query: URLSearchParams };
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
};

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

export async function startServer(g: Galaxy, opts: { port?: number; token?: string; webRoot?: string; pollMs?: number } = {}): Promise<NexusServer> {
  const wantPort = opts.port ?? g.config.server.port;
  const token = opts.token ?? crypto.randomBytes(32).toString("hex");
  const webRoot = opts.webRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
  const lock = acquireServerLock(g, { port: wantPort });
  const state = { port: wantPort, token };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const gate = checkRequest(req, state);
    if (!gate.ok) return sendJson(res, gate.status, { error: gate.message });
    const pathname = rawPath(req.url);
    const query = new URL(pathname + (req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""), "http://127.0.0.1").searchParams;
    if (isApiPath(pathname)) {
      const key = `${req.method} ${pathname}`;
      const handler = Object.hasOwn(API_ROUTES, key) ? API_ROUTES[key] : undefined;
      if (!handler) return sendJson(res, 404, { error: "not found" });
      return await handler({ g, req, res, query });
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
    handle(req, res).catch((e) => { if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message }); else res.destroy(); });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ port: wantPort, host: "127.0.0.1", exclusive: true }, () => { server.off("error", reject); resolve(); });
    });
  } catch (e) {
    lock.release();
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") throw new Refusal(`port ${wantPort} is in use — pass --port or set server.port in .nexus/config.json`);
    throw e;
  }
  const port = (server.address() as { port: number }).port;
  state.port = port;
  if (port !== wantPort) lock.setPort(port);

  let closing: Promise<void> | undefined;
  return {
    port, token, url: `http://127.0.0.1:${port}/?token=${token}`,
    close: () => closing ??= new Promise<void>((resolve) => {
      server.close(() => { lock.release(); resolve(); });
      server.closeAllConnections();
    }),
  };
}
