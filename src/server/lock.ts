import fs from "node:fs";
import path from "node:path";
import { Refusal } from "./errors.js";
import type { Galaxy } from "./galaxy.js";

/** True when a process with this pid exists. EPERM means it exists but belongs to someone else. */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

const LOCK_EXCLUDE = ".nexus/server.json";

/** Keep server.json out of `git status` before it is first written (mirrors the worktrees line in initGalaxy). */
function excludeLockFile(repoRoot: string): void {
  if (!fs.existsSync(path.join(repoRoot, ".git"))) return;
  const exclude = path.join(repoRoot, ".git", "info", "exclude");
  let text = ""; try { text = fs.readFileSync(exclude, "utf8"); } catch { /* none yet */ }
  if (text.split(/\r?\n/).includes(LOCK_EXCLUDE)) return;
  fs.mkdirSync(path.dirname(exclude), { recursive: true });
  fs.writeFileSync(exclude, text + (text === "" || text.endsWith("\n") ? "" : "\n") + LOCK_EXCLUDE + "\n");
}

export type ServerLock = { release(): void; setPort(port: number): void };

/** One server per galaxy. A live pid in .nexus/server.json refuses; a dead pid's file is replaced. */
export function acquireServerLock(g: Galaxy, info: { port: number }): ServerLock {
  const file = path.join(g.paths.nexusDir, "server.json");
  excludeLockFile(g.repoRoot);
  fs.mkdirSync(g.paths.nexusDir, { recursive: true });
  const record = (port: number) => JSON.stringify({ pid: process.pid, port, started: new Date().toISOString() }) + "\n";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, record(info.port), { flag: "wx" }); // atomic create: two racing starters cannot both win
      return {
        setPort: (port) => fs.writeFileSync(file, record(port)),
        release: () => {
          try {
            const held = JSON.parse(fs.readFileSync(file, "utf8")) as { pid?: number };
            if (held.pid === process.pid) fs.rmSync(file, { force: true });
          } catch { /* already gone */ }
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let held: { pid?: unknown; port?: unknown } = {};
    try { held = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* unreadable or half-written: treat as stale */ }
    if (typeof held.pid === "number" && pidAlive(held.pid)) {
      throw new Refusal(`a server for this galaxy is already running (pid ${held.pid}, port ${String(held.port)})`);
    }
    fs.rmSync(file, { force: true });
  }
  throw new Refusal("could not acquire .nexus/server.json (another server is starting)");
}
