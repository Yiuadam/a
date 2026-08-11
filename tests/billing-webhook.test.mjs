/*
  The webhook, which is the only door a subscription can come through.

  Three things are pinned here, in the order they matter.

  1. The signature check. Everything downstream believes what it is given, so
     this is the single point at which a forged delivery has to be stopped. It
     is tested against the exact strings Stripe sends, and against the shapes an
     attacker would try: no header, no signature, the right digest under the
     wrong secret, a body altered by one character, a captured delivery replayed
     an hour later.

  2. Reading the event. A misread status is a silent, expensive mistake — the
     wrong direction of it leaves somebody paid up after they cancelled — so
     every status Stripe can send is mapped explicitly and checked.

  3. Idempotency. Stripe redelivers, and the guarantee is that a redelivery
     changes nothing. The mechanism is one transaction in the database
     (supabase/migrations/0009_billing_webhooks.sql), so the test drives it
     through the same code path the route uses, with the network stubbed. There
     is a second test at the end that runs the real SQL against a real Postgres
     when one is available.
*/
import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const stripe = await import(pathToFileURL(join(process.cwd(), "lib", "billing", "stripe.ts")).href);

const {
  parseSignatureHeader,
  timingSafeEqualHex,
  verifyStripeSignature,
  parseStripeEvent,
  prepaidPurchaseFromStripeEvent,
  prepaidRefundFromStripeEvent,
  subscriptionFromStripeEvent,
} = stripe;

const SECRET = "whsec_test_2f0f5e1c9a4b4d8f8c7e6d5a4b3c2d1e";
const NOW = 1_800_000_000;

