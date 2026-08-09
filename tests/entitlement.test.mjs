/*
  The access token is the only thing standing between a stranger and the Claude
  bill, and since plans arrived it also decides how much of that bill a paying
  learner may run up. It is the kind of code that looks right while being wrong
  — a signature checked over the wrong bytes, an expiry compared the wrong way
  round, a plan a client can edit upward — and none of that is visible by
  reading it. These pin the properties the paywall actually depends on.
*/
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

process.env.BILLING_TOKEN_SECRET = "test-secret-not-used-anywhere-real";

register("../scripts/ts-resolve.mjs", import.meta.url);

const load = (name) =>
  import(pathToFileURL(join(process.cwd(), "lib", `${name}.ts`)).href);

const {
  REFRESH_GRACE_SECONDS,
  TTL_SECONDS,
  mintAccessToken,
  safeEqual,
  verifyAccessToken,
} = await load("entitlement");

const { PLANS, PLAN_IDS, isPlanId, planForPriceId, priceIdFor } = await load("plans");

const PERIOD = 1_770_000_000;

/** Run `fn` as if the clock had jumped forward by `seconds`. */
function atOffset(seconds, fn) {
  const real = Date.now;
  Date.now = () => real() + seconds * 1000;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

test("a freshly minted token verifies and carries plan and period back", () => {
  const { claims, failure } = verifyAccessToken(mintAccessToken("cus_123", "plus", PERIOD));
  assert.equal(failure, undefined);
  assert.equal(claims.ref, "cus_123");
  assert.equal(claims.plan, "plus");
  assert.equal(claims.ps, PERIOD);
});

test("a learner cannot promote themselves to a bigger plan", () => {
  // The whole quota system rests on this: if the plan in the token were
  // editable, every allowance would be whatever the client claimed.
  const token = mintAccessToken("cus_123", "standard", PERIOD);
  const mac = token.slice(token.lastIndexOf(".") + 1);
  const forged = Buffer.from(
    JSON.stringify({ v: 2, ref: "cus_123", plan: "pro", ps: PERIOD, e: 2 ** 40 }),
    "utf8",
  ).toString("base64url");

  assert.equal(verifyAccessToken(`${forged}.${mac}`).failure, "invalid");
  assert.equal(verifyAccessToken(token).claims.plan, "standard");
});

test("a learner cannot rewind the billing period to refill their allowance", () => {
  // Quota keys are (customer, period start). An editable period start would be
  // an unlimited plan.
  const token = mintAccessToken("cus_123", "plus", PERIOD);
  const mac = token.slice(token.lastIndexOf(".") + 1);
  const forged = Buffer.from(
    JSON.stringify({ v: 2, ref: "cus_123", plan: "plus", ps: PERIOD + 99, e: 2 ** 40 }),
    "utf8",
  ).toString("base64url");

  assert.equal(verifyAccessToken(`${forged}.${mac}`).failure, "invalid");
});

test("a token signed with another secret is rejected", () => {
  const token = mintAccessToken("cus_123", "pro", PERIOD);
  const real = process.env.BILLING_TOKEN_SECRET;
  process.env.BILLING_TOKEN_SECRET = "a-different-secret";
  try {
    assert.equal(verifyAccessToken(token).failure, "invalid");
  } finally {
    process.env.BILLING_TOKEN_SECRET = real;
  }
});

test("a token naming a plan that does not exist is rejected", () => {
  const claims = { v: 2, ref: "cus_123", plan: "unlimited", ps: PERIOD, e: 2 ** 40 };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  // Signed correctly, so only the plan check can catch it.
  assert.equal(verifyAccessToken(`${payload}.anything`).failure, "invalid");
});

test("v1 tokens from before plans existed are refused outright", () => {
  const claims = { v: 1, k: "sub", ref: "cus_123", e: 2 ** 40 };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  assert.equal(verifyAccessToken(`${payload}.anything`).failure, "invalid");
});

test("a token expires, and refresh may still read it", () => {
  const token = mintAccessToken("cus_123", "plus", PERIOD);

  atOffset(TTL_SECONDS + 60, () => {
    assert.equal(verifyAccessToken(token).failure, "expired");
    // The refresh path trusts the signature but not the subscription, so it
    // must still be able to read who this was.
    assert.equal(verifyAccessToken(token, true).claims.ref, "cus_123");
  });
});

test("an abandoned token stops being refreshable", () => {
  const token = mintAccessToken("cus_123", "standard", PERIOD);

  atOffset(TTL_SECONDS + REFRESH_GRACE_SECONDS + 60, () => {
    assert.equal(verifyAccessToken(token, true).failure, "stale");
  });
});

test("the constant-time compare still answers the question correctly", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "ab"), false);
  assert.equal(safeEqual("", ""), true);
});

test("plans are ordered so an upgrade is always a bigger number", () => {
  const ranks = PLAN_IDS.map((id) => PLANS[id].rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
  assert.equal(new Set(ranks).size, ranks.length);
});

test("every plan allows strictly more than the one below it", () => {
  // A higher tier that gave less of something would make the upgrade prompt a
  // lie, and nothing else in the system would notice.
  for (let i = 1; i < PLAN_IDS.length; i++) {
    const lower = PLANS[PLAN_IDS[i - 1]].allowance;
    const higher = PLANS[PLAN_IDS[i]].allowance;
    for (const meter of ["marking", "generation", "lookup"]) {
      assert.ok(
        higher[meter] > lower[meter],
        `${PLAN_IDS[i]}.${meter} (${higher[meter]}) must exceed ${PLAN_IDS[i - 1]}.${meter} (${lower[meter]})`,
      );
    }
  }
});

test("a Stripe price maps back to the plan it sells", () => {
  process.env.STRIPE_PRICE_PLUS_QUARTERLY = "price_plus_q";
  try {
    assert.equal(priceIdFor("plus", "quarterly"), "price_plus_q");
    assert.equal(planForPriceId("price_plus_q"), "plus");
    assert.equal(planForPriceId("price_someone_elses"), null);
  } finally {
    delete process.env.STRIPE_PRICE_PLUS_QUARTERLY;
  }
});

test("an unconfigured price sells nothing rather than guessing", () => {
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
  assert.equal(priceIdFor("pro", "monthly"), null);
  assert.equal(isPlanId("pro"), true);
  assert.equal(isPlanId("enterprise"), false);
});
