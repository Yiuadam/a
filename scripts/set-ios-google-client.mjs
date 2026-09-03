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

    node scripts/set-ios-google-client.mjs 1234-abc.apps.googleusercontent.com

  The client ID is not a secret. Google issues no secret for an iOS client,
  because a secret inside an app is not one; the redirect scheme is what proves
  the app is the app.
*/
import { readFileSync, writeFileSync } from "node:fs";

const PLIST = "ios/App/App/Info.plist";
const clientId = (process.argv[2] ?? "").trim();

if (!/^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
  console.error(
    "\nThat does not look like a Google iOS client ID.\n\n" +
      "  Expected:  1234567890-abcdefghij.apps.googleusercontent.com\n" +
      `  Given:     ${clientId || "(nothing)"}\n\n` +
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
