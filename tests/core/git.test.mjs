import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path";
import { Git, GitRefusal } from "../../dist/core/git.js";
import { makeRepo } from "../helpers.mjs";

test("refusal list: push, main-worktree checkout/reset/stash, foreign branch -D, worktree remove outside .nexus", () => {
  const { dir, cleanup } = makeRepo(); const g = new Git(dir);
  assert.throws(() => g.run(["push", "origin", "main"]), GitRefusal);
  for (const args of [["checkout", "main"], ["switch", "main"], ["reset", "--hard"], ["stash"]]) assert.throws(() => g.run(args), GitRefusal, args.join(" "));
  assert.throws(() => g.run(["branch", "-D", "main"]), GitRefusal);
  assert.throws(() => g.deleteBranch("feature/x", { force: true }), GitRefusal);
  assert.throws(() => g.worktreeRemove(path.join(dir, "src")), GitRefusal);
  assert.throws(() => g.run(["-c", "user.name=x", "commit", "-m", "x", "--allow-empty"]), GitRefusal);
  assert.throws(() => g.run(["worktree", "add", "-b", "nexus/evil", path.join(dir, "elsewhere")]), GitRefusal);
  assert.throws(() => g.run(["worktree", "add", path.join(dir, "elsewhere"), "-b", "nexus/evil"]), GitRefusal);
  cleanup();
});

test("branches: create from sha without checkout; HEAD of main untouched", () => {
  const { dir, git, cleanup } = makeRepo(); const g = new Git(dir); const base = g.headSha();
  g.createBranch("system/S1/integration", base);
  assert.equal(g.branchExists("system/S1/integration"), true);
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(g.deleteBranch("system/S1/integration"), true);
  cleanup();
});

test("worktree add/remove under .nexus/worktrees; exclude file; empty-shell clear; list normalized", () => {
  const { dir, cleanup } = makeRepo(); const g = new Git(dir); const base = g.headSha();
  const wt = path.join(dir, ".nexus", "worktrees", "T1");
  g.worktreeAdd(wt, "nexus/T1", base);
  assert.ok(fs.existsSync(path.join(wt, "src", "lib", "thing.js")));
  assert.ok(g.worktreeList().some((p) => p.toLowerCase() === wt.replaceAll("\\", "/").toLowerCase()));
  assert.match(fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8"), /^\.nexus\/worktrees\/$/m);
  g.worktreeRemove(wt);
  assert.equal(fs.existsSync(wt), false);
  fs.mkdirSync(wt, { recursive: true });                      // Windows-style leftover shell
  g.worktreeAdd(wt, "nexus/T1", base);                        // must not refuse on the empty shell
  assert.ok(fs.existsSync(path.join(wt, "README.md")));
  g.worktreeRemove(wt, { force: true }); cleanup();
});

test("Review Focus #4: worktreeAdd on a branch that already exists checks it out instead of failing", () => {
  const { dir, cleanup } = makeRepo(); const g = new Git(dir); const base = g.headSha();
  const wt = path.join(dir, ".nexus", "worktrees", "P1");
  g.worktreeAdd(wt, "system/S1/P1", base); g.worktreeRemove(wt, { force: true });
  assert.equal(g.branchExists("system/S1/P1"), true, "remove keeps the branch");
  g.worktreeAdd(wt, "system/S1/P1", base);
  assert.ok(fs.existsSync(path.join(wt, "README.md"))); cleanup();
});

test("status/diff/untracked -z parsers; commitAll with author; mergeNoFF success and conflict", () => {
  const { dir, cleanup } = makeRepo(); const g = new Git(dir); const base = g.headSha();
  const planet = path.join(dir, ".nexus", "worktrees", "P1"); g.worktreeAdd(planet, "system/S1/P1", base);
  const moon = path.join(dir, ".nexus", "worktrees", "T1"); g.worktreeAdd(moon, "nexus/T1", base);
  fs.writeFileSync(path.join(moon, "src", "lib", "thing.js"), "export const thing = 2;\n");
  fs.writeFileSync(path.join(moon, "src", "lib", "new.js"), "new\n");
  assert.deepEqual(g.statusPaths(moon).sort(), ["src/lib/new.js", "src/lib/thing.js"]);
  assert.deepEqual(g.untrackedPaths(moon), ["src/lib/new.js"]);
  assert.equal(g.commitAll(moon, "T1 work", { name: "implement/fake", email: "nexus@local" }) !== null, true);
  assert.equal(g.commitAll(moon, "nothing", { name: "x", email: "x@x" }), null);
  assert.deepEqual(g.diffPaths(moon, `${base}..HEAD`).sort(), ["src/lib/new.js", "src/lib/thing.js"]);
  assert.match(g.run(["log", "-1", "--format=%an"], { cwd: moon }), /implement\/fake/);
  const m = g.mergeNoFF(planet, "nexus/T1", "dock T1"); assert.equal(m.ok, true);
  assert.equal(g.isAncestor(g.revParse("nexus/T1"), "system/S1/P1"), true);
  // conflict: both sides edit thing.js differently
  fs.writeFileSync(path.join(planet, "src", "lib", "thing.js"), "export const thing = 3;\n"); g.commitAll(planet, "planet edit", { name: "x", email: "x@x" });
  const moon2 = path.join(dir, ".nexus", "worktrees", "T2"); g.worktreeAdd(moon2, "nexus/T2", base);
  fs.writeFileSync(path.join(moon2, "src", "lib", "thing.js"), "export const thing = 4;\n"); g.commitAll(moon2, "T2", { name: "x", email: "x@x" });
  const c = g.mergeNoFF(planet, "nexus/T2", "dock T2");
  assert.equal(c.ok, false); assert.deepEqual(c.files, ["src/lib/thing.js"]);
  assert.deepEqual(g.statusPaths(planet), [], "merge --abort left the planet clean");
  cleanup();
});

test("git failures carry stderr in the message", () => {
  const { dir, cleanup } = makeRepo(); const g = new Git(dir);
  assert.throws(() => g.revParse("no-such-ref"), /no-such-ref|unknown revision|Needed a single revision/i);
  cleanup();
});
