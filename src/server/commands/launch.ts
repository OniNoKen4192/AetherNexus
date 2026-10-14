import fs from "node:fs";
import path from "node:path";
import { append, rowToEvent } from "../../db/events.js";
import { pickIdleShip } from "../../core/fleet.js";
import type { MoonStatus } from "../../core/transitions.js";
import type { AgentEvent, ImplementReport } from "../../providers/adapter.js";
import { gate } from "../../validate/gate.js";
import { audit, type AuditReport } from "../../validate/audit.js";
import { hashSpec, sha256 } from "../../validate/spec.js";
import { Refusal } from "../errors.js";
import type { Galaxy } from "../galaxy.js";
import { loadMoon, loadPlanet, moonScope, parkVoyage, promptPath, moonTouch, renderPrompt, runVoyage, shipsNoun } from "../dispatch.js";

const NEXUS_AUTHOR = { name: "nexus", email: "nexus@nexus.local" };
const PARK_STATUSES = new Set(["BLOCKED", "BACKEND_FAILURE", "RATE_LIMITED"]);

type VerdictRow = { verdict: string; delta_spec: string | null; round: number };

/** Port of lanes-validate syncIn: the main tree's spec wins over the checkout's copy; EOL-only differences are not staleness. */
function syncIn(srcAbs: string, destAbs: string): void {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  const eol = (p: string): string => fs.readFileSync(p, "utf8").replaceAll("\r\n", "\n");
  if (!fs.existsSync(destAbs) || eol(srcAbs) !== eol(destAbs)) fs.copyFileSync(srcAbs, destAbs);
}

function pickProvider(g: Galaxy, requested: string | undefined): string {
  if (requested) return requested;
  const ids = g.config.roles.implement;
  const idle = ids.find((id) => g.adapters[id] && pickIdleShip(g.db, "freighter", id));
  const first = idle ?? ids[0];
  if (!first) throw new Refusal("no provider is configured for the implement role");
  return first;
}

/** The gate's state file no longer matches the hash moon.gated recorded: the baseline cannot be trusted. */
export class BaselineTampered extends Error {
  constructor(message: string) { super(message); this.name = "BaselineTampered"; }
}

/**
 * Audit the task's worktree against its gate baseline. The state file is trusted only if its sha256 matches the
 * `baseline_sha` the latest moon.gated recorded (else BaselineTampered); Nexus carry-over commits are exempt by exact SHA.
 */
export function auditTask(g: Galaxy, p: { taskId: string; worktree: string }, auditFn: typeof audit = audit): AuditReport {
  const gatedEvents = g.db.all("events.byAssignment", { assignment_id: loadMoon(g, p.taskId).assignment_id }).map(rowToEvent).filter((e) => e.kind === "moon.gated");
  const statePath = path.join(g.paths.stateDir, `${p.taskId}.json`);
  if (fs.existsSync(statePath)) {
    const expected = gatedEvents[gatedEvents.length - 1]?.payload["baseline_sha"];
    if (typeof expected !== "string") throw new BaselineTampered(`no baseline hash is recorded for task ${p.taskId}, but ${statePath} exists`);
    if (sha256(fs.readFileSync(statePath, "utf8")) !== expected) throw new BaselineTampered(`${statePath} does not match the hash recorded when task ${p.taskId} was gated`);
  }
  const ignoreShas = gatedEvents.map((e) => e.payload["carried_sha"]).filter((x): x is string => typeof x === "string");
  return auditFn({ git: g.git, worktree: p.worktree, taskId: p.taskId, routing: g.config.routing, pipeline: g.config.pipeline, stateDir: g.paths.stateDir, ignoreShas });
}

/** Run the audit; if it throws, park the voyage (reason audit_error, or baseline_tampered) instead of stranding the moon in 'implementing'. */
export function runAuditOrPark(g: Galaxy, p: { taskId: string; worktree: string; voyageId: string; shipId: string }, auditFn: typeof audit = audit): AuditReport | null {
  try {
    return auditTask(g, p, auditFn);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    parkVoyage(g, { taskId: p.taskId, voyageId: p.voyageId, shipId: p.shipId, reason: err instanceof BaselineTampered ? "baseline_tampered" : "audit_error", details: JSON.stringify({ message }) });
    return null;
  }
}

