import { test } from "node:test";
import assert from "node:assert/strict";
import { read } from "../helpers.mjs";
import { matchesPattern, matchAny, normalizePath, isUnsafeRelPath } from "../../dist/validate/match.js";

const vectors = JSON.parse(read("tests/fixtures/match-vectors.json"));

for (const [pattern, p, expected] of vectors) {
  test(`match(${JSON.stringify(pattern)}, ${JSON.stringify(p)}) = ${expected}`, () => {
    assert.equal(matchesPattern(pattern, p), expected);
  });
}

test("normalizePath strips ./, trailing /, converts backslashes", () => {
  assert.equal(normalizePath("./src\\lib/"), "src/lib");
  assert.equal(normalizePath("/"), "/");
});

test("matchAny returns the first matching pattern or null", () => {
  assert.equal(matchAny(["a/**", "src/*.ts"], "src/x.ts"), "src/*.ts");
  assert.equal(matchAny(["a/**"], "b/x"), null);
});

test("isUnsafeRelPath refuses absolute, drive, and .. forms", () => {
  for (const bad of ["/etc/passwd", "C:temp/x", "c:/x", "../x", "a/../b", "a/.."]) assert.equal(isUnsafeRelPath(bad), true, bad);
  for (const ok of ["src/x.ts", "a..b/c", ".env"]) assert.equal(isUnsafeRelPath(ok), false, ok);
});
