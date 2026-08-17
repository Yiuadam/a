/*
  The Worker's deploy configuration cannot delete the Worker's configuration.

  Wrangler's default is that the config file is the only source of truth for
  environment variables: every deploy deletes the ones on the Worker and then
  writes whatever `vars` says. wrangler.jsonc has no `vars` block, so on this
  project that default is purely destructive — it deletes and writes nothing
  back.

  It has taken production down twice. The first time it removed ADMIN_USERNAME.
  The second time it removed ADMIN_USERNAME, ACCOUNTS_ENABLED and all six
  Stripe price ids at once, which locked the owner out of admin and closed
  subscriptions on a live site — on a deploy that reported success, with no
  error in any log, because deleting a variable is what Wrangler was asked to
  do.

  `keep_vars: true` is the whole fix, and it is one line, which is exactly why
  it needs a test: a one-line setting with a long comment above it is the kind
  of thing that gets tidied away by somebody who does not know what it cost.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/* Comments are legal in wrangler.jsonc and JSON.parse does not allow them. */
function readJsonc(path) {
  const text = readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"])\/\/.*$/gm, "$1");
  return JSON.parse(text);
}

const config = readJsonc("wrangler.jsonc");

test("deploys keep the Worker's dashboard variables", () => {
  assert.equal(
    config.keep_vars,
    true,
    "wrangler.jsonc must set keep_vars: true, or the next deploy deletes " +
      "ACCOUNTS_ENABLED, ADMIN_USERNAME and every STRIPE_PRICE_* on the live Worker.",
  );
});

/*
  If configuration ever does move into the file, it has to move *completely*.

  A half-migration is worse than either end state: `vars` present but partial
  means the deploy now has an opinion about variables, and with keep_vars the
  two sources disagree silently instead of loudly. This test does not forbid a
  `vars` block — it insists that adding one is a deliberate act that comes here
  and says which variables the file now owns.
*/
test("no half-migrated vars block", () => {
  if (config.vars === undefined) return;
  assert.ok(
    Object.keys(config.vars).length > 0,
    "an empty vars block says nothing and reads like configuration that went missing",
  );
});

test("production has enough CPU for server-rendered Next.js routes", () => {
  assert.equal(
    config.limits?.cpu_ms,
    30_000,
    "removing this restores the account default; on Workers Free that is 10 ms and causes Error 1102",
  );
});

/*
  The wallet methods live in configuration, not in the dashboard.

  They were set in the dashboard first and never reached the Worker: the button
  kept offering Alipay alone while /api/billing/config answered `["alipay"]`,
  through two dashboard deploys. A deploy's configuration diff then showed the
  variable being removed, `keep_vars: true` notwithstanding.

  What is pinned here is only what matters: the value is in this file, so it
  cannot be lost to a deploy, and every method named in it is one the catalogue
  recognises. Stripe refuses an entire Session that lists a method the account
  has not activated, so a typo here does not add a wallet — it removes the
  working one.
*/
test("the wallet methods are configured in wrangler.jsonc", () => {
  const value = config.vars?.STRIPE_WALLET_METHODS;
  assert.equal(
    typeof value,
    "string",
    "STRIPE_WALLET_METHODS belongs in wrangler.jsonc, where a deploy cannot strip it",
  );
  const named = value.split(",").map((part) => part.trim());
  assert.ok(named.length > 0, "an empty list disables the wallet button entirely");
  for (const method of named) {
    assert.match(
      method,
      /^(alipay|wechat_pay)$/,
      `"${method}" is not a wallet method lib/billing/env.ts recognises, ` +
        "and an unrecognised entry is silently dropped rather than failing loudly",
    );
  }
});
