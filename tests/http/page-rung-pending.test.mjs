import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const withoutCarriageReturns = (text) => text.split(String.fromCharCode(13)).join("");

test("the confirmation line is held by its own state, not by the live count", async () => {
  const source = withoutCarriageReturns(await readFile("web/src/components/Header.tsx", "utf8"));
  assert.ok(source.includes("const [confirming, setConfirming] = useState(false);"), "Header.tsx does not declare the confirming state");
  assert.ok(source.includes("{confirming && ("), "the confirmation line is not rendered from confirming alone");
  assert.ok(!source.includes("> 0 && ("), "a render guard in Header.tsx still depends on a count being above zero");
  assert.ok(!source.includes("{snapshot.ready_to_send}"), "the line prints the raw ready_to_send instead of the normalised number");
});

test("the rung selector can shrink inside its label", async () => {
  const css = withoutCarriageReturns(await readFile("web/src/style.css", "utf8"));
  const start = css.indexOf(".rung-control .field {");
  assert.notEqual(start, -1, "style.css has no .rung-control .field rule");
  const rule = css.slice(start, css.indexOf("}", start));
  assert.ok(rule.includes("min-width: 0"), "the .rung-control .field rule does not declare min-width: 0");
});
