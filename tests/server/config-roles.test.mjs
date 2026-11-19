import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeGalaxy } from "../helpers.mjs";
import { worldWithMoon } from "../fixtures/world.mjs";
import { setRoleOrder } from "../../dist/server/commands/config.js";
import { sendDelivery } from "../../dist/server/commands/delivery.js";
import { Refusal } from "../../dist/server/errors.js";

const withTwoProviders = (c) => {
  c.providers.fake2 = { ...c.providers.fake };
  c.roles = { implement: ["fake", "fake2"], review: ["fake"] };
};

const configPath = (w) => path.join(w.dir, ".nexus", "config.json");
const configText = (w) => fs.readFileSync(configPath(w), "utf8");
const nexusEntries = (w) => fs.readdirSync(path.join(w.dir, ".nexus")).sort();

test("reorders providers on disk and the next launch uses the new first provider", async () => {
  const w = await worldWithMoon("happy", withTwoProviders);
  try {
    const beforeEntries = nexusEntries(w);
    assert.deepEqual(setRoleOrder(w.g, { role: "implement", order: ["fake2", "fake"] }), {
      roles: { implement: ["fake2", "fake"], review: ["fake"] },
    });
    assert.deepEqual(JSON.parse(configText(w)).roles.implement, ["fake2", "fake"]);
    assert.deepEqual(nexusEntries(w), beforeEntries, "successful call left a temp file");

    const launched = await sendDelivery(w.g, { taskId: "T1" });
    assert.equal(w.g.db.get("voyages.byId", { id: launched.voyageId }).provider, "fake2");
  } finally { w.cleanup(); }
});

test("orders that add, drop, or repeat a provider refuse without changing the file", async (t) => {
  for (const [name, order] of [
    ["add", ["fake", "fake2", "fake3"]],
    ["drop", ["fake"]],
    ["repeat", ["fake", "fake"]],
  ]) {
    await t.test(name, async () => {
      const w = await makeGalaxy(withTwoProviders);
      try {
        const before = configText(w);
        const beforeEntries = nexusEntries(w);
        assert.throws(
          () => setRoleOrder(w.g, { role: "implement", order }),
          (err) => err instanceof Refusal && err.message === "order must contain exactly the providers listed for 'implement': fake, fake2",
        );
        assert.equal(configText(w), before);
        assert.deepEqual(nexusEntries(w), beforeEntries, "refused call left a temp file");
      } finally { w.cleanup(); }
    });
  }
});

test("starts from a hand-edited disk config and refreshes g.config", async () => {
  const w = await makeGalaxy(withTwoProviders);
  try {
    const edited = JSON.parse(configText(w));
    edited.automation.max_fix_rounds = 5;
    fs.writeFileSync(configPath(w), JSON.stringify(edited, null, 2) + "\n");

    setRoleOrder(w.g, { role: "implement", order: ["fake2", "fake"] });
    assert.equal(JSON.parse(configText(w)).automation.max_fix_rounds, 5);
    assert.equal(w.g.config.automation.max_fix_rounds, 5);
  } finally { w.cleanup(); }
});

test("an invalid disk config refuses with the validator message and leaves bytes unchanged", async () => {
  const w = await makeGalaxy(withTwoProviders);
  try {
    const invalid = JSON.parse(configText(w));
    invalid.roles.review = ["fake", "ghost"];
    fs.writeFileSync(configPath(w), JSON.stringify(invalid, null, 2) + "\n");
    const before = configText(w);
    const beforeEntries = nexusEntries(w);

    assert.throws(
      () => setRoleOrder(w.g, { role: "implement", order: ["fake2", "fake"] }),
      (err) => err instanceof Refusal && err.message === "roles.review names unknown provider 'ghost'",
    );
    assert.equal(configText(w), before);
    assert.deepEqual(nexusEntries(w), beforeEntries, "refused call left a temp file");
  } finally { w.cleanup(); }
});

test("a config write in the middle of a voyage does not open a main-tree decision", async () => {
  const w = await worldWithMoon("happy", withTwoProviders);
  try {
    const real = w.g.adapters.fake;
    w.g.adapters.fake = {
      ...real,
      dispatch(job, ctx) {
        setRoleOrder(w.g, { role: "implement", order: ["fake2", "fake"] });
        return real.dispatch(job, ctx);
      },
    };
    await sendDelivery(w.g, { taskId: "T1" });
    assert.equal(w.g.db.all("decisions.pending").filter((d) => d.kind === "main_tree_changed").length, 0);
  } finally { w.cleanup(); }
});

test("an absent roles block is filled from normalized defaults", async () => {
  const w = await makeGalaxy((c) => { delete c.roles; });
  try {
    const expected = Object.keys(w.g.config.providers);
    setRoleOrder(w.g, { role: "implement", order: [...expected].reverse() });
    assert.deepEqual(JSON.parse(configText(w)).roles, {
      implement: [...expected].reverse(),
      review: expected,
    });
  } finally { w.cleanup(); }
});

test("unparseable JSON refuses naming .nexus/config.json without leaving a temp file", async () => {
  const w = await makeGalaxy();
  try {
    fs.writeFileSync(configPath(w), "{ nope\n");
    const before = configText(w);
    const beforeEntries = nexusEntries(w);
    assert.throws(
      () => setRoleOrder(w.g, { role: "implement", order: ["fake"] }),
      (err) => err instanceof Refusal && err.message.includes(".nexus/config.json"),
    );
    assert.equal(configText(w), before);
    assert.deepEqual(nexusEntries(w), beforeEntries, "refused call left a temp file");
  } finally { w.cleanup(); }
});
