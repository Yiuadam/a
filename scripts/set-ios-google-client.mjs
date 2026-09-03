#!/usr/bin/env node
/*
  Point the iOS app's OAuth redirect at a Google client.

  Google requires an installed application to receive its redirect on a scheme
  made of the client ID with its dot-separated parts reversed, and iOS delivers
  a URL only to the app that claims that scheme in Info.plist. So the same value
  has to appear in two places, in two different orders, and reversing it by hand
  is exactly the kind of edit that is wrong once and then hard to see.

  GoogleSignInPlugin.swift builds the scheme the same way at run time from the
  client ID the server hands it, so a mismatch does not fail loudly — the sheet
  opens, the learner signs in, and the redirect is delivered to nothing. This
  script exists so that cannot happen.

  Usage:

    node scripts/set-ios-google-client.mjs 1234567890-abcdefghij.apps.googleusercontent.com

  or, once the deployment knows its own client, with nothing to copy at all:

    node scripts/set-ios-google-client.mjs --from https://bandup.life

  The client ID is not a secret. Google issues no secret for an iOS client,
  because a secret inside an app is not one; the redirect scheme is what proves
  the app is the app.
*/
import { readFileSync, writeFileSync } from "node:fs";

const PLIST = "ios/App/App/Info.plist";

/*
  A real Google client ID is a project number, a hyphen, then a random label:
  digits first, always a hyphen, always something after it. Checking that shape
  rather than "some characters" is the difference between catching a
  placeholder pasted out of the documentation and writing it into the plist,
  where it fails silently at the one moment somebody is trying to sign in.
*/
const CLIENT_ID = /^\d+-[A-Za-z0-9]+\.apps\.googleusercontent\.com$/;

async function resolveClientId(args) {
  if (args[0] === "--from") {
    const origin = (args[1] ?? "").replace(/\/$/, "");
    if (!origin) throw new Error("--from needs an origin, for example https://bandup.life");
    const res = await fetch(`${origin}/api/auth/google/config`, { cache: "no-store" });
    const body = res.ok ? await res.json() : null;
    const id = typeof body?.iosClientId === "string" ? body.iosClientId : "";
    if (!id) {
      throw new Error(
        `${origin} reports no iOS Google client.\n` +
          "Either GOOGLE_IOS_CLIENT_ID is not set on that Worker, or the\n" +
          "deployment predates the config field — deploy first, then retry.",
      );
    }
    return id;
  }
  return (args[0] ?? "").trim();
}

let clientId;
try {
  clientId = await resolveClientId(process.argv.slice(2));
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

if (!CLIENT_ID.test(clientId)) {
  console.error(
    "\nThat is not a Google iOS client ID.\n\n" +
      "  Expected:  1234567890-abcdefghij.apps.googleusercontent.com\n" +
      `  Given:     ${clientId || "(nothing)"}\n\n` +
      "A real one starts with your Google project number, then a hyphen.\n" +
      "Google Cloud console -> Credentials -> Create credentials ->\n" +
      "OAuth client ID -> iOS, with bundle ID com.bandup.app.\n",
  );
  process.exit(1);
}

const scheme = clientId.split(".").reverse().join(".");
const plist = readFileSync(PLIST, "utf8");
const current = /<string>(com\.googleusercontent\.apps\.[^<]*)<\/string>/.exec(plist);

if (!current) {
  console.error(`\nNo Google redirect scheme found in ${PLIST}. Has it been edited by hand?\n`);
  process.exit(1);
}
if (current[1] === scheme) {
  console.log(`\nAlready set: ${scheme}\n`);
  process.exit(0);
}

writeFileSync(PLIST, plist.replace(current[1], scheme));
console.log(
  `\nRedirect scheme set in ${PLIST}:\n\n  was  ${current[1]}\n  now  ${scheme}\n\n` +
    "Two things left, and the button stays hidden until both are done:\n\n" +
    "  1. Set the same client ID on the Worker, unreversed:\n" +
    "       npx wrangler secret put GOOGLE_IOS_CLIENT_ID\n" +
    "  2. Rebuild and reinstall the app:\n" +
    "       NEXT_PUBLIC_API_BASE=https://bandup.life npm run build:mobile && npx cap sync ios\n",
);
