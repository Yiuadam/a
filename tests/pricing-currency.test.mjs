/*
  The price in the first HTML is the reader's own.

  It was not. The pricing page was prerendered at build time, so it went out
  with Hong Kong dollars in it wherever it was read; the browser then
  downloaded the bundle, asked /api/billing/config where the reader was, and
  re-rendered. Somebody in London opened the page and read HK$4.90 until that
  round trip finished — and went on reading it if scripts were blocked or the
  request failed. The owner caught it in a screenshot where one card said
  "SGD 0.99" in the price and "HK$4.90 every month" in the small print.

  Nothing here can run a Worker, so these are assertions about the wiring: the
  page reads the country while rendering, the value reaches the component, and
  the component prefers it to the base currency. The behaviour itself was
  checked against the built Worker with a CF-IPCountry header.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...p) => readFileSync(join(process.cwd(), ...p), "utf8");
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

test("the pricing page resolves the currency while rendering, not after", () => {
  const page = strip(read("app", "pricing", "page.tsx"));

  assert.match(page, /await visitorCurrency\(\)/, "the page no longer reads the visitor's region");
  assert.match(
    page,
    /export default async function PricingPage/,
    "reading a request-time header requires an async server component",
  );
  assert.match(
    page,
    /<PricingPlans initialCurrency=\{currency\}/,
    "the resolved currency never reaches the component that prints prices",
  );
});

test("the component prefers the server's answer to the base currency", () => {
  const plans = strip(read("app", "pricing", "PricingPlans.tsx"));

  const line = plans.split("\n").find((l) => l.includes("const currency ="));
  assert.ok(line, "the currency resolution has moved or been renamed");

  /*
    Order is the whole fix. `initialCurrency` has to come before the base
    currency, or the page falls back to Hong Kong dollars while it already
    knows the right answer.
  */
  const initial = line.indexOf("initialCurrency");
  const base = line.indexOf('PLANS["plus-monthly"].currency');
  assert.ok(initial > -1, "initialCurrency is not used at all");
  assert.ok(base > -1, "the base-currency fallback is gone — the iOS export needs it");
  assert.ok(initial < base, "the base currency is preferred over what the server resolved");
});

test("every price on a card is printed in the same currency", () => {
  const plans = strip(read("app", "pricing", "PricingPlans.tsx"));

  /*
    The bug that showed on screen: the big price used the resolved currency and
    the small print used the base one, so a Singapore reader saw SGD 0.99 above
    HK$4.90. Any formatPrice call pairing a plan's own amountMinor with its own
    currency is that bug returning.
  */
  const offenders = [...plans.matchAll(/formatPrice\([^)]*\)/g)]
    .map((m) => m[0].replace(/\s+/g, " "))
    .filter((call) => /amountMinor/.test(call) && /\.currency/.test(call));

  assert.deepEqual(
    offenders,
    [],
    `these print the base currency instead of the reader's:\n  ${offenders.join("\n  ")}`,
  );
});

/*
  /pricing is not in the iOS bundle — scripts/build-mobile.mjs moves it out,
  because Apple requires in-app purchase — so this guard does not fire today.
  It is pinned anyway: the next page that both wants a currency and *is*
  exported would otherwise fail the export, and the failure would arrive in a
  build rather than in a review.
*/
test("a static export has no request to read, and the guard comes first", () => {
  const region = read("lib", "billing", "region.ts");

  assert.match(region, /MOBILE_BUILD/, "the static export would call headers() and fail");
  assert.match(region, /assertServerOnly/, "next/headers must never reach a client component");

  const code = strip(region);
  const guard = code.indexOf("MOBILE_BUILD");
  const call = code.indexOf("headers()");
  assert.ok(guard > -1 && call > -1 && guard < call, "headers() is called before the export guard");
});
