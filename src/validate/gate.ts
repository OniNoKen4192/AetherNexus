import fs from "node:fs";
import path from "node:path";
import type { Git } from "../core/git.js";
import type { NexusConfig } from "../config/schema.js";
import { isUnsafeRelPath, matchAny, normalizePath } from "./match.js";
import { SAFE_ID, idError, parseSpec, sha256, specAppendix, specBody } from "./spec.js";

export type GateBaseline = { task: string; spec_path: string; spec_sha256: string; spec_appendix_sha256: string; touch: string[]; base_sha: string; dispatched_at: string };
export type GateInput = { git: Git; worktree: string; specPath: string; routing: NexusConfig["routing"]; pipeline: NexusConfig["pipeline"]; stateDir: string; now?: () => string };
export type GateResult =
  | { ok: true; task: string; base_sha: string; state_path: string; baseline: GateBaseline }
  | { ok: false; check: "spec" | "routing" | "clean_baseline" | "security_gate"; reason: string; details?: Record<string, unknown> };

// Fail-closed containment (PATH-MATCHING.md rule 5): resolve the deepest
// lstat-existing ancestor of p (following every intermediate symlink) and
// require it to stay inside the repo root. Unresolvable (e.g. dangling
// symlink) is a refusal, not a pass.
function resolvedInsideRepo(p: string, rootReal: string): boolean {
  const lexists = (q: string) => { try { fs.lstatSync(q); return true; } catch { return false; } };
  let deepest = p;
  while (deepest && !lexists(deepest)) {
    const parent = path.dirname(deepest);
    if (parent === deepest) break;
    deepest = parent;
  }
  let real: string;
  try { real = normalizePath(fs.realpathSync(deepest)).toLowerCase(); }
  catch { return false; }
  return real === rootReal || real.startsWith(rootReal + "/");
}

function submodulePaths(worktree: string): string[] {
  const f = path.join(worktree, ".gitmodules");
  if (!fs.existsSync(f)) return [];
  const out: string[] = [];
  for (const m of fs.readFileSync(f, "utf8").matchAll(/^\s*path\s*=\s*(.+)$/gm)) out.push(normalizePath(m[1]!));
  return out;
}

export function gate(input: GateInput): GateResult {
  const { git, worktree, routing, pipeline } = input;
  const fail = (check: Extract<GateResult, { ok: false }>["check"], reason: string, details?: Record<string, unknown>): GateResult =>
    ({ ok: false, check, reason, ...(details ? { details } : {}) });
  const rootReal = normalizePath(fs.realpathSync(worktree)).toLowerCase();
  const abs = (rel: string) => path.join(worktree, rel);

  const specPath = normalizePath(input.specPath);
  if (isUnsafeRelPath(specPath) || !resolvedInsideRepo(abs(specPath), rootReal)) return fail("spec", `spec path is outside the repo: ${input.specPath}`);
  if (!fs.existsSync(abs(specPath))) return fail("spec", `spec file not found: ${specPath}`);
  const specText = fs.readFileSync(abs(specPath), "utf8");
  const spec = parseSpec(specBody(specText));
  if (!spec.taskId) return fail("spec", "spec has no '**Task ID**:' entry in Meta");
  if (!SAFE_ID.test(spec.taskId)) return fail("spec", idError(spec.taskId));
  if (!spec.touch.length) return fail("spec", "spec's Touch table is empty or unparseable");

  // Routing law: a keep-hinted spec never dispatches.
  if ((spec.modelHint || "").toLowerCase() === "keep") {
    return fail("routing", `spec ${spec.taskId} is 'Model hint: keep' — security-routed work must go to a KEEP implementer, never DELEGATE`);
  }

  // Clean baseline except pipeline allowlist.
  const allowlist = [".nexus", pipeline.tasks_dir, pipeline.plans_dir, pipeline.ledger];
  const dirty = git.statusPaths(worktree).filter((p) => !matchAny(allowlist, p));
  if (dirty.length) {
    return fail("clean_baseline", "working tree is not clean — commit or stash these before dispatching so every post-task diff is attributable to the delegate", { dirty });
  }

  // Security gate + path hygiene on every Touch path.
  const submodules = submodulePaths(worktree);
  const touch: string[] = [];
  for (const t of spec.touch) {
    const p = normalizePath(t);
    if (isUnsafeRelPath(p)) return fail("security_gate", `Touch path escapes the repo: ${t}`);
    const sub = matchAny(submodules, p);
    if (sub) return fail("security_gate", `Touch path is inside submodule '${sub}': ${t}`);
    if (!resolvedInsideRepo(abs(p), rootReal)) return fail("security_gate", `Touch path resolves outside the repo (symlink escape or unresolvable): ${t}`);
    for (const [list, patterns] of [["security_routed", routing.security_routed], ["do_not_touch", routing.do_not_touch]] as const) {
      const hit = matchAny(patterns, p);
      if (hit) return fail("security_gate", `Touch path '${t}' matches ${list} pattern '${hit}' — this task must be routed KEEP, not dispatched`, { path: p, list, pattern: hit });
    }
    touch.push(p);
  }

  const baseline: GateBaseline = {
    task: spec.taskId,
    spec_path: specPath,
    spec_sha256: sha256(specBody(specText)),
    spec_appendix_sha256: sha256(specAppendix(specText)),
    touch,
    base_sha: git.headSha(worktree),
    dispatched_at: (input.now ?? (() => new Date().toISOString()))(),
  };
  fs.mkdirSync(input.stateDir, { recursive: true });
  const statePath = path.join(input.stateDir, `${spec.taskId}.json`);
  fs.writeFileSync(statePath, JSON.stringify(baseline, null, 2) + "\n");
  return { ok: true, task: spec.taskId, base_sha: baseline.base_sha, state_path: statePath, baseline };
}
