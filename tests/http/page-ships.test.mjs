import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const shipsPath = path.join(root, "web", "src", "ships.ts");
const shipsSource = await readFile(shipsPath, "utf8");
const temporary = await mkdtemp(path.join(os.tmpdir(), "aether-ships-"));
let shipsModule;
try {
  await writeFile(path.join(temporary, "ships.mts"), shipsSource);
  await writeFile(path.join(temporary, "tsconfig.json"), JSON.stringify({
    compilerOptions: { module: "esnext", target: "es2022", skipLibCheck: true, noCheck: true, outDir: "out" },
    files: ["ships.mts"],
  }));
  execFileSync(process.execPath, [
    path.join(root, "node_modules", "typescript", "bin", "tsc"),
    "-p", path.join(temporary, "tsconfig.json"),
  ]);
  shipsModule = await import(`${pathToFileURL(path.join(temporary, "out", "ships.mjs"))}?v=${Date.now()}`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}

const { asCargo, asFormation, asVoyageShip, formationText, sortShips, voyageSentence } = shipsModule;

test("formation text", () => {
  assert.equal(formationText({ name: "Carrier group", vessels: [
    { hull: "carrier", count: 1, role: "lead" },
    { hull: "frigate", count: 4, role: "escort" },
  ] }), "Carrier group (1 carrier, 4 frigates)");
  assert.equal(formationText({ name: "Mining vessel", vessels: [{ hull: "mining vessel", count: 1, role: "lead" }] }), "Mining vessel (1 mining vessel)");
  assert.equal(formationText({ name: "Ship", vessels: [] }), "Ship");
});

test("voyage sentence", () => {
  const ship = { name: "Kestrel", faction: "anthropic", formation_name: "Carrier group" };
  assert.equal(voyageSentence({ ship, cargo: { label: "a diplomat" } }), "Kestrel — carrier group (anthropic), carrying a diplomat");
  assert.equal(voyageSentence({ ship, cargo: null }), "Kestrel — carrier group (anthropic)");
  assert.equal(voyageSentence({ ship: null, cargo: { label: "a diplomat" } }), null);
});

test("ships sort by catalogue weight then name without mutation", () => {
  const input = [
    { name: "Zed", weight: "light" },
    { name: "Beta", weight: "unknown" },
    { name: "Alpha", weight: "heavy" },
    { name: "Able", weight: "light" },
  ];
  const before = input.slice();
  const sorted = sortShips(input, ["light", "standard", "heavy"]);
  assert.notEqual(sorted, input);
  assert.deepEqual(input, before);
  assert.deepEqual(sorted.map((ship) => ship.name), ["Able", "Zed", "Alpha", "Beta"]);
  assert.deepEqual(sortShips(input, []).map((ship) => ship.name), ["Able", "Alpha", "Beta", "Zed"]);
});

test("ship data readers accept valid shapes", () => {
  assert.deepEqual(asVoyageShip({ name: "Kestrel", faction: "a", weight: "heavy", formation_name: "Group" }),
    { name: "Kestrel", faction: "a", weight: "heavy", formation_name: "Group" });
  assert.deepEqual(asCargo({ id: "cargo-1", label: "a diplomat" }), { id: "cargo-1", label: "a diplomat" });
  assert.deepEqual(asFormation({ id: "group", name: "Group", vessels: [
    { hull: "ship", count: 1, role: "lead" }, { hull: "bad", count: "two", role: "escort" },
  ] }), { id: "group", name: "Group", vessels: [{ hull: "ship", count: 1, role: "lead" }] });
});

test("ship data readers reject malformed shapes", () => {
  const common = [null, undefined, "x", []];
  for (const value of common) {
    assert.equal(asVoyageShip(value), null);
    assert.equal(asCargo(value), null);
    assert.equal(asFormation(value), null);
  }
  for (const value of [{ faction: "a", weight: "light", formation_name: "Group" }, { name: 1, faction: "a", weight: "light", formation_name: "Group" }]) assert.equal(asVoyageShip(value), null);
  for (const value of [{ label: "cargo" }, { id: "c", label: 1 }]) assert.equal(asCargo(value), null);
  for (const value of [{ name: "Group", vessels: [] }, { id: "g", name: "Group", vessels: "none" }]) assert.equal(asFormation(value), null);
});

test("page components use ship identity helpers", async () => {
  const components = path.join(root, "web", "src", "components");
  const sources = Object.fromEntries(await Promise.all(["Fleet.tsx", "SystemView.tsx", "MoonDetail.tsx"].map(async (name) => [name, await readFile(path.join(components, name), "utf8")])));
  for (const source of Object.values(sources)) assert.match(source, /from ["']\.\.\/ships["']/);
  for (const name of ["SystemView.tsx", "MoonDetail.tsx"]) assert.ok(sources[name].includes("voyageSentence"));
  assert.ok(sources["Fleet.tsx"].includes("sortShips"));
  assert.ok(sources["Fleet.tsx"].includes("formationText"));
});

test("built page carries ship identity copy and styles", async () => {
  const assets = path.join(root, "dist", "web", "assets");
  const names = await readdir(assets);
  const bundle = (await Promise.all(names.filter((name) => name.endsWith(".js")).map((name) => readFile(path.join(assets, name), "utf8")))).join("\n");
  const css = (await Promise.all(names.filter((name) => name.endsWith(".css")).map((name) => readFile(path.join(assets, name), "utf8")))).join("\n");
  assert.ok(bundle.includes(", carrying "));
  assert.ok(bundle.includes(" trips"));
  assert.ok(css.includes("voyage-ship"));
});

test("page wording avoids fleet-wide hull copy", async () => {
  const paths = [
    "tests/http/page-ships.test.mjs", "web/src/ships.ts", "web/src/types.ts",
    "web/src/components/Fleet.tsx", "web/src/components/SystemView.tsx", "web/src/components/MoonDetail.tsx", "web/src/style.css",
  ];
  const sources = await Promise.all(paths.map((name) => readFile(path.join(root, name), "utf8")));
  const assets = path.join(root, "dist", "web", "assets");
  const names = await readdir(assets);
  sources.push(...await Promise.all(names.map((name) => readFile(path.join(assets, name), "utf8"))));
  const forbidden = new RegExp(`${["freighters?", "in", "fleet"].join(" ")}|${["all", "freighters"].join(" ")}`, "i");
  for (const source of sources) assert.doesNotMatch(source, forbidden);
  assert.doesNotMatch(shipsSource, /freighter|carrier/i);
});

test("the fleet panel hands each ship row to its line unchanged", async () => {
  const source = await readFile(path.join(root, "web", "src", "components", "Fleet.tsx"), "utf8");
  // a copied row with a stringified weight printed the word "undefined" for a row from an older server
  assert.doesNotMatch(source, /String\(\s*ship\[["']weight["']\]\s*\)/);
  assert.doesNotMatch(source, /\.\.\.ship\b/);
  // and a snapshot with no weight list must not take the panel down
  assert.match(source, /Array\.isArray\(\s*snapshot\.weights\s*\)/);
  assert.match(source, /<Ship b=\{b\} ship=\{entry\.ship\}/);
});
