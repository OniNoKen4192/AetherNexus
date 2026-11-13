import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Git, withGitLog, withoutGitLog } from "../../dist/core/git.js";
import { makeRepo } from "../helpers.mjs";

test("two overlapping contexts each receive only their own git commands", async () => {
  const repo = makeRepo(); const git = new Git(repo.dir); const a = [], b = [];
  const run = (sink, ref, ms) => withGitLog((e) => sink.push(e.args.join(" ")), async () => {
    git.run(["rev-parse", ref]); await sleep(ms); git.run(["status", "--porcelain"]);
  });
  await Promise.all([run(a, "HEAD", 30), run(b, "HEAD^{tree}", 5)]);
  assert.deepEqual(a, ["rev-parse HEAD", "status --porcelain"]);
  assert.deepEqual(b, ["rev-parse HEAD^{tree}", "status --porcelain"]);
  repo.cleanup();
});

test("a git command outside any context is logged nowhere", async () => {
  const repo = makeRepo(); const git = new Git(repo.dir); const sink = [];
  await withGitLog((e) => sink.push(e.args.join(" ")), async () => { await sleep(1); });
  git.run(["rev-parse", "HEAD"]);
  assert.deepEqual(sink, []);
  repo.cleanup();
});

test("withoutGitLog suppresses the surrounding context", async () => {
  const repo = makeRepo(); const git = new Git(repo.dir); const sink = [];
  await withGitLog((e) => sink.push(e.args.join(" ")), async () => {
    git.run(["rev-parse", "HEAD"]);
    withoutGitLog(() => git.run(["status", "--porcelain"]));
    await sleep(1);
    git.run(["rev-parse", "HEAD^{tree}"]);
  });
  assert.deepEqual(sink, ["rev-parse HEAD", "rev-parse HEAD^{tree}"]);
  repo.cleanup();
});

test("the constructor log is called in addition to the context log", async () => {
  const repo = makeRepo(); const own = [], ctx = []; const git = new Git(repo.dir, { log: (e) => own.push(e.args.join(" ")) });
  withGitLog((e) => ctx.push(e.args.join(" ")), () => git.run(["rev-parse", "HEAD"]));
  assert.deepEqual(own, ["rev-parse HEAD"]); assert.deepEqual(ctx, ["rev-parse HEAD"]);
  repo.cleanup();
});
