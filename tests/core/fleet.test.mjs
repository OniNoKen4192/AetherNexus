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

test("jobFor: each role's ship job; an unknown role is an error", async () => {
  const { jobFor } = await import("../../dist/core/fleet.js");
  assert.deepEqual(["implement", "review", "carry", "plan"].map(jobFor), ["delivery", "customs", "transfer", "survey"]);
  assert.throws(() => jobFor("toString"), /no ship job/);
});

test("legacyShip: class becomes job, fleet becomes faction, weight is standard, one lead hull", async () => {
  const { legacyShip } = await import("../../dist/core/fleet.js");
  const names = { freighter: ["delivery", "Freighter"], customs: ["customs", "Customs cutter"], carrier: ["transfer", "Carrier"], surveyor: ["survey", "Surveyor"] };
  for (const [cls, [job, name]] of Object.entries(names)) {
    const s = legacyShip({ id: "x", name: "X", class: cls, fleet: "codex" });
    assert.deepEqual([s.job, s.faction, s.weight, s.formation.id, s.formation.name], [job, "codex", "standard", `legacy-${job}`, name]);
    assert.deepEqual(s.formation.vessels.map((v) => [v.count, v.role]), [[1, "lead"]]);
  }
});
