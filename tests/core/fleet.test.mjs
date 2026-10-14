import { test } from "node:test";
import assert from "node:assert/strict";
import { generateFleet, slug } from "../../dist/core/fleet.js";

test("slug", () => { assert.equal(slug("Heart of Gold"), "heart-of-gold"); assert.equal(slug("LV-426 Freighter"), "lv-426-freighter"); });

test("generateFleet: per-fleet counts, unique names, deterministic", () => {
  const counts = { freighters: 3, customs: 1, carriers: 1, surveyors: 1 };
  const a = generateFleet(5, "pulp", counts, ["codex", "claude"]);
  assert.deepEqual(a, generateFleet(5, "pulp", counts, ["codex", "claude"]));
  assert.equal(a.length, 12);
  assert.equal(a.filter((s) => s.fleet === "codex" && s.class === "freighter").length, 3);
  assert.equal(new Set(a.map((s) => s.name)).size, 12);
  assert.equal(new Set(a.map((s) => s.id)).size, 12);
  assert.ok(a.every((s) => s.id === slug(s.name)));
});
