// Shared test helpers. Zero dependencies. Temp dirs are tracked and removed on process exit.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8").replaceAll("\r\n", "\n");
}

const tempDirs = new Set();
process.on("exit", () => { for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} } });
function trackedTmp(prefix) { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix))); tempDirs.add(d); return d; }

export const tmpDb = () => path.join(trackedTmp("nexus-db-"), "nexus.db");

export function makeRepo() {
  const dir = fs.realpathSync.native(trackedTmp("nexus-repo-"));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trimEnd();
  git("init", "-q", "-b", "main"); git("config", "core.autocrlf", "false"); git("config", "user.email", "fixture@example.com"); git("config", "user.name", "fixture");
  fs.mkdirSync(path.join(dir, "src", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "lib", "thing.js"), "export const thing = 1;\n");
  fs.writeFileSync(path.join(dir, "src", "auth.ts"), "export const guard = true;\n");
  fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n");
  git("add", "-A"); git("commit", "-qm", "fixture baseline");
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  return { dir, git, cleanup, write: (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); } };
}

export async function makeGalaxy(patchConfig) {
  const repo = makeRepo();
  const { initGalaxy } = await import("../dist/server/commands/init.js");
  const { openGalaxy } = await import("../dist/server/galaxy.js");
  patchConfig ??= (c) => { c.roles = { implement: ["fake"], review: ["fake"] }; c.routing.security_routed = ["src/auth.ts"]; c.routing.do_not_touch = [".env"]; };
  initGalaxy(repo.dir, { patchConfig });
  repo.git("add", "-A"); repo.git("commit", "-qm", "nexus init");
  const g = openGalaxy(repo.dir, { scriptsDir: path.join(repoRoot, "tests", "fixtures", "scripts") });
  return { ...repo, g, cleanup: () => { g.close(); repo.cleanup(); } };
}
export function writeSpec(dir, taskId, body) {
  const text = (body ?? read("tests/fixtures/specs/good-basic.md")).replace("**Task ID**: T1", `**Task ID**: ${taskId}`);
  fs.mkdirSync(path.join(dir, ".nexus", "specs"), { recursive: true }); fs.writeFileSync(path.join(dir, ".nexus", "specs", `${taskId}.md`), text);
  return `.nexus/specs/${taskId}.md`;
}
