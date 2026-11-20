// The job a ship does is a delivery. "Freighter" is a hull and a formation name in the catalogue, and the class of ships
// registered before migration 003; it is never the page's or the server's own word for the job.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
// Where the word is data: catalogue entries, old migrations, the legacy class map, and the ignored `fleet.freighters` config key.
const ALLOWED = ["src/core/catalogue/", "src/db/migrations/", "src/core/fleet.ts", "src/config/schema.ts"];

function files(dir) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    return entry.isDirectory() ? files(rel) : [rel];
  });
}

test("no server or page source calls the job a freighter", () => {
  const offenders = [];
  for (const file of [...files("src"), ...files("web/src"), ...files("prompts")]) {
    if (ALLOWED.some((allowed) => file === allowed || file.startsWith(allowed))) continue;
    const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
    lines.forEach((line, index) => { if (/freighter/i.test(line)) offenders.push(`${file}:${index + 1}: ${line.trim().slice(0, 100)}`); });
  }
  assert.deepEqual(offenders, [], "say \"delivery\" (the job) or \"delivery ship\"; a freighter is one hull in the catalogue");
});

test("the allow-list is not stale: each allowed place still uses the word as data", () => {
  for (const allowed of ALLOWED) {
    const list = allowed.endsWith("/") ? files(allowed.slice(0, -1)) : [allowed];
    assert.ok(list.some((file) => /freighter/i.test(fs.readFileSync(path.join(root, file), "utf8"))), `${allowed} no longer needs to be allowed`);
  }
});