/** True when the latest human.message for the assignment is newer than the latest park (moon.adrift or a REJECT verdict). */
function repliedSincePark(g: Galaxy, assignmentId: number): boolean {
  let park = 0, reply = 0;
  for (const e of g.db.all("events.byAssignment", { assignment_id: assignmentId }).map(rowToEvent)) {
    if (e.kind === "moon.adrift" || (e.kind === "verdict.issued" && e.payload["verdict"] === "REJECT")) park = e.id;
    else if (e.kind === "human.message") reply = e.id;
  }
  return reply > park;
}

const violationPaths = (r: AuditReport): string[] => [...r.out_of_scope, ...r.forbidden.map((f) => f.path)];

/** Paths the latest recorded audit of the assignment flagged (out_of_scope and forbidden). */
function recordedViolations(g: Galaxy, assignmentId: number): Set<string> {
  const audited = g.db.all("events.byAssignment", { assignment_id: assignmentId }).map(rowToEvent).filter((e) => e.kind === "voyage.audited").pop();
  const rec = audited?.payload["audit"] as AuditReport | undefined;
  return new Set(rec ? violationPaths(rec) : []);
}

/** Split paths into those git tracks (restored to HEAD) and those it does not (deleted). */
function classifyPaths(g: Galaxy, worktree: string, paths: string[]): { reverted: string[]; deleted: string[] } {
  const reverted: string[] = [], deleted: string[] = [];
  for (const p of paths) {
    let tracked = true;
    try { g.git.run(["ls-files", "--error-unmatch", "--", p], { cwd: worktree }); } catch { tracked = false; }
    (tracked ? reverted : deleted).push(p);
  }
  return { reverted, deleted };
}
function applyRestore(g: Galaxy, worktree: string, r: { reverted: string[]; deleted: string[] }): void {
  for (const p of r.reverted) g.git.run(["checkout", "HEAD", "--", p], { cwd: worktree });
  for (const p of r.deleted) fs.rmSync(path.join(worktree, p), { recursive: true, force: true });
}

