import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const gaugeSource = await readFile(path.join(root, "web", "src", "gauge.ts"), "utf8");
const temporary = await mkdtemp(path.join(os.tmpdir(), "aether-fuel-"));
await writeFile(path.join(temporary, "gauge.ts"), gaugeSource);
await writeFile(path.join(temporary, "types.ts"), "export type PoolView = any;\n");
await writeFile(path.join(temporary, "tsconfig.json"), JSON.stringify({
  compilerOptions: { module: "esnext", target: "es2022", skipLibCheck: true, noCheck: true, outDir: "out" },
  files: ["gauge.ts", "types.ts"],
}));
execFileSync(process.execPath, [
  path.join(root, "node_modules", "typescript", "bin", "tsc"),
  "-p", path.join(temporary, "tsconfig.json"),
]);
const modulePath = path.join(temporary, "out", "gauge.js");
const { ageText, timeText, gaugeText, familyLines, meterValue } = await import(`${pathToFileURL(modulePath)}?v=${Date.now()}`);

process.on("exit", () => { void rm(temporary, { recursive: true, force: true }); });

const nowMs = new Date(2026, 10, 18, 12, 0, 0).getTime();
const reset = new Date(nowMs + 60 * 60_000).toISOString();
const localTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

test("ageText", () => {
  assert.deepEqual(
    [0, 59_000, 60_000, 3_599_000, 3_600_000, 47 * 3_600_000, 48 * 3_600_000, -5, NaN].map(ageText),
    ["0s", "59s", "1m", "59m", "1h", "47h", "2d", "0s", "0s"],
  );
});

test("timeText", () => {
  assert.equal(timeText(reset, nowMs), localTime(reset));
  const later = new Date(nowMs + 3 * 86_400_000).toISOString();
  assert.equal(timeText(later, nowMs), new Date(later).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }));
  assert.equal(timeText("soon", nowMs), "soon");
});

test("ok", () => {
  const pool = { state: "ok", remaining: 0.72, reserve_floor: 0.1, resets_at: reset, reading_ts: new Date(nowMs - 3 * 60_000).toISOString() };
  assert.equal(gaugeText(pool, nowMs), `72% left · resets ${localTime(reset)} · read 3m ago · floor 10%`);
});

test("low", () => {
  const pool = { state: "low", remaining: 0.05, reserve_floor: 0.1, resets_at: reset, reading_ts: new Date(nowMs - 3 * 60_000).toISOString() };
  assert.equal(gaugeText(pool, nowMs), `5% left · resets ${localTime(reset)} · read 3m ago · floor 10% · below floor`);
});

test("missing fields", () => {
  assert.equal(gaugeText({ state: "ok", remaining: 0.72, reserve_floor: 0.1 }, nowMs), "72% left · floor 10%");
  for (const pool of [{ state: "ok", reserve_floor: 0.1 }, { state: "low" }]) {
    assert.doesNotMatch(gaugeText(pool, nowMs), /NaN|undefined|null|Invalid Date/);
  }
});

test("dry, unknown, free", () => {
  assert.equal(gaugeText({ state: "dry", until: reset }, nowMs), `dry until ${localTime(reset)}`);
  assert.equal(gaugeText({ state: "dry" }, nowMs), "dry");
  assert.equal(gaugeText({ state: "unknown", reserve_floor: 0.25 }, nowMs), "unknown · floor 25%");
  assert.equal(gaugeText({ state: "free" }, nowMs), "free");
});

test("familyLines", () => {
  const windows = [
    { window: "5h", used: 0.2 },
    { window: "weekly", used: 0.6, model_family: "opus" },
    { window: "weekly", used: 1.4, model_family: "sonnet" },
  ];
  assert.deepEqual(familyLines({ windows }), ["opus: 40% left", "sonnet: 0% left"]);
});

test("meterValue", () => {
  assert.equal(meterValue({ state: "ok", remaining: 0.72 }), 0.72);
  assert.equal(meterValue({ state: "low", remaining: 1.7 }), 1);
  assert.equal(meterValue({ state: "dry" }), 0);
  assert.equal(meterValue({ state: "unknown" }), null);
  assert.equal(meterValue({ state: "free" }), null);
});

test("the page uses the fuel gauge declarations", async () => {
  const fleet = await readFile(path.join(root, "web", "src", "components", "Fleet.tsx"), "utf8");
  const types = await readFile(path.join(root, "web", "src", "types.ts"), "utf8");
  assert.match(fleet, /from ["']\.\.\/gauge["']/);
  for (const copy of ["pools", "<meter", "aria-label"]) assert.ok(fleet.includes(copy));
  for (const copy of ["pools", "PoolView", "FuelWait", "RefuelOffer", "refuel_for"]) assert.ok(types.includes(copy));
  const imports = gaugeSource.match(/^import .*$/gm) ?? [];
  assert.ok(imports.every((line) => line.startsWith("import type ")));
});

test("the built page carries the fuel copy", async () => {
  const assets = path.join(root, "dist", "web", "assets");
  const names = await readdir(assets);
  const scripts = names.filter((name) => name.endsWith(".js"));
  const styles = names.filter((name) => name.endsWith(".css"));
  const bundle = (await Promise.all(scripts.map((name) => readFile(path.join(assets, name), "utf8")))).join("\n");
  const css = (await Promise.all(styles.map((name) => readFile(path.join(assets, name), "utf8")))).join("\n");
  for (const copy of ["% left", "below floor", "dry until", "unknown", "floor "]) assert.ok(bundle.includes(copy), `bundle lacks ${copy}`);
  for (const name of ["gauge-ok", "gauge-low", "gauge-dry", "gauge-unknown", "gauge-free"]) {
    assert.ok(bundle.includes(name), `bundle lacks ${name}`);
    assert.ok(css.includes(name), `stylesheet lacks ${name}`);
  }
});

test("fuel wording does not make moons run out", async () => {
  const sources = await Promise.all([
    gaugeSource,
    readFile(path.join(root, "web", "src", "components", "Fleet.tsx"), "utf8"),
    readFile(path.join(root, "web", "src", "types.ts"), "utf8"),
  ]);
  for (const source of sources) assert.doesNotMatch(source, /moon is out of fuel|moon ran out|moon hit the wall/i);
});
