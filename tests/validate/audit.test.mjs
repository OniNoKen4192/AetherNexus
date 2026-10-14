import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path";
import { Git } from "../../dist/core/git.js";
import { gate } from "../../dist/validate/gate.js";
import { audit } from "../../dist/validate/audit.js";
import { appendAmendment } from "../../dist/validate/spec.js";
import { makeRepo, read } from "../helpers.mjs";

const routing = { security_routed: ["src/auth.ts"], do_not_touch: [".env"], attention: {} };
const pipeline = { plans_dir: ".nexus/plans", tasks_dir: ".nexus/specs", ledger: "docs/nexus/manifest.md" };
function setup() {
  const repo = makeRepo(); const g = new Git(repo.dir); const base = g.headSha();
  const wt = path.join(repo.dir, ".nexus", "worktrees", "T1"); g.worktreeAdd(wt, "nexus/T1", base);
  fs.mkdirSync(path.join(wt, ".nexus", "specs"), { recursive: true }); const specPath = path.join(wt, ".nexus", "specs", "T1.md");
  fs.writeFileSync(specPath, read("tests/fixtures/specs/good-basic.md"));
  const stateDir = path.join(repo.dir, ".nexus", "state");
  assert.equal(gate({ git: g, worktree: wt, specPath: ".nexus/specs/T1.md", routing, pipeline, stateDir }).ok, true);
  return { repo, g, wt, specPath, stateDir, run: (o = {}) => audit({ git: g, worktree: wt, taskId: "T1", routing, pipeline, stateDir, ...o }) };
}

test("clean: in-scope edits only", () => {
  const s = setup(); fs.writeFileSync(path.join(s.wt, "src", "lib", "thing.js"), "x\n"); fs.writeFileSync(path.join(s.wt, "src", "lib", "thing.test.js"), "t\n");
  const r = s.run(); assert.equal(r.verdict, "clean"); assert.deepEqual(r.in_scope.sort(), ["src/lib/thing.js", "src/lib/thing.test.js"]); assert.deepEqual(r.out_of_scope, []); s.repo.cleanup();
});
test("violations: out of scope, forbidden beats allowlist, agent commit flagged, spec body edit flagged, appendix edit informational", () => {
  const s = setup();
  fs.writeFileSync(path.join(s.wt, "README.md"), "changed\n"); fs.writeFileSync(path.join(s.wt, "src", "auth.ts"), "changed\n");
  s.g.commitAll(s.wt, "agent commit", { name: "agent", email: "agent@example.com" });
  fs.writeFileSync(s.specPath, appendAmendment(fs.readFileSync(s.specPath, "utf8"), { round: 1, date: "2026-10-13", author: "human", note: "n" }));
  let r = s.run(); assert.equal(r.verdict, "violations");
  assert.deepEqual(r.out_of_scope, ["README.md"]); assert.deepEqual(r.forbidden, [{ path: "src/auth.ts", list: "security_routed", pattern: "src/auth.ts" }]);
  assert.equal(r.commits_past_base.length, 1); assert.equal(r.spec_modified, false); assert.equal(r.spec_appendix_modified, true);
  fs.writeFileSync(s.specPath, fs.readFileSync(s.specPath, "utf8").replace("Add X to thing.", "Add Y to thing."));
  r = s.run(); assert.equal(r.spec_modified, true); s.repo.cleanup();
});
test("only the exact SHAs in ignoreShas are exempt from 'commits past base'; a nexus-looking author is not", () => {
  const s = setup(); fs.writeFileSync(path.join(s.wt, "src", "lib", "thing.js"), "x\n");
  const carried = s.g.commitAll(s.wt, "nexus: T1 round 1 work", { name: "nexus", email: "nexus@nexus.local" });
  let r = s.run({ ignoreShas: [carried] }); assert.deepEqual(r.commits_past_base, []); assert.equal(r.verdict, "clean");
  // A delegate spoofing the Nexus's author email is still flagged: the exemption is by SHA, not by author.
  fs.writeFileSync(path.join(s.wt, "src", "lib", "thing.test.js"), "t\n");
  const spoofed = s.g.commitAll(s.wt, "looks like nexus", { name: "nexus", email: "nexus@nexus.local" });
  r = s.run({ ignoreShas: [carried] }); assert.deepEqual(r.commits_past_base, [spoofed]); assert.equal(r.verdict, "violations");
  s.repo.cleanup();
});
test("the pipeline allowlist is specs/tasks/plans/ledger only: an edit to .nexus/config.json is out of scope", () => {
  const s = setup(); fs.writeFileSync(path.join(s.wt, "src", "lib", "thing.js"), "x\n");
  fs.writeFileSync(path.join(s.wt, ".nexus", "config.json"), "{}\n");
  fs.mkdirSync(path.join(s.wt, ".nexus", "plans"), { recursive: true }); fs.writeFileSync(path.join(s.wt, ".nexus", "plans", "p.md"), "plan\n");
  const r = s.run(); assert.deepEqual(r.out_of_scope, [".nexus/config.json"]); assert.ok(r.allowlisted.includes(".nexus/plans/p.md"));
  assert.equal(r.verdict, "violations"); s.repo.cleanup();
});
test("no baseline → error verdict", () => {
  const s = setup(); fs.rmSync(path.join(s.stateDir, "T1.json")); const r = s.run(); assert.equal(r.verdict, "violations"); assert.match(r.error, /no baseline state/); s.repo.cleanup();
});
