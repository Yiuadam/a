import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pricing = readFileSync(new URL("../app/pricing/PricingPlans.tsx", import.meta.url), "utf8");

test("returning from Stripe resets the stale checkout loading state", () => {
  assert.match(pricing, /const onPageShow = \(\) => setBusy\(false\)/);
  assert.match(pricing, /window\.addEventListener\("pageshow", onPageShow\)/);
  assert.match(pricing, /window\.removeEventListener\("pageshow", onPageShow\)/);
});
