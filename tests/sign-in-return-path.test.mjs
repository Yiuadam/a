/*
  Every "Sign in to do X" prompt in the app used to send a visitor to
  /account with a bare <Link>, which is where they stayed after signing
  in — a second navigation, away from whatever they actually came to do.
  components/account/SignInLink.tsx exists so that rule cannot be
  forgotten at a new call site: it remembers where the click happened, and
  the three ways sign-in can complete (password, Google, Apple/recovery)
  already send the visitor back there.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

register("./alias-resolve.mjs", import.meta.url);

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), "utf8");

/** Comments stripped, so a comment mentioning a bare Link cannot pass this by accident. */
function code(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const signInLink = read("components", "account", "SignInLink.tsx");

test("SignInLink remembers the click's own location before navigating, and still runs a caller's onClick", () => {
  const source = code(signInLink);
  assert.match(source, /rememberAuthReturnPath\(/);
  assert.match(
    source,
    /window\.location\.pathname.*window\.location\.search.*window\.location\.hash/s,
  );
  // A caller's own onClick (FreeProPoster's auto-accept flag) has to run
  // too, not be silently replaced by spreading a second onClick over it.
  assert.match(source, /onClick\?\.\(event\)/);
});

const SIGN_IN_PROMPTS = [
  ["components", "SkillGate.tsx"],
  ["components", "billing", "UpgradePanel.tsx"],
  ["components", "billing", "FreeProPoster.tsx"],
  ["app", "pricing", "PricingPlans.tsx"],
  ["components", "organization", "OrganizationPortal.tsx"],
  ["components", "account", "NotificationInbox.tsx"],
  ["components", "SiteHeader.tsx"],
  ["app", "billing", "state.tsx"],
  ["app", "account", "onboarding", "page.tsx"],
];

test("every sign-in prompt this was swept over imports and uses SignInLink", () => {
  for (const parts of SIGN_IN_PROMPTS) {
    const source = code(read(...parts));
    assert.match(
      source,
      /import SignInLink from "@\/components\/account\/SignInLink";/,
      `${parts.join("/")} does not import SignInLink`,
    );
    assert.match(source, /<SignInLink\b/, `${parts.join("/")} does not render <SignInLink`);
  }
});

test("PricingPlans's two sign-in prompts are both wired, not just one", () => {
  const source = code(read("app", "pricing", "PricingPlans.tsx"));
  const hits = source.match(/<SignInLink\b/g) ?? [];
  assert.equal(hits.length, 2, `expected 2 <SignInLink occurrences, found ${hits.length}`);
});

test("every sign-in completion path consumes the remembered return path", () => {
  const passwordForm = code(read("components", "account", "SignedOut.tsx"));
  const google = code(read("components", "account", "GoogleSignIn.tsx"));
  const callback = code(read("components", "AccountCallback.tsx"));
  for (const [label, source] of [
    ["password sign-in", passwordForm],
    ["Google sign-in", google],
    ["Apple/recovery callback", callback],
  ]) {
    assert.match(source, /consumeAuthReturnPath\(/, `${label} does not consume the return path`);
  }
});

test("safeAuthReturnPath is a general in-app relative-path check now, not the org-invite shape alone", async () => {
  const returnPath = await import(
    pathToFileURL(join(root, "lib", "auth", "return-path.ts")).href
  );
  assert.equal(returnPath.safeAuthReturnPath("/"), true);
  assert.equal(returnPath.safeAuthReturnPath("/pricing"), true);
  assert.equal(returnPath.safeAuthReturnPath("//evil.example/"), false);
  assert.equal(returnPath.safeAuthReturnPath("https://evil.example/"), false);
});

const dismissal = readFileSync(
  join(root, "lib", "billing", "free-pro-dismissal.ts"),
  "utf8",
);

test("the auto-accept intent is a distinct, session-scoped flag from the dismissal flag", () => {
  const source = code(dismissal);
  assert.match(source, /export function rememberAutoAcceptIntent/);
  assert.match(source, /export function consumeAutoAcceptIntent/);
  // sessionStorage, not localStorage: a one-time continuation of a click
  // just made, not a standing per-device preference like dismissal is.
  assert.match(source, /rememberAutoAcceptIntent[\s\S]*?sessionStorage\.setItem/);
  assert.match(source, /consumeAutoAcceptIntent[\s\S]*?sessionStorage\.getItem/);
  // Read-and-clear, so a later reload of the same tab does not repeat it.
  assert.match(source, /consumeAutoAcceptIntent[\s\S]*?sessionStorage\.removeItem/);
});