export async function launchMoon(
  g: Galaxy, input: { taskId: string; provider?: string; onEvent?: (e: AgentEvent) => void; signal?: AbortSignal },
  deps?: { audit?: typeof audit },
): Promise<{ voyageId: string; audit: AuditReport | null; moonStatus: MoonStatus }> {
  const { taskId } = input;
  const moon = loadMoon(g, taskId);
  const status = moon.status;
  const verdicts = g.db.all<VerdictRow>("verdicts.byAssignment", { assignment_id: moon.assignment_id });
  const lastVerdict = verdicts[verdicts.length - 1];

  // Precheck 1: state.
  // A parked moon relaunches only after a human reply newer than the park (reply appends moon.amended, then human.message).
  const relaunch = status === "adrift" || status === "quarantined";
  if (relaunch && !repliedSincePark(g, moon.assignment_id)) throw new Refusal(`moon ${taskId} is ${status} — use 'nexus moon reply' or 'nexus moon drop'`);
  if (status === "audited") {
    if (lastVerdict?.verdict !== "FIX") throw new Refusal(`moon ${taskId} is 'audited' — run 'nexus moon inspect'; only a FIX verdict reopens it for another launch`);
  } else if (!relaunch && status !== "emitted" && status !== "gated") {
    throw new Refusal(`moon ${taskId} is '${status}' — it cannot be launched from there`);
  }
  const fixRound = status === "audited";
  const round = fixRound || relaunch ? moon.round + 1 : moon.round || 1;

  // Precheck 2: spec immutability — the body is the contract; changes go under ## Amendments.
  const specAbs = path.join(g.repoRoot, moon.spec_path);
  if (!fs.existsSync(specAbs)) throw new Refusal(`spec '${moon.spec_path}' does not exist`);
  const specText = fs.readFileSync(specAbs, "utf8");
  if (hashSpec(specText).bodySha !== moon.spec_sha) throw new Refusal("spec body changed since assign — amend under ## Amendments instead");

  // Precheck 3: a free ship, before any side effect.
  const provider = pickProvider(g, input.provider);
  if (!g.adapters[provider]) throw new Refusal(`provider '${provider}' is not configured`);
  if (!pickIdleShip(g.db, "freighter", provider)) throw new Refusal(`all ${shipsNoun("freighter")} in fleet '${provider}' are assigned`);

  const scope = moonScope(g, moon);
  const planet = loadPlanet(g, moon);
  const worktree = path.join(g.paths.worktrees, taskId);
  const branch = `nexus/${taskId}`;
  if (!planet.branch) throw new Refusal(`planet '${planet.id}' has no branch`);
  const hadWorktree = fs.existsSync(worktree);
  g.git.worktreeAdd(worktree, branch, g.git.revParse(planet.branch));
  syncIn(specAbs, path.join(worktree, moon.spec_path));
  // A FIX round starts from a clean baseline: the previous round's work becomes a nexus-authored commit
  // (the audit ignores nexus commits), so this round's audit shows only this round's changes.
  let carriedSha: string | undefined;
  // A relaunch after a park is treated the same way (when its worktree survived): the parked work is carried over, audited first.
  // Without a gate baseline (a gate_failed park never wrote one) there is nothing to audit against: gate afresh instead.
  const hasBaseline = fs.existsSync(path.join(g.paths.stateDir, `${taskId}.json`));
  if (fixRound || (relaunch && hadWorktree && hasBaseline)) {
    // Re-audit against the round-1 baseline first: anything that changed in the worktree since that audit
    // (customs runs there; a human may edit) would otherwise be committed as 'nexus' and never audited again.
    const runCarry = (): AuditReport => auditTask(g, { taskId, worktree }, deps?.audit ?? audit);
    const parkMoon = (reason: string, details: Record<string, unknown>): { voyageId: string; audit: AuditReport | null; moonStatus: MoonStatus } => {
      // A moon that is already parked cannot go adrift again: refuse and leave it as it is (fix the worktree, then relaunch).
      if (relaunch) throw new Refusal(`carry-over audit refused the parked worktree (${reason})`, details);
      // The previous freighter voyage is already superseded (cannot go adrift), so park the moon itself.
      append(g.db, { kind: "moon.adrift", ...scope, payload: { reason } });
      append(g.db, { kind: "decision.opened", ...scope, payload: { kind: "adrift", target_kind: "moon", target_id: taskId, reasoning: `round ${moon.round} work changed after its audit (${reason}): ${JSON.stringify(details)}` } });
      return { voyageId: "", audit: null, moonStatus: "adrift" };
    };
    let carry: AuditReport;
    try { carry = runCarry(); } catch (err) {
      if (err instanceof BaselineTampered) return parkMoon("baseline_tampered", { message: err.message });
      throw err;
    }
    // The human has answered an audit_violations park: put the violations that audit recorded back to the baseline
    // so the new round starts in scope. Only if that leaves the tree clean; otherwise nothing is touched.
    if (relaunch && moon.park_reason === "audit_violations" && carry.verdict === "violations") {
      const recorded = recordedViolations(g, moon.assignment_id);
      const current = violationPaths(carry);
      const otherwiseDirty = current.some((p) => !recorded.has(p)) || carry.commits_past_base.length > 0 || carry.spec_modified || !!carry.error;
      if (!otherwiseDirty && current.length) {
        const plan = classifyPaths(g, worktree, current);
        append(g.db, { kind: "moon.restored", ...scope, payload: { paths: plan } });
        applyRestore(g, worktree, plan);
        carry = runCarry();
      }
    }
    if (carry.verdict === "violations") {
      const details = { out_of_scope: carry.out_of_scope, forbidden: carry.forbidden, ...(carry.error ? { error: carry.error } : {}) };
      return { ...parkMoon("carryover_violations", details), audit: carry };
    }
    carriedSha = g.git.commitAll(worktree, `nexus: ${taskId} round ${moon.round} work`, NEXUS_AUTHOR) ?? g.git.headSha(worktree);
  }

  const gated = gate({ git: g.git, worktree, specPath: moon.spec_path, routing: g.config.routing, pipeline: g.config.pipeline, stateDir: g.paths.stateDir });
  if (!gated.ok) {
    if (status === "emitted") {
      append(g.db, { kind: "moon.gate_failed", ...scope, payload: { check: gated.check, reason: gated.reason } });
      append(g.db, { kind: "decision.opened", ...scope, payload: { kind: "gate_failed", target_kind: "moon", target_id: taskId, reasoning: `gate '${gated.check}' failed: ${gated.reason}` } });
    }
    throw new Refusal(`gate failed (${gated.check}): ${gated.reason}`, gated.details);
  }
  // Every gate rewrites the state file, so every gate is recorded (gated -> gated included) with the file's hash.
  append(g.db, { kind: "moon.gated", ...scope, payload: { base_sha: gated.base_sha, state_path: gated.state_path, baseline_sha: gated.baseline_sha, round, ...(carriedSha ? { carried_sha: carriedSha } : {}) } });

  // Resume only this assignment's own session on the same provider: a session id means nothing to another backend,
  // and a dropped assignment of the same task id is a different conversation.
  const previous = g.db.get<{ session_id: string | null; provider: string }>("voyages.latestByAssignmentRole", { assignment_id: moon.assignment_id, role: "implement" });
  const resumeId = previous?.provider === provider ? previous.session_id : null;
  const deltaSpec = fixRound ? lastVerdict?.delta_spec ?? undefined : undefined;
  const delta_section = deltaSpec ? `\n## Delta from customs (round ${round})\n\n${deltaSpec}\n\n` : "\n";
  const prompt = renderPrompt(promptPath("implement.md"), { spec_path: moon.spec_path, worktree, spec_text: specText, delta_section });
  const outcome = await runVoyage(g, {
    role: "implement", taskId, provider, worktree, touch: moonTouch(moon), ...(input.onEvent ? { onEvent: input.onEvent } : {}), ...(input.signal ? { signal: input.signal } : {}),
    job: {
      role: "implement", specPath: moon.spec_path, specText, prompt, round,
      ...(deltaSpec ? { deltaSpec } : {}), ...(resumeId ? { previousSessionId: resumeId } : {}),
    },
  });

  let report: AuditReport | null = null;
  if (outcome.done) {
    report = runAuditOrPark(g, { taskId, worktree, voyageId: outcome.voyageId, shipId: outcome.shipId }, deps?.audit ?? audit);
    if (!report) return { voyageId: outcome.voyageId, audit: null, moonStatus: loadMoon(g, taskId).status as MoonStatus };
    append(g.db, { kind: "voyage.audited", ...scope, voyage_id: outcome.voyageId, ship_id: outcome.shipId, payload: { audit: report } });
    const impl = outcome.done.data.report as ImplementReport;
    if (PARK_STATUSES.has(impl.status)) {
      parkVoyage(g, { taskId, voyageId: outcome.voyageId, shipId: outcome.shipId, reason: impl.status.toLowerCase(), details: impl.blocked_reason ?? impl.raw });
    } else if (report.verdict === "violations") {
      const why = report.error ?? [
        report.out_of_scope.length ? `out of scope: ${report.out_of_scope.join(", ")}` : "",
        report.forbidden.length ? `forbidden: ${report.forbidden.map((f) => f.path).join(", ")}` : "",
        report.commits_past_base.length ? `commits past base: ${report.commits_past_base.length}` : "",
        report.spec_modified ? "spec body modified" : "",
      ].filter(Boolean).join("; ");
      parkVoyage(g, { taskId, voyageId: outcome.voyageId, shipId: outcome.shipId, reason: "audit_violations", details: why });
    }
  }
  return { voyageId: outcome.voyageId, audit: report, moonStatus: loadMoon(g, taskId).status as MoonStatus };
}
