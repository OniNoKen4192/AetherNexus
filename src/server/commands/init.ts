import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CONFIG, normalizeConfig } from "../../config/schema.js";
import { openDb } from "../../db/open.js";
import { append } from "../../db/events.js";
import { generateFleet } from "../../core/fleet.js";
import { Refusal } from "../errors.js";
import { galaxyPaths } from "../galaxy.js";

export function initGalaxy(repoRoot: string, opts: { force?: boolean; patchConfig?: (config: any) => void } = {}): { configPath: string; dbFile: string; ships: number } {
  const paths = galaxyPaths(repoRoot);
  const configPath = path.join(paths.nexusDir, "config.json");
  if (fs.existsSync(configPath) && !opts.force) throw new Refusal(`already initialized: ${configPath} exists (use --force to overwrite)`);
  fs.mkdirSync(paths.nexusDir, { recursive: true });
  // patchConfig lets callers (tests) start from a non-default config so the roster matches it.
  const initial = structuredClone(DEFAULT_CONFIG);
  opts.patchConfig?.(initial);
  fs.writeFileSync(configPath, JSON.stringify(initial, null, 2) + "\n");
  fs.writeFileSync(path.join(paths.nexusDir, ".gitignore"), "nexus.db*\nworktrees/\nstate/\n");

  if (fs.existsSync(path.join(repoRoot, ".git"))) {
    const exclude = path.join(repoRoot, ".git", "info", "exclude");
    let text = ""; try { text = fs.readFileSync(exclude, "utf8"); } catch { /* none yet */ }
    if (!text.split(/\r?\n/).includes(".nexus/worktrees/")) {
      fs.mkdirSync(path.dirname(exclude), { recursive: true });
      fs.writeFileSync(exclude, text + (text === "" || text.endsWith("\n") ? "" : "\n") + ".nexus/worktrees/\n");
    }
  }

  const config = normalizeConfig(initial);
  const db = openDb(paths.dbFile, { stats: config.db.stats });
  try {
    const have = new Set(db.all("ships.all").map((s) => String(s["id"])));
    const ships = generateFleet(config.fleet.seed ?? 1, config.fleet.name_theme, config.fleet, Object.keys(config.providers));
    for (const ship of ships) {
      if (have.has(ship.id)) continue;
      append(db, { kind: "ship.registered", ship_id: ship.id, provider: ship.fleet, payload: { ship } });
    }
    return { configPath, dbFile: paths.dbFile, ships: db.all("ships.all").length };
  } finally { db.close(); }
}
