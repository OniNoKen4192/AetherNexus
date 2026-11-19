import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const labelsPath = path.join(root, "web", "src", "labels.ts");
const labelsSource = await readFile(labelsPath, "utf8");
const temporary = await mkdtemp(path.join(os.tmpdir(), "aether-labels-"));
let labelsModule;
try {
  await writeFile(path.join(temporary, "labels.mts"), labelsSource);
  await writeFile(path.join(temporary, "types.ts"), "export type FuelWait = { provider: string; reason: string; until?: string };\nexport type RefuelOffer = { provider: string; model: string };\n");
  await writeFile(path.join(temporary, "tsconfig.json"), JSON.stringify({
    compilerOptions: { module: "esnext", target: "es2022", skipLibCheck: true, noCheck: true, outDir: "out" },
    files: ["labels.mts", "types.ts"],
  }));
  execFileSync(process.execPath, [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p", path.join(temporary, "tsconfig.json"),
  ]);
  labelsModule = await import(`${pathToFileURL(path.join(temporary, "out", "labels.mjs"))}?v=${Date.now()}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

const {
  asFuelWait, asRefuelOffer, fuelWaitText, needsAttention, overrideCommand, parkReasonHint,
  parkReasonText, refuelCommand, refuelLabel, refuelledText, sendAnywayLabel, statusText,
} = labelsModule;

test("statusText", () => {
  assert.deepEqual(["awaiting_pickup", "out_of_fuel", "adrift", ""].map(statusText), ["cargo awaiting pickup", "out of fuel", "adrift", ""]);
});

test("Park reasons", () => {
  assert.equal(parkReasonText("carryover_violations"), "contraband in the cargo");
  assert.equal(parkReasonText("baseline_tampered"), "raided by pirates");
  assert.equal(parkReasonText("rate_limited"), "rate_limited");
  assert.deepEqual(["carryover_violations", "baseline_tampered", "rate_limited", null, undefined, 7].map(needsAttention), [true, true, false, false, false, false]);
  assert.equal(parkReasonHint("carryover_violations"), "clear the files outside the task's paths from its worktree, then reply — or drop the moon");
  assert.equal(parkReasonHint("baseline_tampered"), "put the gate's state file back exactly as it was, then reply — or drop the moon");
  assert.equal(parkReasonHint("rate_limited"), null);
});

test("fuelWaitText", () => {
  assert.equal(fuelWaitText({ provider: "codex", reason: "low", until: "X" }, (iso) => `T(${iso})`), "waiting on codex fuel · resets T(X)");
  let called = false;
  assert.equal(fuelWaitText({ provider: "codex", reason: "low" }, () => { called = true; return "unused"; }), "waiting on codex fuel");
  assert.equal(called, false);
});

test("Button labels", () => {
  assert.equal(sendAnywayLabel("low"), "Send anyway");
  assert.equal(sendAnywayLabel("dry"), "Send anyway (probe)");
  assert.equal(refuelLabel({ provider: "claude", model: "claude-haiku-5-5" }), "Refuel: claude/claude-haiku-5-5");
});

test("refuelledText", () => {
  assert.equal(refuelledText({ refuel_for: "codex", provider: "claude", model: "m-cheap" }), "refuelled: claude/m-cheap");
  assert.equal(refuelledText({ refuel_for: "codex", provider: "claude", model: null }), "refuelled: claude");
  assert.equal(refuelledText({ refuel_for: null }), null);
  assert.equal(refuelledText({}), null);
});

test("Commands", () => {
  assert.deepEqual(overrideCommand(["launch", "drop"], "T1"), { name: "moon.launch", body: { taskId: "T1", override: true } });
  assert.deepEqual(overrideCommand(["inspect"], "T1"), { name: "voyage.inspect", body: { taskId: "T1", override: true } });
  assert.deepEqual(overrideCommand(["launch", "inspect"], "T1"), { name: "moon.launch", body: { taskId: "T1", override: true } });
  assert.equal(overrideCommand(["reply", "drop"], "T1"), null);
  assert.deepEqual(refuelCommand(["launch"], "T1"), { name: "moon.launch", body: { taskId: "T1", refuel: true } });
  assert.equal(refuelCommand(["inspect"], "T1"), null);
});

test("Guards", () => {
  assert.deepEqual(asFuelWait({ provider: "a", reason: "low", until: 5 }), { provider: "a", reason: "low" });
  for (const value of [null, "x", { provider: "a" }]) assert.equal(asFuelWait(value), null);
  assert.deepEqual(asRefuelOffer({ provider: "p", model: "m" }), { provider: "p", model: "m" });
  assert.equal(asRefuelOffer({ provider: "p" }), null);
});

test("The page uses them", async () => {
  const names = ["SystemView.tsx", "MoonDetail.tsx", "ActionBar.tsx"];
  const sources = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await readFile(path.join(root, "web", "src", "components", name), "utf8")])));
  for (const source of Object.values(sources)) assert.match(source, /from ["']\.\.\/labels["']/);
  for (const name of ["SystemView.tsx", "MoonDetail.tsx"]) {
    for (const copy of ["waiting_on_fuel", "park_reason", "statusText", "refuelledText"]) assert.ok(sources[name].includes(copy), `${name} lacks ${copy}`);
  }
  for (const copy of ["can_refuel", "waiting_on_fuel", "overrideCommand", "refuelCommand"]) assert.ok(sources["ActionBar.tsx"].includes(copy), `ActionBar.tsx lacks ${copy}`);
  const imports = labelsSource.match(/^import .*$/gm) ?? [];
  assert.ok(imports.every((line) => line.startsWith("import type ")));
});

test("The built page carries the copy", async () => {
  const assets = path.join(root, "dist", "web", "assets");
  const names = await readdir(assets);
  const bundle = (await Promise.all(names.filter((name) => name.endsWith(".js")).map((name) => readFile(path.join(assets, name), "utf8")))).join("\n");
  const css = (await Promise.all(names.filter((name) => name.endsWith(".css")).map((name) => readFile(path.join(assets, name), "utf8")))).join("\n");
  for (const copy of ["waiting on ", " fuel", "cargo awaiting pickup", "out of fuel", "Refuel: ", "Send anyway", "(probe)", "refuelled: ", "contraband in the cargo", "raided by pirates", "attention-label"]) assert.ok(bundle.includes(copy), `bundle lacks ${copy}`);
  assert.ok(css.includes("attention-label"), "stylesheet lacks attention-label");
});

test("Wording", async () => {
  const componentNames = ["SystemView.tsx", "MoonDetail.tsx", "ActionBar.tsx"];
  const sources = [labelsSource, ...await Promise.all(componentNames.map((name) => readFile(path.join(root, "web", "src", "components", name), "utf8")))];
  const assets = path.join(root, "dist", "web", "assets");
  const names = await readdir(assets);
  sources.push(...await Promise.all(names.filter((name) => name.endsWith(".js")).map((name) => readFile(path.join(assets, name), "utf8"))));
  for (const source of sources) assert.doesNotMatch(source, /moon is out of fuel|moon ran out|moon hit the wall|refuel the moon/i);
});

test("An attention label wraps its row instead of being squeezed", async () => {
  const css = (await readFile("web/src/style.css", "utf8")).replace(/\s+/g, " ");
  assert.ok(css.includes(".system-moons .row:has(> .attention-label) { flex-wrap: wrap; }"));
  assert.match(css, /(?:^|\} )\.attention-label \{[^}]*white-space: normal;[^}]*\}/);
  assert.match(css, /\.moon-detail > \.attention-label \{[^}]*padding: 2px 8px;[^}]*\}/);
});
