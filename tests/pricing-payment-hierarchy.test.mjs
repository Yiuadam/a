/*
  One card, two ways to pay, and one of them is the default.

  A card subscription and a wallet pass cannot be merged into a single button:
  Alipay and WeChat Pay cannot take a recurring charge, and Stripe refuses to put
  a subscription and a one-off on the same Checkout Session. So the page has to
  make the choice for whoever does not want to make it, and the owner's decision
  is that the recurring card subscription is the default: dominant, labelled so
  that it is obvious it renews, with the wallets visible but plainly secondary.

  Two things this pins, and both have been got wrong here before.

  The hierarchy. Two equal-weight buttons asked every reader to decide something
  most had no basis for deciding.

  The height. The payment controls must be reachable without scrolling — that
  complaint has been raised once already and is what the three desktop compaction
  tiers in app/globals.css exist for. A second tier of controls is exactly the
  kind of change that quietly undoes them, so the rules that pay for it are
  asserted here rather than trusted.

  Source assertions strip comments first: a comment describing the old layout must
  not be able to satisfy a test about the new one.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const read = (...parts) => readFileSync(join(process.cwd(), ...parts), "utf8");
const strip = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

const plans = strip(read("app", "pricing", "PricingPlans.tsx"));
const css = read("app", "globals.css");

/* ------------------------------------------------------------ hierarchy -- */

test("the subscription is the primary control and says on itself that it renews", () => {
  assert.match(
    plans,
    /className="pricing-subscribe-button btn-primary w-full"/,
    "the subscription is no longer the dominant, full-width control",
  );
  /*
    The label carries the word. Somebody who reads nothing else on the card reads
    the thing they are about to press, and "Subscribe" alone does not say that
    money leaves again next month.
  */
  assert.match(plans, /renews \$\{plan\.interval === "year" \? "yearly" : "monthly"\}/);
  assert.doesNotMatch(plans, /"Subscribe by card"/, "the old label said nothing about renewing");
});

test("the wallet alternative is secondary — a text link, not a second button", () => {
  const wallet = plans.slice(
    plans.indexOf("pricing-wallet-alternative"),
    plans.indexOf("pricing-wallet-terms"),
  );
  assert.ok(wallet.length > 0, "the wallet control is gone");
  assert.doesNotMatch(
    wallet,
    /btn-primary|btn-secondary/,
    "the wallet control is styled as an equal-weight button again",
  );
  assert.match(wallet, /underline/, "a secondary control still has to look pressable");
});

test("the wallet alternative is visible rather than hidden behind a tap", () => {
  /*
    Secondary is not the same as concealed. Somebody with no card that works here
    — the ordinary case for a candidate paying from the mainland — has to find it
    on the first read, so it may not go inside a <details> or a menu.
  */
  const action = plans.slice(plans.indexOf("function PayControls"));
  assert.doesNotMatch(action, /<details|<summary/, "the wallet option needs a tap to discover");
  assert.doesNotMatch(action, /hidden|sr-only/, "the wallet option is hidden from sight");
});

test("the subscription comes first in the card, and the wallets after it", () => {
  const subscribe = plans.indexOf("pricing-subscribe-button");
  const wallet = plans.indexOf("pricing-wallet-alternative");
  assert.ok(subscribe > -1 && wallet > -1);
  assert.ok(subscribe < wallet, "the wallet alternative is drawn above the subscribe button");
});

/* ----------------------------------------------------------------- copy -- */

test("the subscription's own print carries all four renewal facts", () => {
  const terms = plans.slice(
    plans.indexOf("pricing-card-terms"),
    plans.indexOf("pricing-subscribe-button"),
  );
  assert.match(terms, /\{cardPrice\}/, "the amount");
  assert.match(terms, /every \{period\}/, "how often");
  assert.match(terms, /renewing automatically until you cancel/, "that it keeps going");
  assert.match(terms, /billing page/, "how to make it stop");
  assert.match(terms, /\/terms/, "and where the rest of it is");
});

test("the pass says it does not renew and what happens when it ends", () => {
  const terms = plans.slice(plans.indexOf("pricing-wallet-terms"));
  assert.match(terms, /does not renew/);
  assert.match(terms, /back to Free/, "a pass that simply stops must say what it stops into");
});

test("each control starts its own kind of Checkout Session", () => {
  assert.match(plans, /onStart\("\/api\/billing\/checkout", \{ plan: planId \}\)/);
  assert.match(plans, /onStart\("\/api\/billing\/wallet-checkout", \{ plan: planId \}\)/);
  /*
    Both modes stay exactly as they were. `mode: subscription` for the card is
    what every existing subscriber renews under, and nothing on this page may
    quietly move the card onto the prepaid lane.
  */
  const stripe = strip(read("lib", "billing", "stripe.ts"));
  assert.match(stripe, /mode: "subscription"/);
  assert.match(stripe, /mode: "payment"/);
});

/* --------------------------------------------------------------- height -- */

test("the compaction that pays for the second control is in the stylesheet", () => {
  /*
    Measured on the built app: with these rules the whole card fits above the fold
    at 1280x800 and 1280x720, and at 390x844 both controls and the pass's print do.
    Without them the pass line falls off a 720p laptop, which is where the reader
    who most needs a wallet is least likely to find one.
  */
  const short = css.slice(css.indexOf("@media (min-width: 640px) and (max-height: 860px)"));
  assert.match(short, /\.pricing-wallet-alternative/, "the wallet block never gives up any air");
  assert.match(short, /\.pricing-wallet-terms/);

  const shorter = css.slice(css.indexOf("@media (min-width: 640px) and (max-height: 780px)"));
  assert.match(shorter, /\.pricing-card-terms/, "neither block of print tightens on a 720p laptop");

  /*
    And the phone rule that actually applies. `.card.card` sets 1.5rem of padding
    later in the file, so the long-standing two-class `.pricing-plan-card.card`
    phone padding loses on source order and does nothing; the triple-class version
    is what brings the bottom of the card inside a 390x844 viewport.
  */
  const phone = css.slice(
    css.indexOf("@media (max-width: 639px)"),
    css.indexOf("@media (max-width: 639px) and (max-height: 720px)"),
  );
  assert.match(phone, /\.pricing-plan-card\.card\.card \{\s*padding-bottom/);
});

test("nothing in the card row can end on a different element", () => {
  /*
    Every card ends on the same thing — the pass line when the wallets are
    offered, the subscribe button when they are not — because a row of cards whose
    buttons sit at four different heights reads as broken. That is why both blocks
    of print sit above their own control rather than below it.
  */
  const cardTerms = plans.indexOf("pricing-card-terms");
  const subscribe = plans.indexOf("pricing-subscribe-button");
  const walletButton = plans.indexOf("pricing-wallet-button");
  const walletTerms = plans.indexOf("pricing-wallet-terms");
  assert.ok(cardTerms < subscribe, "the renewal terms must precede the button that agrees to them");
  assert.ok(walletButton < walletTerms, "the pass line is the last thing in the card");
});
