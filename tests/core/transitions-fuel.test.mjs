import { test } from "node:test";
import assert from "node:assert/strict";
import { nextMoonStatus, nextVoyageStatus, TransitionRefused, MOON_TRANSITIONS, VOYAGE_TRANSITIONS } from "../../dist/core/transitions.js";

const moonStates = ["barren", "emitted", "gated", "implementing", "audited", "reviewing", "merged", "adrift", "quarantined", "dropped", "awaiting_pickup"];
const voyageStates = ["launched", "working", "holding", "cleared", "en_route", "docked", "superseded", "adrift", "quarantined", "out_of_fuel"];

test("fuel arrows accept every listed moon and voyage transition", () => {
  const moonArrows = {
    "moon.awaiting_pickup": { implementing: "awaiting_pickup", audited: "awaiting_pickup" },
    "moon.review_abandoned": { reviewing: "audited" },
    "moon.gated": { awaiting_pickup: "gated" },
    "moon.adrift": { awaiting_pickup: "adrift" },
    "moon.dropped": { awaiting_pickup: "dropped" },
  };
  for (const [event, arrows] of Object.entries(moonArrows)) for (const [from, to] of Object.entries(arrows)) assert.equal(nextMoonStatus(from, event, "m"), to, `${event} from ${from}`);
  const voyageArrows = {
    "voyage.out_of_fuel": { launched: "out_of_fuel", working: "out_of_fuel", holding: "out_of_fuel" },
    "voyage.superseded": { out_of_fuel: "superseded" },
  };
  for (const [event, arrows] of Object.entries(voyageArrows)) for (const [from, to] of Object.entries(arrows)) assert.equal(nextVoyageStatus(from, event, "v"), to, `${event} from ${from}`);
});

test("fuel-related moon event keys refuse every source absent from their tables", () => {
  for (const event of ["moon.awaiting_pickup", "moon.review_abandoned", "moon.gated", "moon.adrift", "moon.dropped"]) for (const from of moonStates) {
    const to = MOON_TRANSITIONS[event]?.[from];
    if (to) assert.equal(nextMoonStatus(from, event, "m"), to);
    else assert.throws(() => nextMoonStatus(from, event, "m"), TransitionRefused, `${event} from ${from}`);
  }
  assert.throws(() => nextMoonStatus("awaiting_pickup", "voyage.launched:implement", "m"), TransitionRefused);
});

test("fuel-related voyage event keys refuse every source absent from their tables", () => {
  for (const event of ["voyage.out_of_fuel", "voyage.superseded"]) for (const from of voyageStates) {
    const to = VOYAGE_TRANSITIONS[event]?.[from];
    if (to) assert.equal(nextVoyageStatus(from, event, "v"), to);
    else assert.throws(() => nextVoyageStatus(from, event, "v"), TransitionRefused, `${event} from ${from}`);
  }
  for (const event of Object.keys(VOYAGE_TRANSITIONS).filter((event) => event !== "voyage.superseded")) assert.throws(() => nextVoyageStatus("out_of_fuel", event, "v"), TransitionRefused, event);
});
