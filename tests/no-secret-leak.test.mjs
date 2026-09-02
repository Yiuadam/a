import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/*
  The accounts system holds a key that bypasses every access rule in the
  database. Documenting "do not expose it" is not a control — this is.

  Next.js will not inline a variable that is not named NEXT_PUBLIC_* into a
  client bundle, so the leak this guards against is not the obvious one. It is
  the later mistake: someone renames a variable to NEXT_PUBLIC_ to make a
  client component work, or passes a config object through props, or logs it
  into a serialised payload. Each of those puts the value, or its name, in a
  file under .next/static — and this test reads those files.

  It runs against whatever build output is present. CI builds before it runs
  tests, so in CI it always has something to read.
*/

/** Names that must never appear anywhere the browser can reach. */
const FORBIDDEN_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "AVATAR_URL_SIGNING_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "ANTHROPIC_ADMIN_KEY",
  "APPLE_IAP_PRIVATE_KEY",
  "APPLE_IAP_KEY_ID",
  /*
    The Sign in with Apple key, which is a different credential from the two
    above however alike the names look — one is in-app purchase, the other is
    identity. Listed while it is unset, deliberately: the point of this test is
    to catch the refactor that puts a name in the bundle long before there is a
    value behind it to leak.
  */
  "APPLE_SIGNIN_PRIVATE_KEY",
  "APPLE_SIGNIN_KEY_ID",
  "USAGE_IP_HASH_SALT",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  /*
    A token that can start a deployment of this repository. Held server-side so
    the admin console's site switch can close the site; behind a NEXT_PUBLIC_
    name it would be a deploy button for anyone who opened dev tools.
  */
  "GITHUB_DEPLOY_TOKEN",
];

/**
 * Values are checked too, for the case where a secret is set in the
 * environment that produced the build. A short or placeholder value is skipped
 * so an empty string does not match every file.
 */
const VALUE_VARS = [...FORBIDDEN_NAMES, "SUPABASE_URL", "SUPABASE_ANON_KEY", "ANTHROPIC_API_KEY"];

/** Client-reachable build output. */
const ROOTS = [
  join(process.cwd(), ".next", "static"),
  join(process.cwd(), "out-mobile"),
];

function jsFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|mjs|json|html|txt|map)$/.test(entry)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

test("no server-only secret name reaches the browser bundle", () => {
  const roots = ROOTS.filter(existsSync);
  if (roots.length === 0) {
    console.log("  (no build output found — run `npm run build` to exercise this test)");
    return;
  }

  const offences = [];
  for (const root of roots) {
    for (const file of jsFiles(root)) {
      const text = readFileSync(file, "utf8");
      for (const name of FORBIDDEN_NAMES) {
        if (text.includes(name)) offences.push(`${name} in ${file}`);
      }
    }
  }

  assert.deepEqual(
    offences,
    [],
    `A server-only variable name appears in client-reachable output:\n  ${offences.join("\n  ")}\n` +
      "If a secret's name is in the bundle, its value is one refactor away from following it.",
  );
});

test("no server-only secret value reaches the browser bundle", () => {
  const roots = ROOTS.filter(existsSync);
  if (roots.length === 0) return;

  const secrets = VALUE_VARS.map((name) => [name, process.env[name]]).filter(
    // Anything under 12 characters is a placeholder, not a key, and matching
    // on it would produce noise rather than a finding.
    ([, value]) => typeof value === "string" && value.length >= 12,
  );
  if (secrets.length === 0) {
    console.log("  (no secrets set in this environment — nothing to search for)");
    return;
  }

  const offences = [];
  for (const root of roots) {
    for (const file of jsFiles(root)) {
      const text = readFileSync(file, "utf8");
      for (const [name] of secrets.filter(([, value]) => text.includes(value))) {
        // The value itself is never printed, here or anywhere.
        offences.push(`value of ${name} in ${file}`);
      }
    }
  }

  assert.deepEqual(offences, [], `A secret's value appears in client-reachable output:\n  ${offences.join("\n  ")}`);
});

test("no secret is exposed by being renamed NEXT_PUBLIC_", () => {
  const template = readFileSync(join(process.cwd(), ".env.example"), "utf8");
  const publicVars = [...template.matchAll(/^\s*(NEXT_PUBLIC_[A-Z0-9_]+)\s*=/gm)].map((m) => m[1]);

  // NEXT_PUBLIC_ is a promise that a variable is safe to publish. Only one
  // variable in this app is, and it holds a URL.
  assert.deepEqual(
    publicVars,
    ["NEXT_PUBLIC_API_BASE"],
    "A new NEXT_PUBLIC_ variable was added. Everything so named is readable by " +
      "anyone who opens the app, so confirm it holds nothing secret, then update this test.",
  );
});
