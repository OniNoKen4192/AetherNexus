import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalize = (text) => text.replace(/\s+/g, " ").trim();

function ruleBody(css, selector) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const match = rules.find(([, selectors]) =>
    selectors.split(",").some((candidate) => normalize(candidate) === selector),
  );
  assert.ok(match, `style.css is missing exact selector ${selector}`);
  return normalize(match[2]);
}

test("waiting labels have readable wrapping and spacing without changing shared styles", async () => {
  const css = await readFile("web/src/style.css", "utf8");

  assert.match(ruleBody(css, ".system-moons .row:has(> .waiting-label)"), /(?:^|; )flex-wrap: wrap(?:;|$)/);

  const waitingLabel = ruleBody(css, ".waiting-label");
  assert.match(waitingLabel, /(?:^|; )max-width: 100%(?:;|$)/);
  assert.match(waitingLabel, /(?:^|; )white-space: normal(?:;|$)/);
  assert.match(waitingLabel, /(?:^|; )overflow-wrap: anywhere(?:;|$)/);
  const radius = waitingLabel.match(/(?:^|; )border-radius: (\d+)px(?:;|$)/);
  assert.ok(radius, ".waiting-label must declare border-radius in whole pixels");
  assert.ok(Number(radius[1]) >= 4 && Number(radius[1]) <= 12);

  const detailLabel = ruleBody(css, ".moon-detail > .waiting-label");
  assert.match(detailLabel, /(?:^|; )display: block(?:;|$)/);
  assert.match(detailLabel, /(?:^|; )width: fit-content(?:;|$)/);
  assert.match(detailLabel, /(?:^|; )margin-bottom: 4px(?:;|$)/);

  assert.equal(ruleBody(css, ".row"), normalize("display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 4px; cursor: pointer;"));
  assert.equal(ruleBody(css, ".badge"), normalize("display: inline-block; padding: 0 7px; border-radius: 999px; border: 1px solid var(--border); font-size: 12px; color: var(--muted);"));
});
