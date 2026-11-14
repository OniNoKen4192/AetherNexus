import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";

export const COOKIE_NAME = "nexus_token";

export type Check = { ok: true } | { ok: false; status: 401 | 403; message: string };

/** Constant-time string equality; a length mismatch is a plain false. */
export function tokenMatches(given: string, token: string): boolean {
  const a = Buffer.from(given), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** The value of the cookie named exactly nexus_token (first one wins), or undefined. */
export function cookieToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Path part of a request target, undecoded. Never lets "//x" be read as a host. */
export function rawPath(target: string | undefined): string {
  const t = target ?? "/";
  const q = t.indexOf("?"); const p = q < 0 ? t : t.slice(0, q);
  return p.startsWith("/") ? p : "/" + p;
}
export const isApiPath = (p: string): boolean => p === "/api" || p.startsWith("/api/");

/**
 * Gate for every request. Host (DNS rebinding) for all; the token cookie for /api/*;
 * an exact same-origin Origin for any method that is not GET/HEAD.
 */
export function checkRequest(req: IncomingMessage, s: { port: number; token: string }): Check {
  const hosts = [`127.0.0.1:${s.port}`, `localhost:${s.port}`];
  if (typeof req.headers.host !== "string" || !hosts.includes(req.headers.host)) return { ok: false, status: 403, message: "forbidden host" };
  if (isApiPath(rawPath(req.url))) {
    const given = cookieToken(req.headers.cookie);
    if (given === undefined || !tokenMatches(given, s.token)) return { ok: false, status: 401, message: "missing or invalid token — open the URL printed by nexus serve" };
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    if (typeof origin !== "string" || !hosts.some((h) => origin === `http://${h}`)) return { ok: false, status: 403, message: "forbidden origin" };
  }
  return { ok: true };
}
