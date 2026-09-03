/*
  The free Pro trial.

  Three things are worth pinning, and they are the three that would fail
  silently. Who is offered it: a Pro subscriber or the owner must never be shown
  an offer of what they already have. What the poster says: the sentence about
  the trial being able to end is the reason ending it later is fair, so its
  absence is a defect rather than a copy change. And that nothing in this
  feature writes a migration — the constraint it depends on is applied by hand.
*/
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const promo = await import(pathToFileURL(join(root, "lib", "billing", "promo.ts")).href);
const tiers = await import(pathToFileURL(join(root, "lib", "billing", "tiers.ts")).href);

const poster = readFileSync(join(root, "components", "billing", "FreeProPoster.tsx"), "utf8");
const route = readFileSync(join(root, "app", "api", "billing", "promo", "route.ts"), "utf8");
const supabase = readFileSync(join(root, "lib", "auth", "supabase.ts"), "utf8");

test("only tiers below Pro are offered the trial", () => {
  for (const tier of Object.keys(tiers.TIERS)) {
    const covered = promo.alreadyCovered(tier);
    assert.equal(covered, tier === "pro" || tier === "admin", `wrong answer for ${tier}`);
  }
});

test("the poster says the trial can end and that nobody is charged", () => {
  assert.match(poster, /may be cancelled at any time in the future/);
  assert.match(poster, /back to the free plan/);
  assert.match(poster, /never be charged without choosing to subscribe/);
});

test("the poster does not manufacture urgency", () => {
  for (const pattern of [/\bhurry\b/i, /\blimited time\b/i, /\bends (?:in|soon)\b/i, /\bonly \d+ /i]) {
    assert.doesNotMatch(poster, pattern, `poster uses pressure: ${pattern}`);
  }
});

