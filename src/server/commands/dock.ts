import fs from "node:fs";
import path from "node:path";
import { append } from "../../db/events.js";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";
import { loadMoon, loadPlanet, moonScope, parkVoyage } from "../dispatch.js";

type VoyageRow = { id: string; ship_id: string; status: string; provider: string };
type VerdictRow = { verdict: string };

/** The spec's `# TASK:` title line, falling back to the task id. */
function specTitle(text: string, taskId: string): string {
  const m = /^# TASK:\s*(.+)$/m.exec(text);
  return m ? m[1]!.trim() : taskId;
}

export function dockMoon(g: Galaxy, input: { taskId: string }): { mergeSha: string | null; planetBranch: string; moonStatus: "merged" | "adrift" } {
  const { taskId } = input;
  const moon = loadMoon(g, taskId);
  const finishing = moon.status === "merged";   // resuming a dock that crashed after moon.merged
  if (moon.status !== "reviewing" && !finishing) throw new Refusal(`moon ${taskId} is '${moon.status}' — only a 'reviewing' moon with an APPROVE verdict can dock`);
  const verdicts = g.db.all<VerdictRow>("verdicts.byMoon", { moon_id: moon.id });
  if (!finishing && verdicts[verdicts.length - 1]?.verdict !== "APPROVE") throw new Refusal(`moon ${taskId} has no APPROVE verdict to dock on`);
  const voyage = g.db.get<VoyageRow>("voyages.latestByMoonRole", { moon_id: moon.id, role: "implement" });
  const resuming = voyage?.status === "docked";   // docked already: only the remaining steps are left
  if (!voyage || (voyage.status !== "cleared" && voyage.status !== "en_route" && !resuming)) throw new Refusal(`moon ${taskId} has no cleared freighter voyage to dock`);
  if (finishing && g.db.get<{ status: string }>("ships.byId", { id: voyage.ship_id })?.status !== "assigned" && !fs.existsSync(path.join(g.paths.worktrees, taskId))) {
    throw new Refusal(`moon ${taskId} is already merged`);
  }

  const scope = moonScope(g, moon);
  const fscope = { ...scope, voyage_id: voyage.id, ship_id: voyage.ship_id };
  const planet = loadPlanet(g, moon);
  if (!planet.branch || !planet.worktree) throw new Refusal(`planet '${planet.id}' has no branch`);
  const branch = `nexus/${taskId}`;
  const moonWorktree = path.join(g.paths.worktrees, taskId);
  const planetWorktree = path.resolve(g.repoRoot, planet.worktree);

  // v0 is single-flight (see dispatch.ts runVoyage): one Galaxy-wide git log hook is attributable to this voyage.
  g.git.setLog((entry) => {
    try { append(g.db, { kind: "voyage.event", ...fscope, payload: { event: { kind: "tool_use", ts: new Date().toISOString(), data: { name: "git", input: entry.args } } } }); } catch { /* logging must never break git */ }
  });
  // Idempotent tail of the dock: each step runs only if it has not happened yet.
  const finish = (planetBranch: string, sha?: string): { mergeSha: string | null; planetBranch: string; moonStatus: "merged" } => {
    const mergeSha = sha ?? g.git.revParse(planetBranch);
    if (loadMoon(g, taskId).status === "reviewing") append(g.db, { kind: "moon.merged", ...scope, payload: { merge_sha: mergeSha } });
    if (g.db.get<{ status: string }>("ships.byId", { id: voyage.ship_id })?.status === "assigned") {
      append(g.db, { kind: "ship.released", ...fscope, payload: { voyage_id: voyage.id, outcome: "docked" } });
    }
    g.git.setLog(null); // the voyage is docked: it takes no more events
    g.git.worktreeRemove(moonWorktree);
    return { mergeSha, planetBranch, moonStatus: "merged" };
  };
  try {
    // Recreates the planet worktree if it was deleted by hand.
    g.git.worktreeAdd(planetWorktree, planet.branch, g.git.revParse(planet.branch));
    if (resuming) return finish(planet.branch);
    if (voyage.status === "cleared") {
      const specAbs = path.join(g.repoRoot, moon.spec_path);
      const title = specTitle(fs.existsSync(specAbs) ? fs.readFileSync(specAbs, "utf8") : "", taskId);
      g.git.commitAll(moonWorktree, `${taskId}: ${title}`, { name: `implement/${voyage.provider}`, email: "nexus@local" });
      append(g.db, { kind: "voyage.departed", ...fscope, payload: {} });
    }
    // Check-before-act: a crash between the merge and its event must not merge twice.
    let mergeSha: string;
    if (g.git.isAncestor(g.git.revParse(branch), planet.branch)) {
      mergeSha = g.git.revParse(planet.branch);
    } else {
      const merged = g.git.mergeNoFF(planetWorktree, branch, `dock ${taskId} (${voyage.id})`);
      if (!merged.ok) {
        parkVoyage(g, { taskId, voyageId: voyage.id, shipId: voyage.ship_id, reason: "merge_conflict", details: JSON.stringify({ files: merged.files }) });
        return { mergeSha: null, planetBranch: planet.branch, moonStatus: "adrift" };
      }
      mergeSha = merged.sha;
    }
    append(g.db, { kind: "voyage.docked", ...fscope, payload: { merge_sha: mergeSha, planet_branch: planet.branch } });
    return finish(planet.branch, mergeSha);
  } finally {
    g.git.setLog(null);
  }
}
