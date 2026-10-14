import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type NexusConfig } from "../config/schema.js";
import { openDb, type NexusDb } from "../db/open.js";
import { Git } from "../core/git.js";
import { buildAdapters } from "../providers/index.js";
import type { ProviderAdapter } from "../providers/adapter.js";
import { Refusal } from "./errors.js";

export type Galaxy = {
  repoRoot: string; config: NexusConfig; db: NexusDb; git: Git; adapters: Record<string, ProviderAdapter>;
  paths: { nexusDir: string; dbFile: string; stateDir: string; worktrees: string; specs: string; plans: string };
  close(): void;
};

export function galaxyPaths(repoRoot: string, config?: NexusConfig): Galaxy["paths"] {
  const nexusDir = path.join(repoRoot, ".nexus");
  return {
    nexusDir, dbFile: path.join(nexusDir, "nexus.db"), stateDir: path.join(nexusDir, "state"), worktrees: path.join(nexusDir, "worktrees"),
    specs: path.join(repoRoot, config?.pipeline.tasks_dir ?? ".nexus/specs"), plans: path.join(repoRoot, config?.pipeline.plans_dir ?? ".nexus/plans"),
  };
}

function defaultScriptsDir(repoRoot: string): string {
  const env = process.env["NEXUS_FAKE_SCRIPTS"];
  if (env) return path.resolve(env);
  const local = path.join(repoRoot, ".nexus", "fake-scripts");
  if (fs.existsSync(local)) return local;
  // dist/server/galaxy.js -> <package>/tests/fixtures/scripts
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "tests", "fixtures", "scripts");
}

export function openGalaxy(repoRoot: string, opts: { scriptsDir?: string } = {}): Galaxy {
  if (!fs.existsSync(path.join(repoRoot, ".nexus", "config.json"))) throw new Refusal(".nexus/config.json not found — run 'nexus init' first");
  let config: NexusConfig;
  try { config = loadConfig(repoRoot); } catch (err) { throw new Refusal((err as Error).message); }
  const paths = galaxyPaths(repoRoot, config);
  const db = openDb(paths.dbFile, { stats: config.db.stats });
  const git = new Git(repoRoot, { log: () => {} }); // Task 12 wires git logging into voyage.event
  const adapters = buildAdapters(config, { scriptsDir: opts.scriptsDir ?? defaultScriptsDir(repoRoot) });
  return { repoRoot, config, db, git, adapters, paths, close: () => db.close() };
}
