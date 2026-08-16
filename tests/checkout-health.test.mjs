/*
  The morning of 16 August, encoded as a test.

  bandup.life could not take a payment and had not been able to for an unknown
  length of time: the Stripe secret key had been rolled and the Worker never
  given the replacement, so every checkout was refused with `api_key_expired`.
  The learner's message is deliberately vague and stays that way; the reason
  lived only in a Worker log; the owner found it by accident.

  Two things had to become true to stop that happening again, and both are
  asserted here.

  1. A refusal Stripe made about *us* is told apart from a refusal about the
     person paying, and only the first is loud.
  2. The owner's console asks whether a learner could buy something right now,
     rather than whether Stripe answers the phone, and says so in a way nobody
     can read past.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

register("./alias-resolve.mjs", import.meta.url);

const faults = await import(
  pathToFileURL(join(process.cwd(), "lib", "billing", "faults.ts")).href
);

const { CHECKOUT_CHECK_NAME, billingLogLine, classifyStripeRefusal, faultOf, logBillingFailure } =
  faults;

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");

/* ---------------------------------------------------------------- blame -- */

test("the failure that actually happened is the owner's, loudly", () => {
  assert.equal(
    classifyStripeRefusal(401, "api_key_expired", "Expired API Key provided: sk_live_***"),
    "platform",
  );
  assert.equal(classifyStripeRefusal(401, null, null), "platform");
  assert.equal(classifyStripeRefusal(403, "api_key_expired", null), "platform");
});

test("configuration Stripe cannot resolve is the owner's", () => {
  // A Price id that names nothing: the plan→Price mapping on the Worker is
  // stale, or points at the other account.
  assert.equal(
    classifyStripeRefusal(400, "resource_missing", "No such price: 'price_gone'"),
    "platform",
  );
  // A wallet Stripe has not approved. This once took Alipay down with it.
  assert.equal(classifyStripeRefusal(400, "payment_method_not_available", null), "platform");
  assert.equal(
    classifyStripeRefusal(400, null, "The payment method type wechat_pay is not activated."),
    "platform",
  );
  // A parameter only this application chooses.
  assert.equal(classifyStripeRefusal(400, "parameter_invalid_integer", null), "platform");
});

test("Stripe being down is nobody's fault and still stops every sale, so it is loud", () => {
  assert.equal(classifyStripeRefusal(500, null, null), "platform");
  assert.equal(classifyStripeRefusal(503, null, null), "platform");
  assert.equal(classifyStripeRefusal(429, null, null), "platform");
});

test("a bank saying no is not a fault at all", () => {
  assert.equal(classifyStripeRefusal(402, "card_declined", "Your card was declined."), "learner");
  assert.equal(classifyStripeRefusal(402, "insufficient_funds", null), "learner");
  assert.equal(classifyStripeRefusal(400, "checkout_session_expired", null), "learner");
});

test("an unrecognised refusal is loud, because api_key_expired was unrecognised once too", () => {
  assert.equal(classifyStripeRefusal(400, "some_code_stripe_adds_next_year", null), "platform");
  assert.equal(classifyStripeRefusal(400, null, null), "platform");
});

/* ------------------------------------------------------------ log lines -- */

test("only the owner's failures carry the marker a log search can find", () => {
  const loud = billingLogLine("platform", "billing/checkout", "api_key_expired");
  const quiet = billingLogLine("learner", "billing/checkout", "card_declined");
  assert.match(loud, /PAYMENTS-BROKEN/);
  assert.doesNotMatch(quiet, /PAYMENTS-BROKEN/);
});

test("anything thrown that is not classified is treated as ours", () => {
  assert.equal(faultOf(new Error("timeout")), "platform");
  assert.equal(faultOf(null), "platform");
  assert.equal(faultOf({ fault: "learner" }), "learner");
});

test("logBillingFailure writes one line and reports which kind it was", () => {
  const original = console.error;
  const lines = [];
  console.error = (line) => lines.push(line);
  try {
    const declined = Object.assign(new Error("/checkout/sessions refused: card_declined"), {
      fault: "learner",
    });
    assert.equal(logBillingFailure("billing/checkout", declined), "learner");
    const expired = Object.assign(new Error("/checkout/sessions refused: api_key_expired"), {
      fault: "platform",
    });
    assert.equal(logBillingFailure("billing/checkout", expired), "platform");
  } finally {
    console.error = original;
  }
  assert.equal(lines.length, 2);
  assert.doesNotMatch(lines[0], /PAYMENTS-BROKEN/);
  assert.match(lines[1], /PAYMENTS-BROKEN/);
  assert.match(lines[1], /api_key_expired/);
});