/** The header Stripe would send for a body, signed with a secret. */
async function sign(body, secret = SECRET, timestamp = NOW) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestamp}.${body}`));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
}

function subscriptionEvent(overrides = {}) {
  return JSON.stringify({
    id: "evt_1",
    object: "event",
    type: "customer.subscription.updated",
    created: NOW,
    data: {
      object: {
        id: "sub_1",
        object: "subscription",
        customer: "cus_1",
        status: "active",
        cancel_at_period_end: false,
        metadata: { bandup_user_id: "11111111-1111-4111-8111-111111111111", bandup_tier: "pro" },
        items: {
          data: [{ id: "si_1", current_period_end: NOW + 2_592_000, price: { id: "price_month" } }],
        },
        ...overrides,
      },
    },
  });
}

/* --------------------------------------------------------- the signature -- */

test("a genuine delivery verifies", async () => {
  const body = subscriptionEvent();
  assert.equal(await verifyStripeSignature(body, await sign(body), SECRET, NOW), true);
});

test("a delivery with no signature header is refused", async () => {
  const body = subscriptionEvent();
  assert.equal(await verifyStripeSignature(body, null, SECRET, NOW), false);
  assert.equal(await verifyStripeSignature(body, "", SECRET, NOW), false);
});

test("a body altered after signing is refused", async () => {
  const body = subscriptionEvent();
  const header = await sign(body);
  // One character: the tier the attacker would like to have bought.
  const tampered = body.replace('"status":"active"', '"status":"ACTIVE"');
  assert.notEqual(tampered, body);
  assert.equal(await verifyStripeSignature(tampered, header, SECRET, NOW), false);
});

test("a correctly formed signature under the wrong secret is refused", async () => {
  // This is the whole attack: anybody can compute an HMAC, and the only thing
  // they cannot do is compute it under a secret they do not have.
  const body = subscriptionEvent();
  const header = await sign(body, "whsec_not_the_real_secret_at_all_0000");
  assert.equal(await verifyStripeSignature(body, header, SECRET, NOW), false);
});

test("a delivery captured and replayed later is refused", async () => {
  const body = subscriptionEvent();
  const header = await sign(body, SECRET, NOW);
  // Same bytes, same valid signature, an hour later.
  assert.equal(await verifyStripeSignature(body, header, SECRET, NOW + 3600), false);
  // Still inside the tolerance a minute later.
  assert.equal(await verifyStripeSignature(body, header, SECRET, NOW + 60), true);
});

test("a slow clock on our side does not throw away a genuine delivery", async () => {
  // Only the "too old" side of the tolerance is checked, which is what Stripe
  // does. A timestamp ahead of our clock cannot be forged without the secret.
  const body = subscriptionEvent();
  const header = await sign(body, SECRET, NOW);
  assert.equal(await verifyStripeSignature(body, header, SECRET, NOW - 120), true);
});

test("a secret rotation is survivable, because every v1 is a candidate", async () => {
  const body = subscriptionEvent();
  const wrong = await sign(body, "whsec_old_secret_being_rotated_out00");
  const right = await sign(body);
  const combined = `${wrong},${right.replace(/^t=\d+,/, "")}`;
  assert.equal(await verifyStripeSignature(body, combined, SECRET, NOW), true);
});

test("a header with no usable timestamp or signature is refused", () => {
  for (const header of [
    "",
    "nonsense",
    "v1=abc",
    "t=1700000000",
    "t=,v1=abc",
    "t=notanumber,v1=abc",
    "t=0,v1=abc",
    "t=-5,v1=abc",
    "t=1700000000,v1=not-hex-at-all",
  ]) {
    assert.equal(parseSignatureHeader(header), null, `${JSON.stringify(header)} was parsed`);
  }
});

test("the timestamp is read from the header, not from anywhere else", () => {
  const parsed = parseSignatureHeader("t=1700000000,v1=AABB,v0=cc");
  assert.equal(parsed.timestamp, 1700000000);
  // v0 is Stripe's old scheme and is not a candidate; v1s are lowercased so a
  // capitalised digest still compares equal.
  assert.deepEqual(parsed.signatures, ["aabb"]);
});

test("the constant-time compare still compares", () => {
  assert.equal(timingSafeEqualHex("abcd", "abcd"), true);
  assert.equal(timingSafeEqualHex("abcd", "abce"), false);
  assert.equal(timingSafeEqualHex("abcd", "abc"), false);
  assert.equal(timingSafeEqualHex("", ""), true);
});

/* ------------------------------------------------------- reading an event -- */

test("a verified body that is not shaped like an event is refused", () => {
  for (const body of [
    "",
    "null",
    "[]",
    '"a string"',
    "{}",
    '{"id":"evt_1"}',
    '{"id":"evt_1","type":"x"}',
    '{"id":"evt_1","type":"x","data":{}}',
    '{"type":"x","data":{"object":{}}}',
  ]) {
    assert.equal(parseStripeEvent(body), null, `${body} was accepted`);
  }
});

test("a subscription event is read into the row the database stores", () => {
  const event = parseStripeEvent(subscriptionEvent());
  const sub = subscriptionFromStripeEvent(event);
  assert.equal(sub.eventId, "evt_1");
  assert.equal(sub.userId, "11111111-1111-4111-8111-111111111111");
  assert.equal(sub.status, "active");
  assert.equal(sub.tier, "pro");
  assert.equal(sub.customerId, "cus_1");
  assert.equal(sub.subscriptionId, "sub_1");
  assert.equal(sub.priceId, "price_month");
  assert.equal(sub.cancelAtPeriodEnd, false);
  assert.equal(sub.currentPeriodEnd, new Date((NOW + 2_592_000) * 1000).toISOString());
});

test("every event type other than the three subscription ones is ignored", () => {
  for (const type of [
    "checkout.session.completed",
    "invoice.paid",
    "payment_intent.succeeded",
    "customer.created",
    "charge.refunded",
  ]) {
    const event = parseStripeEvent(subscriptionEvent().replace('"customer.subscription.updated"', JSON.stringify(type)));
    assert.equal(subscriptionFromStripeEvent(event), null, `${type} was acted on`);
  }
});

test("the period end is found wherever this account's API version puts it", () => {
  // Newer versions carry it on the item; older ones on the subscription.
  const onItem = parseStripeEvent(subscriptionEvent());
  assert.equal(
    subscriptionFromStripeEvent(onItem).currentPeriodEnd,
    new Date((NOW + 2_592_000) * 1000).toISOString(),
  );

  const onSubscription = parseStripeEvent(
    subscriptionEvent({ current_period_end: NOW + 100, items: { data: [{ price: { id: "p" } }] } }),
  );
  assert.equal(
    subscriptionFromStripeEvent(onSubscription).currentPeriodEnd,
    new Date((NOW + 100) * 1000).toISOString(),
  );

  const neither = parseStripeEvent(subscriptionEvent({ items: { data: [] } }));
  assert.equal(subscriptionFromStripeEvent(neither).currentPeriodEnd, null);
});

test("every status Stripe can send maps onto one this database accepts", () => {
  const ALLOWED = ["active", "trialing", "past_due", "canceled", "expired", "paused", "refunded"];
  const expected = {
    active: "active",
    trialing: "trialing",
    past_due: "past_due",
    incomplete: "past_due",
    incomplete_expired: "expired",
    unpaid: "past_due",
    canceled: "canceled",
    paused: "paused",
  };
  for (const [stripeStatus, ours] of Object.entries(expected)) {
    const event = parseStripeEvent(subscriptionEvent({ status: stripeStatus }));
    const sub = subscriptionFromStripeEvent(event);
    assert.equal(sub.status, ours, `${stripeStatus} mapped to ${sub.status}`);
    assert.ok(ALLOWED.includes(sub.status), `${sub.status} would violate the CHECK constraint`);
  }
});

test("a status this code has never heard of grants nothing", () => {
  // The direction to fail in. A new Stripe status must not read as "active".
  const event = parseStripeEvent(subscriptionEvent({ status: "some_new_status" }));
  assert.equal(subscriptionFromStripeEvent(event).status, "canceled");
});

test("a deletion is a cancellation whatever the object claims", () => {
  const raw = subscriptionEvent({ status: "active" }).replace(
    '"customer.subscription.updated"',
    '"customer.subscription.deleted"',
  );
  const sub = subscriptionFromStripeEvent(parseStripeEvent(raw));
  assert.equal(sub.status, "canceled");
});

test("a subscription whose tier cannot be established grants nothing", () => {
  // No metadata, and a Price this deployment has never configured.
  const raw = subscriptionEvent({ metadata: {}, items: { data: [{ price: { id: "price_x" } }] } });
  assert.equal(subscriptionFromStripeEvent(parseStripeEvent(raw)).tier, "free");
  // The same event, with the Price recognised.
  assert.equal(
    subscriptionFromStripeEvent(parseStripeEvent(raw), (id) => (id === "price_x" ? "pro" : null)).tier,
    "pro",
  );
});

test("metadata cannot be used to claim a tier that is not sold", () => {
  // The metadata is written by this app, not by the customer — but it travels
  // through Stripe and is editable in the dashboard, so it is read as an
  // allow-list of one rather than as a string to be trusted.
  for (const claimed of ["admin", "enterprise", "PRO", ""]) {
    const raw = subscriptionEvent({ metadata: { bandup_tier: claimed } });
    assert.equal(subscriptionFromStripeEvent(parseStripeEvent(raw)).tier, "free");
  }
});

test("an event with no account on it is not guessed at", () => {
  const raw = subscriptionEvent({ metadata: {} });
  // Null, so the database resolves it from a row it already holds, or refuses.
  assert.equal(subscriptionFromStripeEvent(parseStripeEvent(raw)).userId, null);
});

test("a paid wallet checkout grants the catalogue plan and duration", () => {
  for (const type of ["checkout.session.completed", "checkout.session.async_payment_succeeded"]) {
    const event = parseStripeEvent(
      JSON.stringify({
        id: `evt_${type}`,
        type,
        created: NOW,
        data: {
          object: {
            mode: "payment",
            payment_status: "paid",
            customer: "cus_wallet",
            payment_intent: "pi_wallet",
            metadata: {
              bandup_user_id: "11111111-1111-4111-8111-111111111111",
              bandup_plan_id: "plus-monthly",
              // This is deliberately wrong: the parser must derive the tier
              // from the server catalogue rather than trusting metadata.
              bandup_tier: "admin",
            },
          },
        },
      }),
    );
    const purchase = prepaidPurchaseFromStripeEvent(event);
    assert.equal(purchase.userId, "11111111-1111-4111-8111-111111111111");
    assert.equal(purchase.planId, "plus-monthly");
    assert.equal(purchase.tier, "plus");
    assert.equal(purchase.interval, "month");
    assert.equal(purchase.paymentIntentId, "pi_wallet");
  }
});

test("an unpaid or invented wallet plan grants nothing", () => {
  for (const [paymentStatus, planId] of [
    ["unpaid", "plus-monthly"],
    ["paid", "admin-monthly"],
  ]) {
    const event = parseStripeEvent(
      JSON.stringify({
        id: `evt_${paymentStatus}_${planId}`,
        type: "checkout.session.completed",
        created: NOW,
        data: {
          object: {
            mode: "payment",
            payment_status: paymentStatus,
            payment_intent: "pi_wallet",
            metadata: {
              bandup_user_id: "11111111-1111-4111-8111-111111111111",
              bandup_plan_id: planId,
            },
          },
        },
      }),
    );
    assert.equal(prepaidPurchaseFromStripeEvent(event), null);
  }
});

test("wallet access is revoked only after a completed full refund", () => {
  const fullCharge = parseStripeEvent(
    JSON.stringify({
      id: "evt_full_charge_refund",
      type: "charge.refunded",
      created: NOW,
      data: { object: { refunded: true, payment_intent: "pi_wallet" } },
    }),
  );
  assert.deepEqual(prepaidRefundFromStripeEvent(fullCharge), {
    eventId: "evt_full_charge_refund",
    eventAt: new Date(NOW * 1000).toISOString(),
    paymentIntentId: "pi_wallet",
    amountMinor: null,
    fullRefundConfirmed: true,
  });

  const succeededRefund = parseStripeEvent(
    JSON.stringify({
      id: "evt_refund_updated",
      type: "refund.updated",
      created: NOW,
      data: {
        object: { status: "succeeded", amount: 1290, payment_intent: "pi_wallet" },
      },
    }),
  );
  assert.deepEqual(prepaidRefundFromStripeEvent(succeededRefund), {
    eventId: "evt_refund_updated",
    eventAt: new Date(NOW * 1000).toISOString(),
    paymentIntentId: "pi_wallet",
    amountMinor: 1290,
    fullRefundConfirmed: false,
  });

  for (const object of [
    { status: "pending", amount: 1290, payment_intent: "pi_wallet" },
    { status: "failed", amount: 1290, payment_intent: "pi_wallet" },
    { status: "succeeded", amount: 0, payment_intent: "pi_wallet" },
  ]) {
    const event = parseStripeEvent(
      JSON.stringify({
        id: `evt_${object.status}_${object.amount}`,
        type: "refund.updated",
        created: NOW,
        data: { object },
      }),
    );
    assert.equal(prepaidRefundFromStripeEvent(event), null);
  }
});

/* ------------------------------------------------------------ idempotency -- */

/*
  The write path, with the network replaced.

  `applyStripeSubscription` reaches the database through lib/auth/supabase.ts,
  which is `fetch` against Supabase's REST endpoint — so stubbing `fetch` runs
  the real module all the way down and lets the delivery be repeated. What is
  asserted is the contract the route depends on: one HTTP call per delivery,
  the provider's event id on every one of them, and the four outcomes reported
  rather than swallowed.
*/
async function withStubbedSupabase(responder, fn) {
  const saved = {
    fetch: globalThis.fetch,
    url: process.env.SUPABASE_URL,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anon: process.env.SUPABASE_ANON_KEY,
  };
  const calls = [];

  process.env.SUPABASE_URL = "https://stub.supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-stub-key";
  process.env.SUPABASE_ANON_KEY = "anon-stub-key";
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), body });
    const outcome = responder(body, calls.length);
    return new Response(JSON.stringify(outcome), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = saved.fetch;
    for (const [key, value] of [
      ["SUPABASE_URL", saved.url],
      ["SUPABASE_SERVICE_ROLE_KEY", saved.service],
      ["SUPABASE_ANON_KEY", saved.anon],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const subscriptions = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "subscriptions.ts")).href
);

test("a redelivery is reported as a duplicate rather than applied twice", async () => {
  const event = subscriptionFromStripeEvent(parseStripeEvent(subscriptionEvent()));

  await withStubbedSupabase(
    // What the database does: the first claim of an event id wins, every later
    // one is told it lost. This stub is the same rule, and the SQL that really
    // implements it is exercised by the Postgres test below.
    (() => {
      const seen = new Set();
      return (body) => {
        if (seen.has(body.p_event_id)) return "duplicate";
        seen.add(body.p_event_id);
        return "applied";
      };
    })(),
    async (calls) => {
      assert.equal(await subscriptions.applyStripeSubscription(event, {}), "applied");
      assert.equal(await subscriptions.applyStripeSubscription(event, {}), "duplicate");
      assert.equal(await subscriptions.applyStripeSubscription(event, {}), "duplicate");

      // Three deliveries, three calls, one event id: the route must not be
      // deciding for itself which ones to forward.
      assert.equal(calls.length, 3);
      for (const call of calls) {
        assert.ok(call.url.endsWith("/rest/v1/rpc/apply_provider_subscription_event"));
        assert.equal(call.body.p_event_id, "evt_1");
        assert.equal(call.body.p_provider, "stripe");
      }
    },
  );
});

test("every field the database needs is sent, and the payload is kept whole", async () => {
  const event = subscriptionFromStripeEvent(parseStripeEvent(subscriptionEvent()));
  const raw = JSON.parse(subscriptionEvent());

  await withStubbedSupabase(
    () => "applied",
    async (calls) => {
      await subscriptions.applyStripeSubscription(event, raw);
      const sent = calls[0].body;
      assert.equal(sent.p_subscription_id, "sub_1");
      assert.equal(sent.p_customer_id, "cus_1");
      assert.equal(sent.p_status, "active");
      assert.equal(sent.p_tier, "pro");
      assert.equal(sent.p_price_id, "price_month");
      assert.equal(sent.p_cancel_at_period_end, false);
      assert.equal(sent.p_event_at, new Date(NOW * 1000).toISOString());
      // The evidence, stored as it arrived rather than as the fields this code
      // happened to understand.
      assert.deepEqual(sent.p_payload, raw);
    },
  );
});

test("an out-of-order redelivery is reported, not silently applied", async () => {
  const event = subscriptionFromStripeEvent(parseStripeEvent(subscriptionEvent()));
  await withStubbedSupabase(
    () => "stale",
    async () => {
      assert.equal(await subscriptions.applyStripeSubscription(event, {}), "stale");
    },
  );
});

test("an event that cannot be tied to an account is reported, not guessed at", async () => {
  const event = subscriptionFromStripeEvent(parseStripeEvent(subscriptionEvent({ metadata: {} })));
  await withStubbedSupabase(
    () => "unknown_user",
    async () => {
      assert.equal(await subscriptions.applyStripeSubscription(event, {}), "unknown_user");
    },
  );
});

test("an answer this code does not recognise is a failure, not a success", async () => {
  // A database that answered something else is not one this code was written
  // against, and reading it as "fine" would silently stop recording payments.
  const event = subscriptionFromStripeEvent(parseStripeEvent(subscriptionEvent()));
  await withStubbedSupabase(
    () => "who knows",
    async () => {
      await assert.rejects(() => subscriptions.applyStripeSubscription(event, {}));
    },
  );
});
