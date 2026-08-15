/*
  Where a name comes from when nobody has typed one.

  Two things swapped places. The adjective-noun generator now suggests a
  *display name*, which has no shape rule and no uniqueness to satisfy; the
  *username* is taken from the local part of the learner's email address —
  everything before the @ — because the owner asked for a handle people
  recognise rather than one they have to memorise.

  That reversal is the reason for most of what follows. A username is public:
  it appears in the organisation team directory and works as a sign-in alias,
  and its shape is enforced by a CHECK constraint as well as by application
  code (lib/auth/usernames.ts). An email local part is a different language
  entirely — it may carry a +tag, capitals, characters no username allows, and
  may be two characters long or forty. So the checks below are mostly about
  what must happen to an address before it can be a handle at all, and about
  the three things that must never break on the way:

    the shape rule still holds for every derived name, or the database
      rejects a row the app thought was fine;
    two different addresses never collapse into one handle, because a handle
      is an identity and quietly merging two of them is the one unrecoverable
      mistake here;
    uniqueness survives, which means the derived name is only ever a
      *candidate* — the claim settles it, and a collision falls through to a
      suffix and then to the non-identifying generator rather than failing.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const load = (...parts) => import(pathToFileURL(join(root, ...parts)).href);
const src = (...parts) => readFileSync(join(root, ...parts), "utf8");

const {
  generateDisplayName,
  generateUsername,
  usernameFromEmail,
  usernameFromEmailAttempt,
} = await load("lib", "auth", "generated-username.ts");
const { claimable, normaliseUsername } = await load("lib", "auth", "usernames.ts");

// ---------------------------------------------------------------------------
// The username, from the address
// ---------------------------------------------------------------------------

test("an ordinary address becomes the name before the @", () => {
  assert.equal(usernameFromEmail("adam@example.com"), "adam");
  assert.equal(usernameFromEmail("adam.yiu@example.com"), "adam.yiu");
  assert.equal(usernameFromEmail("adam-yiu_2@example.com"), "adam-yiu_2");
});

test("capitals are folded, because a username has one canonical case", () => {
  // normaliseUsername lower-cases everything it is given, so a derived name
  // that kept its capitals would compare equal to itself and unequal to what
  // was actually stored.
  assert.equal(usernameFromEmail("Adam.Yiu@Example.COM"), "adam.yiu");
});

test("a +tag is routing, not identity, and does not reach the handle", () => {
  assert.equal(usernameFromEmail("adam+ielts@example.com"), "adam");
  assert.equal(usernameFromEmail("adam+@example.com"), "adam");
});

test("characters no username allows become dots rather than vanishing", () => {
  /*
    Substituted, not dropped. Dropping them would make "a!b@x" and "ab@x" —
    two different people — into the same handle "ab", and a handle is an
    identity. A dot keeps them distinct while satisfying the shape rule.
  */
  assert.equal(usernameFromEmail("a!b@example.com"), "a.b");
  assert.notEqual(usernameFromEmail("a!b@example.com"), usernameFromEmail("ab@example.com"));
});

test("runs of dots collapse and the edges are trimmed", () => {
  // A leading dot is forbidden outright by the shape rule; ".." merely reads
  // as a typo. Both are tidied rather than allowed to fail the claim later.
  assert.equal(usernameFromEmail(".adam.@example.com"), "adam");
  assert.equal(usernameFromEmail("a!!b@example.com"), "a.b");
});

test("a short local part is padded and a long one is cut", () => {
  // "al@…" is a perfectly real address, and the three-character floor has
  // nothing to do with its owner.
  const short = usernameFromEmail("al@example.com");
  assert.equal(short, "al0");
  assert.ok(short.length >= 3);

  const long = usernameFromEmail(`${"a".repeat(40)}@example.com`);
  assert.equal(long.length, 30);
});

test("every derived name satisfies the rule the database enforces", () => {
  const addresses = [
    "adam@example.com", "Adam.Yiu+ielts@example.com", "a!b@example.com",
    "al@example.com", `${"z".repeat(40)}@example.com`, ".x.@example.com",
    "a_b-c.d@example.com", "123@example.com",
  ];
  for (const address of addresses) {
    const derived = usernameFromEmail(address);
    assert.ok(derived, `${address} should yield a username`);
    assert.equal(normaliseUsername(derived), derived, `${derived} must already be canonical`);
    assert.ok(claimable(derived, null).ok, `${derived} must be claimable`);
    // Rule 2 in lib/auth/usernames.ts, the load-bearing one: an @ would let a
    // username shadow somebody's address in the single sign-in field.
    assert.ok(!derived.includes("@"));
  }
});

test("an address that cannot make a handle says so instead of guessing", () => {
  // Reserved: "admin" is impersonation, not a collision, so it must not be
  // handed out merely because somebody owns admin@.
  assert.equal(usernameFromEmail("admin@example.com"), null);
  assert.equal(usernameFromEmail("support@example.com"), null);
  // Nothing usable left after cleaning, and malformed input.
  assert.equal(usernameFromEmail("!!!@example.com"), null);
  assert.equal(usernameFromEmail("@example.com"), null);
  assert.equal(usernameFromEmail("no-at-sign"), null);
  assert.equal(usernameFromEmail(null), null);
  assert.equal(usernameFromEmail(undefined), null);
});

