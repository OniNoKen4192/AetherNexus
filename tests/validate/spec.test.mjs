import { test } from "node:test";
import assert from "node:assert/strict";
import { read } from "../helpers.mjs";
import { parseSpec, specBody, specAppendix, hashSpec, SAFE_ID, appendAmendment } from "../../dist/validate/spec.js";

const good = read("tests/fixtures/specs/good-basic.md");

test("parseSpec: id, hint, touch", () => {
  const s = parseSpec(good);
  assert.equal(s.taskId, "T1");
  assert.equal(s.modelHint, "terra");
  assert.deepEqual(s.touch, ["src/lib/thing.js", "src/lib/thing.test.js"]);
  assert.deepEqual(s.dependsOn, []);
  assert.equal(s.gravity, undefined);
});

test("parseSpec: depends on list and gravity", () => {
  const s = parseSpec(read("tests/fixtures/specs/good-deps.md"));
  assert.deepEqual(s.dependsOn, ["T0", "T0b"]);
  assert.equal(s.gravity, 7);
});

test("parseSpec: missing id / empty touch", () => {
  assert.equal(parseSpec(read("tests/fixtures/specs/bad-no-task-id.md")).taskId, undefined);
  assert.deepEqual(parseSpec(read("tests/fixtures/specs/bad-empty-touch.md")).touch, []);
  assert.equal(SAFE_ID.test(parseSpec(read("tests/fixtures/specs/bad-unsafe-id.md")).taskId), false);
});

test("amendments: body hash stable, appendix hash changes", () => {
  const amended = read("tests/fixtures/specs/good-amended.md");
  assert.equal(hashSpec(good).bodySha, hashSpec(amended).bodySha);
  assert.notEqual(hashSpec(good).appendixSha, hashSpec(amended).appendixSha);
  assert.equal(specAppendix(good), "");
  assert.match(specAppendix(amended), /^## Amendments/);
  assert.equal(specBody(amended).endsWith("\n"), false);
});

test("appendAmendment creates the section once and appends entries", () => {
  const once = appendAmendment(good, { round: 1, date: "2026-10-13", author: "human", note: "use helper" });
  const twice = appendAmendment(once, { round: 2, date: "2026-10-14", author: "customs", note: "fix test" });
  assert.equal((twice.match(/^## Amendments$/gm) || []).length, 1);
  assert.match(twice, /### A1 — 2026-10-13 — human: use helper/);
  assert.match(twice, /### A2 — 2026-10-14 — customs: fix test/);
  assert.equal(hashSpec(twice).bodySha, hashSpec(good).bodySha);
});

test("Review Focus #1: touch paths with spaces and backslashes survive parsing", () => {
  const text = good.replace("`src/lib/thing.js`", "`src\\lib\\my thing.js`");
  assert.deepEqual(parseSpec(text).touch[0], "src\\lib\\my thing.js"); // normalization is the gate's job, not the parser's
});
