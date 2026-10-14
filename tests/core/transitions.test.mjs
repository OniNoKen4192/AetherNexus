import { test } from "node:test"; import assert from "node:assert/strict";
import { nextMoonStatus, nextVoyageStatus, TransitionRefused, MOON_TRANSITIONS, VOYAGE_TRANSITIONS } from "../../dist/core/transitions.js";
test("happy path moon", () => {
  let s = "barren"; for (const [ev, want] of [["moon.assigned","emitted"],["moon.gated","gated"],["voyage.launched:implement","implementing"],["voyage.audited","audited"],["voyage.launched:review","reviewing"],["moon.merged","merged"]]) { s = nextMoonStatus(s, ev, "m"); assert.equal(s, want, ev); }
});
test("fix round and parks", () => {
  assert.equal(nextMoonStatus("reviewing", "verdict.issued:FIX", "m"), "audited");
  assert.equal(nextMoonStatus("audited", "moon.gated", "m"), "gated");
  assert.equal(nextMoonStatus("reviewing", "verdict.issued:REJECT", "m"), "quarantined");
  assert.equal(nextMoonStatus("quarantined", "moon.gated", "m"), "gated");
  assert.equal(nextMoonStatus("adrift", "moon.dropped", "m"), "dropped");
});
test("every illegal moon/voyage transition is refused with from/event in the error", () => {
  assert.throws(() => nextMoonStatus("merged", "moon.gated", "m1"), (e) => e instanceof TransitionRefused && e.from === "merged" && e.event === "moon.gated" && /m1/.test(e.message));
  assert.throws(() => nextVoyageStatus("docked", "voyage.event", "v1"), TransitionRefused);
  // exhaustive: for every (status, event) not in the table, refuse
  const moonStates = ["barren","emitted","gated","implementing","audited","reviewing","merged","adrift","quarantined","dropped"];
  for (const ev of Object.keys(MOON_TRANSITIONS)) for (const s of moonStates) { const want = MOON_TRANSITIONS[ev][s]; if (want) assert.equal(nextMoonStatus(s, ev, "x"), want); else assert.throws(() => nextMoonStatus(s, ev, "x"), TransitionRefused, `${s} ${ev}`); }
  const vs = ["launched","working","holding","cleared","en_route","docked","superseded","adrift","quarantined"];
  for (const ev of Object.keys(VOYAGE_TRANSITIONS)) for (const s of vs) { const want = VOYAGE_TRANSITIONS[ev][s]; if (want) assert.equal(nextVoyageStatus(s, ev, "x"), want); else assert.throws(() => nextVoyageStatus(s, ev, "x"), TransitionRefused, `${s} ${ev}`); }
});
test("voyage happy paths: freighter and customs", () => {
  let s = "launched"; for (const [ev, want] of [["voyage.event","working"],["voyage.returned:implement","holding"],["voyage.cleared","cleared"],["voyage.departed","en_route"],["voyage.docked","docked"]]) { s = nextVoyageStatus(s, ev, "v"); assert.equal(s, want); }
  assert.equal(nextVoyageStatus("working", "voyage.returned:review", "v"), "docked");
  assert.equal(nextVoyageStatus("holding", "voyage.superseded", "v"), "superseded");
});
