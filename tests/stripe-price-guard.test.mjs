/*
  The price guard asks Stripe for the regional prices it then checks.

  `currency_options` is an expandable field on a Stripe Price. Ask for a Price
  and you get its base amount, its currency and its interval — and no regional
  prices at all, not an empty object but absent. The guard then reads
  `undefined` for every currency the catalogue advertises, compares it against a
  real number, and refuses the sale.

  That is not hypothetical. It took every checkout on the live site down with
  "we couldn't start the checkout just now", and it was invisible from both
  ends: Stripe's logs showed no failed request, because the GET succeeded and
  the refusal happened in our own code on data Stripe had never been asked to
  send.

  One query parameter, no type error if removed, and the failure it causes is a
  page that takes no money. Hence a test.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("the checkout guard expands currency_options", () => {
  /*
    The guard is two functions now — `fetchCataloguePrice` asks Stripe and
    `priceCatalogueFault` compares the answer, so the health check can run the
    same comparison the checkout path runs. Both halves are still required, and
    each is checked where it now lives rather than in one sliced function body.
  */
  const body = code(readFileSync("lib/billing/stripe.ts", "utf8"));

  const slice = (name) => {
    const start = body.indexOf(name);
    assert.ok(start > -1, `${name} is gone`);
    return body.slice(start, body.indexOf("\n}", start));
  };

  assert.match(
    slice("async function fetchCataloguePrice"),
    /expand\[\]=currency_options/,
    "without the expand, Stripe omits every regional price and the guard refuses every sale",
  );
  /* And it must still be checking them, or the expand is decoration. */
  assert.match(
    slice("export function priceCatalogueFault"),
    /currency_options/,
    "the guard no longer reads currency_options at all",
  );
  /* And the checkout preflight must still go through that comparison. */
  assert.match(
    slice("async function assertPriceMatchesCatalogue"),
    /priceCatalogueFault\(/,
    "the checkout preflight no longer runs the catalogue comparison",
  );
});

test("the setup script expands them too, or it recreates correct Prices", () => {
  const body = code(readFileSync("scripts/stripe-setup.mjs", "utf8"));
  assert.match(
    body,
    /expand\[\]=data\.currency_options/,
    "listing Prices without the expand makes every existing Price look like it has no regional prices",
  );
});
