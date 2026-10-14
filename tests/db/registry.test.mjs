// the statement-registry rule (spec §3.3)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import path from "node:path";
import { repoRoot } from "../helpers.mjs";

const SQL_VERB = /^(SELECT|INSERT|UPDATE|DELETE|CREATE|PRAGMA|EXPLAIN|BEGIN|COMMIT|ROLLBACK|ANALYZE|DROP|ALTER)\s/;
const EXEMPT = new Set(["src/db/statements.ts", "src/db/open.ts", "src/db/rebuild.ts"]);
function* tsFiles(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* tsFiles(p); else if (e.name.endsWith(".ts")) yield p;
  }
}
test("all SQL lives in src/db/statements.ts (plus pragmas/migration runner in open.ts and table deletes in rebuild.ts)", () => {
  const offenders = [];
  for (const f of tsFiles(path.join(repoRoot, "src"))) {
    const rel = path.relative(repoRoot, f).replaceAll("\\", "/");
    if (EXEMPT.has(rel)) continue;
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g)) {
      if (SQL_VERB.test(m[2].trim())) offenders.push(`${rel}: ${m[2].trim().slice(0, 40)}`);
    }
  }
  assert.deepEqual(offenders, []);
});