// ---------------------------------------------------------------------------
// Uniqueness
// ---------------------------------------------------------------------------

test("two providers sharing a local part each get a distinct handle", () => {
  /*
    THE COLLISION. adam@gmail and adam@outlook are two people who both want
    "adam". The first claim wins; the second falls to the next attempt, which
    must be a *different* name rather than the same one again — otherwise the
    loop in app/api/account/profile/route.ts spins through its attempts and
    gives up on an account that could perfectly well have been created.
  */
  const first = usernameFromEmailAttempt("adam@gmail.com", 0);
  const second = usernameFromEmailAttempt("adam@outlook.com", 1);
  const third = usernameFromEmailAttempt("adam@yahoo.com", 2);

  assert.equal(first, "adam");
  assert.equal(second, "adam2");
  assert.equal(third, "adam3");
  assert.equal(new Set([first, second, third]).size, 3);
});

test("a suffix never pushes a long handle past the limit", () => {
  const suffixed = usernameFromEmailAttempt(`${"a".repeat(40)}@example.com`, 1);
  assert.ok(suffixed.length <= 30, `${suffixed} is ${suffixed.length} characters`);
  assert.ok(claimable(suffixed, null).ok);
  assert.ok(suffixed.endsWith("2"));
});

test("the suffixes run out, so the caller falls through to the generator", () => {
  // Deliberately finite. An address whose handle is contested this hard is
  // better served by a non-identifying name than by counting for ever.
  assert.equal(usernameFromEmailAttempt("adam@example.com", 4), null);
  assert.equal(usernameFromEmailAttempt("admin@example.com", 0), null);
});

test("the route tries the address first, then suffixes, then the generator", () => {
  const route = src("app", "api", "account", "profile", "route.ts");

  // The order is the whole of the request, so it is asserted rather than
  // assumed: email-derived first, generator only as the fallback.
  assert.match(
    route,
    /usernameFromEmailAttempt\(email, attempt\) \?\? generateUsername\(previous\)/,
    "the email must be tried before the non-identifying generator",
  );

  // Uniqueness is still settled by the claim, not by any of the above. A
  // taken name must keep the loop going rather than return.
  assert.match(route, /if \(result\.status === "taken_username" && generated\) continue;/);
  assert.match(route, /claimLearnerUsername\(auth\.user, checked\.username\)/);
});

test("nothing derived from an address bypasses the claimable check", () => {
  const source = src("lib", "auth", "generated-username.ts");
  // Both exported email paths must end at claimable, or a reserved or
  // malformed handle reaches a claim that the database then refuses.
  // Scoped to the two email functions only — generateUsername below has
  // claimable calls of its own, and counting those would pass by accident.
  const derived = source.slice(
    source.indexOf("export function usernameFromEmail"),
    source.indexOf("A friendly, non-identifying username suggestion"),
  );
  assert.ok(derived.includes("export function usernameFromEmailAttempt"), "slice covers both");
  assert.equal(
    [...derived.matchAll(/claimable\(/g)].length,
    2,
    "usernameFromEmail and usernameFromEmailAttempt must each check",
  );
});

// ---------------------------------------------------------------------------
// The display name
// ---------------------------------------------------------------------------

test("the generated display name reads as a name, not as a handle", () => {
  const sequence = [3, 7, 1, 11, 5, 2, 9, 4, 8, 6, 0, 10];
  let index = 0;
  const random = () => sequence[index++ % sequence.length];

  const name = generateDisplayName(null, random);
  assert.match(name, /^[A-Z][a-z]+ [A-Z][a-z]+$/, `${name} should be two capitalised words`);
  // No numeric suffix: that exists to dodge a username collision, and a
  // display name has no uniqueness to satisfy.
  assert.doesNotMatch(name, /\d/);
  assert.doesNotMatch(name, /-/);
});

test("pressing Generate again gives a different display name", () => {
  // A button that can answer with what is already in the field reads as
  // broken, which is why `previous` is passed at all.
  let calls = 0;
  const random = () => (calls++ < 2 ? 0 : 5);
  const first = generateDisplayName(null, random);
  const second = generateDisplayName(first, random);
  assert.notEqual(second, first);
});

test("the username generator survives as the fallback it now is", () => {
  // Still the answer for a reserved or unusable address, so it must keep
  // producing valid, claimable handles.
  const value = generateUsername(null);
  assert.ok(claimable(value, null).ok);
  assert.match(value, /^[a-z]+-[a-z]+-\d{3}$/);
});

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

test("the form prefills the username from the email without overwriting a chosen one", () => {
  const form = src("components", "account", "AccountIdentityForm.tsx");

  // `profile.username ??` first: a learner who already has a handle must not
  // find it silently replaced by their address when they open the page.
  assert.match(
    form,
    /useState\(\s*profile\.username \?\? usernameFromEmail\(profile\.email\) \?\? "",\s*\)/,
    "an existing username must win over the derived one",
  );

  // The button moved; the username field no longer has one.
  assert.match(form, /onClick=\{suggestDisplayName\}/);
  assert.doesNotMatch(form, /suggestUsername/);
  assert.doesNotMatch(form, /generateUsername\(/);

  // And the field says where its value came from, since a learner who did not
  // type it deserves to know it is public before they save it.
  assert.match(form, /Taken from your email address/);
  assert.match(form, /Other people can see it/);
});