/* ------------------------------------------------- the probe and its home */

test("both checkout routes classify their failures instead of logging one flat line", () => {
  for (const route of ["checkout", "wallet-checkout"]) {
    const source = read("app", "api", "billing", route, "route.ts");
    assert.match(
      source,
      /logBillingFailure\(/,
      `${route} must classify its Stripe failures`,
    );
  }
});

test("a signed-out visitor is answered without being logged as a failure", () => {
  const source = read("app", "api", "billing", "checkout", "route.ts");
  const signIn = source.slice(source.indexOf("signInFirst") - 400, source.indexOf("signInFirst"));
  assert.doesNotMatch(signIn, /logBillingFailure|logInternal/);
});

test("the console's verdict comes from the same aggregation the workflows call", () => {
  /*
    One source of truth. `billingHealth` is what the post-deploy step and the
    hourly watch ask; the console asking a second, differently written question
    would be two health checks that can disagree, and the one nobody is looking
    at would be the one that was right.
  */
  const source = read("app", "api", "account", "diagnostics", "route.ts");
  assert.match(source, /billingHealth\(\)/);
  assert.match(source, /CHECKOUT_CHECK_NAME/);
  // And Stripe's own words, for the admin who has to fix it.
  assert.match(source, /stripeDiagnostic\(\)/);
});

test("an hourly watch asks the live site, because a key expires without a deploy", () => {
  const source = read(".github", "workflows", "billing-health.yml");
  const workflow = yaml.load(source, { schema: yaml.JSON_SCHEMA });
  const schedule = workflow.on.schedule;
  assert.ok(Array.isArray(schedule) && schedule.length === 1, "one schedule");
  // Hourly. Anything rarer and the site can be unable to sell for most of a
  // day; anything more often is noise on a failure measured in days.
  assert.match(schedule[0].cron, /^\d+ \* \* \* \*$/);
  assert.ok(workflow.on.workflow_dispatch !== undefined, "runnable by hand after a key rotation");

  const run = workflow.jobs.check.steps[0].run;
  // The same endpoint as the post-deploy check, not a second implementation.
  assert.match(run, /\/api\/billing\/health/);
  assert.match(run, /bandup\.siksafe-realtime-ai-vision\.workers\.dev/);
  // Retried before it wakes anybody, and a genuine failure fails the run —
  // which is what sends the owner an email.
  assert.match(run, /max_attempts/);
  assert.match(run, /sleep/);
  assert.match(run, /exit 1/);
  // The public endpoint carries no reasons, so neither may this log.
  assert.doesNotMatch(run, /STRIPE|sk_live/);
});

test("the console draws checkout failure above everything else, and nothing when it is fine", () => {
  const parts = read("components", "admin", "ConsoleParts.tsx");
  assert.match(parts, /export function CheckoutAlarm/);
  // Absent unless true: a banner that is always there is furniture.
  assert.match(parts, /if \(!checkout \|\| checkout\.ok\) return null;/);
  assert.match(parts, /role="alert"/);

  const overview = read("app", "admin", "page.tsx");
  assert.match(overview, /<CheckoutAlarm checks=\{checks\} \/>/);
  // Above the four numbers, not below them.
  assert.ok(
    overview.indexOf("<CheckoutAlarm") < overview.indexOf("Registered accounts"),
    "the alarm must come before the stat cards",
  );
  // And the phone menu names it rather than counting it.
  assert.match(overview, /"Checkout failing"/);
});

test("the check has one name, shared by the server that writes it and the screen that reads it", () => {
  assert.equal(CHECKOUT_CHECK_NAME, "Checkout");
  const parts = read("components", "admin", "ConsoleParts.tsx");
  assert.match(parts, /CHECKOUT_CHECK_NAME/);
  assert.doesNotMatch(parts, /c\.name === "Checkout"/);
});

test("nothing Stripe said is ever handed to a caller", () => {
  /*
    ACCOUNTS.md, threat 7. The classifier and the log line are for the server;
    the routes answer with a fixed sentence from lib/billing/messages.ts. This
    pins that the checkout routes never put an error's own text in a response.
  */
  for (const route of ["checkout", "wallet-checkout"]) {
    const source = read("app", "api", "billing", route, "route.ts");
    assert.doesNotMatch(source, /NextResponse\.json\([^)]*err\b/);
    assert.doesNotMatch(source, /safeJsonError\([^)]*err\b/);
  }
});