test("a guest sees the pitch and a sign-up button, not nothing", () => {
  // Shown to everyone now, not only a signed-in account with a resolved
  // eligibility answer — a guest cannot be asked "are you offered this",
  // so the pitch itself draws instead of an empty render while that
  // question cannot yet be answered.
  assert.match(poster, /if \(!session\) \{/);
  assert.match(poster, /import SignInLink from "@\/components\/account\/SignInLink";/);
  assert.match(poster, /<SignInLink[\s\S]*?Sign up free/);
});

test("a dismissed reader sees nothing, signed in or not", () => {
  assert.match(poster, /if \(dismissed\) return null;/);
});

test("accepting for a guest means signing up, and the accept continues automatically afterward", () => {
  const code = poster.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const store = readFileSync(join(root, "lib", "billing", "free-pro-offer.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  // The intent is recorded where the guest taps, which is still the poster...
  assert.match(code, /rememberAutoAcceptIntent\(\)/);
  // ...and read back — exactly once — once a session exists to act on it.
  assert.match(store, /const autoAccept = consumeAutoAcceptIntent\(\);/);
  assert.match(store, /if \(autoAccept\) void acceptFreePro\(\);/);
});

/*
  The grant must not depend on anything being on screen.

  It used to: the eligibility request and the read-and-clear of the guest's
  intent both lived in the poster's own effect, so continuing a guest's accept
  was a side effect of rendering that component. Once the offer is also
  announced somewhere that mounts lazily — a popover — that arrangement drops
  grants silently, which is the worst way to lose one.

  So the continuation lives in a module with no markup in it, started by the
  shell that is mounted on every route and on every platform.
*/
test("the accept continuation does not depend on the offer being rendered", () => {
  const store = readFileSync(join(root, "lib", "billing", "free-pro-offer.ts"), "utf8");
  const shell = readFileSync(join(root, "components", "AppMain.tsx"), "utf8");

  /*
    It is a .ts module, not .tsx, and imports nothing from react — so it cannot
    render and cannot be unmounted. That is the property that matters: a grant
    that depends on a component being alive is a grant that can be missed.
  */
  assert.ok(existsSync(join(root, "lib", "billing", "free-pro-offer.ts")));
  assert.ok(!existsSync(join(root, "lib", "billing", "free-pro-offer.tsx")));
  assert.doesNotMatch(store, /from "react"/);
  assert.match(store, /export function startFreeProOffer\(/);
  assert.match(shell, /startFreeProOffer\(\)/);

  // And the component that draws it no longer owns either half.
  const code = poster.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /consumeAutoAcceptIntent/);
  assert.doesNotMatch(code, /api\/billing\/promo/);
});

/*
  Everywhere the offer is announced has to lead somewhere that exists.

  The iOS app draws its own header and has no bell, and /pricing and /billing
  are removed from that bundle entirely — so an offer that lived only in the
  notification inbox would ship to no iOS user at all. /account is in the
  bundle and in the navigation, and it is already where the trial is given up.
*/
test("the offer is reachable wherever it is announced", () => {
  const panel = readFileSync(join(root, "components", "AccountPanel.tsx"), "utf8");
  const inbox = readFileSync(join(root, "components", "account", "NotificationInbox.tsx"), "utf8");
  const bell = readFileSync(join(root, "components", "account", "NotificationBell.tsx"), "utf8");
  const nav = readFileSync(join(root, "lib", "nav.ts"), "utf8");

  /* The offer itself, on the page the trial also ends on — and in BOTH arms of
     that page, because a guest is who a free trial on a new account is for. */
  assert.equal(panel.match(/<FreeProPoster \/>/g)?.length, 2);
  const signedOutArm = panel.slice(panel.indexOf("<SignedOut"));
  assert.match(panel.slice(0, panel.indexOf("<SignedOut")), /<FreeProPoster \/>/);
  assert.match(signedOutArm, /<FreeProPoster \/>/);
  assert.match(panel, /<GiveUpFreeProSection/);
  // Which is in the navigation, so it is reachable without a bell.
  assert.match(nav, /href: "\/account"/);

  // The announcements point at it rather than carrying the terms themselves.
  assert.match(inbox, /function FreeProReminder/);
  assert.match(inbox, /href="\/account"/);
  // Including for a visitor with no account, who used to get a dead end here.
  assert.match(bell, /freePro \? \(/);
  assert.match(bell, /Read the offer/);
});

test("the grant is a Pro subscription row, written only by the server", () => {
  assert.match(supabase, /provider: PROMO_PROVIDER/);
  assert.match(supabase, /tier: "pro"/);
  assert.match(supabase, /status: "active"/);
  // The tier is fixed in server code. Nothing the client sends chooses it.
  assert.doesNotMatch(route, /req\.json\(\)/);
});

test("accepting degrades honestly when the provider constraint is still narrow", () => {
  assert.match(supabase, /export async function promoProviderAllowed/);
  assert.match(route, /notOpen/);
  // 503 with a sentence, never an unhandled throw turning into a 500.
  assert.match(route, /safeJsonError\(PROMO_MESSAGES\.notOpen, 503\)/);
});

test("the trial ships no migration of its own", () => {
  const migrations = readdirSync(join(root, "supabase", "migrations"));
  const named = migrations.filter((file) => /promo/i.test(file));
  assert.deepEqual(named, [], "the widening ALTER is run by hand, not shipped as a migration");
});

/*
  Telling a paying subscriber that the thing they pay for is currently free.

  The owner chose to tell them and let them decide, rather than cancelling or
  refunding on their behalf. That choice only means anything if the sentence
  actually reaches them, so what is pinned here is that it draws for a payer,
  that it does not draw for anyone holding Pro without paying, and that it says
  the awkward part — that they may cancel and take the trial instead.

  Every assertion below runs against the source with comments stripped. An
  earlier test in this repository passed against a comment quoting the code it
  was meant to be checking, which is worth not repeating.
*/

/** The file's code, without comments or string-free prose to match by accident. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const notice = readFileSync(
  join(root, "components", "billing", "PayingWhileFreeNotice.tsx"),
  "utf8",
);
const billingPage = readFileSync(join(root, "app", "billing", "page.tsx"), "utf8");

test("a signed-out reader is never told they are paying", async () => {
  // No database is reachable in this test, so a false here also proves the
  // signed-out path answers without asking one.
  assert.equal(await promo.payingWhileFree(null, null), false);
  assert.equal(await promo.payingWhileFree(null, "someone@example.com"), false);
});

test("only a paying provider triggers the notice, not a role or a grant", () => {
  const source = code(readFileSync(join(root, "lib", "billing", "promo.ts"), "utf8"));
  /*
    An admin holds Pro by role and a trialist by promo grant. Neither is being
    charged, so neither is owed an apology for being charged.
  */
  assert.match(source, /entitlement\.source !== "stripe" && entitlement\.source !== "apple"/);
  assert.doesNotMatch(source, /source === "role"/);
});

test("the notice says they may cancel and take the trial instead", () => {
  /*
    Whitespace-normalised: JSX wraps a sentence wherever the line runs long, so
    matching the raw file would pin the line breaks rather than the words.
  */
  const words = notice.replace(/\s+/g, " ");
  assert.match(words, /cancel your subscription and take the free trial instead/);
  assert.match(words, /not required/);
  // The same promise the poster makes, so the two pages cannot drift apart.
  assert.match(words, /may be cancelled at any time in the future/);
});

test("the notice cannot be dismissed", () => {
  const source = code(notice);
  /*
    Unlike the poster. An offer nobody wants should stop asking; a disclosure
    that stays true should keep saying so until it stops being true.
  */
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /dismiss/i);
});

test("the notice is mounted on the billing page", () => {
  const source = code(billingPage);
  assert.match(source, /import PayingWhileFreeNotice from "@\/components\/billing\/PayingWhileFreeNotice"/);
  assert.match(source, /<PayingWhileFreeNotice \/>/);
});

test("the offer route answers the paying question without a second round trip", () => {
  const source = code(route);
  /*
    Asked only when there is nothing to offer and nothing held by grant: all
    three are mutually exclusive, so each of the three readers of this route
    costs one resolve rather than two. `grantHeld` joined the condition when
    giving the trial up arrived — a trialist is the commonest visitor to the
    account page, and it was their request that would have paid for the extra
    round trip.
  */
  assert.match(
    source,
    /offer\.offered \|\| offer\.grantHeld\s*\?\s*false\s*:\s*await payingWhileFree/,
  );
  // Every exit from GET carries every field, including the failure path.
  const get = /async function handleGET[\s\S]*?\n}/.exec(source)[0];
  const returns = get.match(/NextResponse\.json\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(returns.length >= 3, `expected every GET exit to answer, saw ${returns.length}`);
  for (const answer of returns) {
    assert.match(answer, /offered/);
    assert.match(answer, /payingWhileFree/);
    assert.match(answer, /grantHeld/);
  }
});
