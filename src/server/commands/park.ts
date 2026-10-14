import fs from "node:fs";
import path from "node:path";
import { append } from "../../db/events.js";
import { appendAmendment, hashSpec } from "../../validate/spec.js";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";
import { loadMoon, moonScope, type MoonRow } from "../dispatch.js";

type VoyageRow = { id: string; ship_id: string; status: string };
type DecisionRow = { id: number };
const SUPERSEDABLE = new Set(["holding", "adrift", "quarantined"]);

/** Supersede every parked voyage of the moon and free its ship. A moon parked with no voyage (carry-over park) has nothing to do. */
export function releaseMoonVoyages(g: Galaxy, moon: MoonRow, outcome: "reply" | "drop"): void {
  const scope = moonScope(g, moon);
  for (const v of g.db.all<VoyageRow>("voyages.byMoon", { moon_id: moon.id })) {
    if (!SUPERSEDABLE.has(v.status)) continue;
    const vscope = { ...scope, voyage_id: v.id, ship_id: v.ship_id };
    append(g.db, { kind: "voyage.superseded", ...vscope, payload: {} });
    const ship = g.db.get<{ status: string }>("ships.byId", { id: v.ship_id });
    if (ship && ship.status !== "idle" && ship.status !== "retired") append(g.db, { kind: "ship.released", ...vscope, payload: { voyage_id: v.id, outcome } });
  }
}

function resolveDecisions(g: Galaxy, moon: MoonRow, outcome: "reply" | "drop", note: string): void {
  const scope = moonScope(g, moon);
  for (const d of g.db.all<DecisionRow>("decisions.pendingByTarget", { target_id: moon.task_id })) {
    append(g.db, { kind: "decision.resolved", ...scope, payload: { decision_id: d.id, outcome, human_note: note } });
  }
}

function requireParked(moon: MoonRow, verb: string): void {
  if (moon.status !== "adrift" && moon.status !== "quarantined") throw new Refusal(`moon ${moon.task_id} is '${moon.status}' — only an adrift or quarantined moon can be ${verb}`);
}

export function replyMoon(g: Galaxy, input: { taskId: string; note: string }): { round: number } {
  const moon = loadMoon(g, input.taskId);
  requireParked(moon, "replied to");
  const round = moon.round + 1;
  const scope = moonScope(g, moon);
  const specAbs = path.join(g.repoRoot, moon.spec_path);
  if (!fs.existsSync(specAbs)) throw new Refusal(`spec '${moon.spec_path}' does not exist`);
  const amended = appendAmendment(fs.readFileSync(specAbs, "utf8"), { round, date: new Date().toISOString().slice(0, 10), author: "human", note: input.note.replace(/\s+/g, " ").trim() });
  fs.writeFileSync(specAbs, amended);
  const wtSpec = path.join(g.paths.worktrees, moon.task_id, moon.spec_path);
  if (fs.existsSync(path.dirname(wtSpec))) fs.writeFileSync(wtSpec, amended);
  releaseMoonVoyages(g, moon, "reply");
  resolveDecisions(g, moon, "reply", input.note);
  append(g.db, { kind: "moon.amended", ...scope, payload: { appendix_sha: hashSpec(amended).appendixSha } });
  append(g.db, { kind: "human.message", ...scope, payload: { note: input.note, round } });
  return { round };
}

export function dropMoon(g: Galaxy, input: { taskId: string }): { moonId: string } {
  const moon = loadMoon(g, input.taskId);
  requireParked(moon, "dropped");
  const scope = moonScope(g, moon);
  releaseMoonVoyages(g, moon, "drop");
  resolveDecisions(g, moon, "drop", "");
  append(g.db, { kind: "moon.dropped", ...scope, payload: {} });
  g.git.worktreeRemove(path.join(g.paths.worktrees, moon.task_id), { force: true });
  if (g.git.branchExists(`nexus/${moon.task_id}`)) g.git.deleteBranch(`nexus/${moon.task_id}`, { force: true });
  append(g.db, { kind: "moon.cleared", ...scope, payload: {} });
  return { moonId: moon.id };
}

export function retireShip(g: Galaxy, input: { shipId: string; reason: string }): void {
  const ship = g.db.get<{ status: string }>("ships.byId", { id: input.shipId });
  if (!ship) throw new Refusal(`no ship '${input.shipId}'`);
  if (ship.status !== "idle") throw new Refusal(`ship ${input.shipId} is '${ship.status}', not idle — only an idle ship can be retired`);
  append(g.db, { kind: "ship.retired", ship_id: input.shipId, payload: { reason: input.reason } }, () => {
    if (g.db.get<{ status: string }>("ships.byId", { id: input.shipId })?.status !== "idle") throw new Refusal(`ship ${input.shipId} is not idle`);
  });
}
