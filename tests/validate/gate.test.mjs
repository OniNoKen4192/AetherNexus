import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path";
import { Git } from "../../dist/core/git.js";
import { gate } from "../../dist/validate/gate.js";
import { makeRepo, read } from "../helpers.mjs";

const routing = { security_routed: ["src/auth.ts"], do_not_touch: [".env"], attention: {} };
const pipeline = { plans_dir: ".nexus/plans", tasks_dir: ".nexus/specs", ledger: "docs/nexus/manifest.md" };

function setup(specText = read("tests/fixtures/specs/good-basic.md")) {
  const repo = makeRepo(); const g = new Git(repo.dir); const base = g.headSha();
  const wt = path.join(repo.dir, ".nexus", "worktrees", "T1"); g.worktreeAdd(wt, "nexus/T1", base);
  fs.mkdirSync(path.join(wt, ".nexus", "specs"), { recursive: true }); fs.writeFileSync(path.join(wt, ".nexus", "specs", "T1.md"), specText);
  const stateDir = path.join(repo.dir, ".nexus", "state");
  return { repo, g, wt, base, stateDir, run: () => gate({ git: g, worktree: wt, specPath: ".nexus/specs/T1.md", routing, pipeline, stateDir, now: () => "2026-10-13T00:00:00Z" }) };
}

test("gate ok: writes baseline to the main repo state dir", () => {
  const s = setup(); const r = s.run();
  assert.equal(r.ok, true); assert.equal(r.task, "T1"); assert.equal(r.base_sha, s.base);
  const baseline = JSON.parse(fs.readFileSync(path.join(s.stateDir, "T1.json"), "utf8"));
  assert.deepEqual(baseline.touch, ["src/lib/thing.js", "src/lib/thing.test.js"]); assert.equal(baseline.dispatched_at, "2026-10-13T00:00:00Z");
  s.repo.cleanup();
});

test("gate refusals: no id, unsafe id, empty touch, keep hint, security_routed, do_not_touch, escape, dirty worktree", () => {
  const good = read("tests/fixtures/specs/good-basic.md");
  const cases = [
    [read("tests/fixtures/specs/bad-no-task-id.md"), "spec", /no '\*\*Task ID\*\*:'/],
    [read("tests/fixtures/specs/bad-unsafe-id.md"), "spec", /not a canonical task ID/],
    [read("tests/fixtures/specs/bad-empty-touch.md"), "spec", /Touch table is empty/],
    [good.replace("**Model hint**: terra", "**Model hint**: keep"), "routing", /keep/],
    [good.replace("`src/lib/thing.js`", "`src/auth.ts`"), "security_gate", /security_routed/],
    [good.replace("`src/lib/thing.js`", "`.env`"), "security_gate", /do_not_touch/],
    [good.replace("`src/lib/thing.js`", "`../outside.js`"), "security_gate", /escapes the repo/],
  ];
  for (const [text, check, re] of cases) { const s = setup(text); const r = s.run(); assert.equal(r.ok, false, text.slice(0, 40)); assert.equal(r.check, check); assert.match(r.reason, re); s.repo.cleanup(); }
  const s = setup(); fs.writeFileSync(path.join(s.wt, "src", "lib", "thing.js"), "dirty\n");
  const r = s.run(); assert.equal(r.ok, false); assert.equal(r.check, "clean_baseline"); assert.deepEqual(r.details.dirty, ["src/lib/thing.js"]); s.repo.cleanup();
});

test("Review Focus #1: Touch path with backslash and space is normalized and gated", () => {
  const s = setup(read("tests/fixtures/specs/good-basic.md").replace("`src/lib/thing.js`", "`src\\lib\\my thing.js`"));
  const r = s.run(); assert.equal(r.ok, true); assert.equal(r.baseline.touch[0], "src/lib/my thing.js"); s.repo.cleanup();
});
