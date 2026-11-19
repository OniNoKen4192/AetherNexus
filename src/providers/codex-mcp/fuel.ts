import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../adapter.js";

const CHUNK_SIZE = 64 * 1024;

type RateWindow = { used_percent?: unknown; window_minutes?: unknown; resets_at?: unknown };
type RateLimits = { primary?: RateWindow | null; secondary?: RateWindow | null };

export function codexSessionsRoot(env: NodeJS.ProcessEnv): string {
  return join(env.CODEX_HOME ? env.CODEX_HOME : join(homedir(), ".codex"), "sessions");
}

function matchingFiles(root: string, suffix: string): { path: string; mtimeMs: number }[] {
  const matches: { path: string; mtimeMs: number }[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(suffix)) matches.push({ path, mtimeMs: statSync(path).mtimeMs });
    }
  };
  visit(root);
  return matches;
}

function rateLimitsOf(line: string): RateLimits | undefined {
  try {
    const value = JSON.parse(line) as { payload?: { rate_limits?: unknown } };
    const limits = value?.payload?.rate_limits;
    return limits !== null && typeof limits === "object" && !Array.isArray(limits) ? limits as RateLimits : undefined;
  } catch {
    return undefined;
  }
}

function newestSnapshot(path: string): RateLimits | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    let position = statSync(path).size;
    let laterFragment = "";
    while (position > 0) {
      const length = Math.min(CHUNK_SIZE, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const bytes = readSync(fd, buffer, 0, length, position);
      const lines = (buffer.subarray(0, bytes).toString("utf8") + laterFragment).split(/\r?\n/);
      const firstComplete = position === 0 ? 0 : 1;
      for (let i = lines.length - 1; i >= firstComplete; i--) {
        const limits = rateLimitsOf(lines[i]!);
        if (limits) return limits;
      }
      laterFragment = lines[0] ?? "";
    }
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function eventOf(window: RateWindow | null | undefined): AgentEvent | undefined {
  if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) return undefined;
  const minutes = typeof window.window_minutes === "number" && Number.isFinite(window.window_minutes) && window.window_minutes > 0
    ? `${window.window_minutes}m`
    : "unknown";
  const data: Extract<AgentEvent, { kind: "fuel" }>["data"] = {
    window: minutes,
    used: Math.max(0, Math.min(1, window.used_percent / 100)),
  };
  if (typeof window.resets_at === "number" && Number.isFinite(window.resets_at) && window.resets_at > 0) {
    const reset = new Date(window.resets_at * 1000);
    if (Number.isFinite(reset.getTime())) data.resets_at = reset.toISOString();
  }
  return { kind: "fuel", ts: new Date().toISOString(), data };
}

/** Readings from the newest rate_limits snapshot in the session log of `threadId`; [] when there is none or it cannot be read. Never throws. */
export function readCodexFuel(sessionsRoot: string, threadId: string): AgentEvent[] {
  if (!threadId || !/^[A-Za-z0-9_-]+$/.test(threadId)) return [];
  try {
    const files = matchingFiles(sessionsRoot, `-${threadId}.jsonl`);
    const newest = files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
    if (!newest) return [];
    const limits = newestSnapshot(newest.path);
    if (!limits) return [];
    return [eventOf(limits.primary), eventOf(limits.secondary)].filter((event): event is AgentEvent => event !== undefined);
  } catch {
    return [];
  }
}
