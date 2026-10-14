import fs from "node:fs";
import path from "node:path";
import type { Git } from "../core/git.js";
import type { NexusConfig } from "../config/schema.js";
import { matchAny } from "./match.js";
import { SAFE_ID, idError, sha256, specAppendix, specBody } from "./spec.js";
import { pipelineAllowlist, type GateBaseline } from "./gate.js";

export type AuditReport = {
  task: string; base_sha: string; spec_modified: boolean; spec_appendix_modified: boolean;
  commits_past_base: string[]; in_scope: string[]; out_of_scope: string[];
  forbidden: { path: string; list: string; pattern: string }[]; allowlisted: string[];
  verdict: "clean" | "violations"; error?: string;
};
export type AuditInput = {
  git: Git; worktree: string; taskId: string; routing: NexusConfig["routing"]; pipeline: NexusConfig["pipeline"];
  stateDir: string; specText?: string;
  /** Exact commit SHAs exempt from commits_past_base: the Nexus's own carry-over commits (moon.gated carried_sha). */
  ignoreShas?: string[];
};

export function audit(input: AuditInput): AuditReport {
  const { git, worktree, taskId, routing, pipeline } = input;
  const errorReport = (error: string, task = taskId, base_sha = ""): AuditReport => ({
    task, base_sha, spec_modified: false, spec_appendix_modified: false, commits_past_base: [],
    in_scope: [], out_of_scope: [], forbidden: [], allowlisted: [], verdict: "violations", error,
  });
  if (!SAFE_ID.test(taskId)) return errorReport(idError(taskId));

  const statePath = path.join(input.stateDir, `${taskId}.json`);
  if (!fs.existsSync(statePath)) return errorReport(`no baseline state at ${statePath} — was this task gated?`);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8")) as GateBaseline;
  if (!Array.isArray(state.touch)) return errorReport("state file has no touch snapshot — re-run gate (state predates it or was tampered)", state.task);
  const specText = input.specText ?? fs.readFileSync(path.join(worktree, state.spec_path), "utf8");

  // All four surfaces: committed, staged, unstaged, untracked.
  const changed = new Set<string>([
    ...git.diffPaths(worktree, `${state.base_sha}..HEAD`),
    ...git.diffPaths(worktree, null, { cached: true }),
    ...git.diffPaths(worktree, null),
    ...git.untrackedPaths(worktree),
  ]);

  const ignore = new Set(input.ignoreShas ?? []);
  const commits = git.run(["log", "--format=%H", `${state.base_sha}..HEAD`], { cwd: worktree })
    .split(/\r?\n/).filter(Boolean).filter((sha) => !ignore.has(sha));

  const allowlist = pipelineAllowlist(pipeline);
  const report: AuditReport = {
    task: state.task,
    base_sha: state.base_sha,
    spec_modified: sha256(specBody(specText)) !== state.spec_sha256,
    spec_appendix_modified: sha256(specAppendix(specText)) !== (state.spec_appendix_sha256 ?? sha256("")),
    commits_past_base: commits,
    in_scope: [], out_of_scope: [], forbidden: [], allowlisted: [],
    verdict: "clean",
  };
  for (const p of [...changed].sort()) {
    // Deny beats allow: forbidden wins even over the pipeline allowlist.
    const secHit = matchAny(routing.security_routed, p);
    const dntHit = secHit ? null : matchAny(routing.do_not_touch, p);
    if (secHit || dntHit) {
      report.forbidden.push({ path: p, list: secHit ? "security_routed" : "do_not_touch", pattern: (secHit || dntHit)! });
    } else if (matchAny(allowlist, p)) {
      report.allowlisted.push(p);
    } else if (matchAny(state.touch, p)) {
      report.in_scope.push(p);
    } else {
      report.out_of_scope.push(p);
    }
  }
  report.verdict = (report.forbidden.length || report.out_of_scope.length || report.commits_past_base.length || report.spec_modified) ? "violations" : "clean";
  return report;
}
