/*
  Signing out used to promise every account the same thing: "sign back in and
  your placement result, plan and saved words return." True of Tracking and
  AI, whose progress-sync keeps a copy on the account — false of Free, which
  keeps that copy in this tab's sessionStorage and loses it the moment
  signOutSession() (lib/account.ts) runs clearProgressStore(). This file pins
  that the sentence now depends on which of those is actually true, the same
  way tests/history-gate.test.mjs pins it for the history pages themselves.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const source = readFileSync(join(root, "app", "account", "close", "page.tsx"), "utf8");

test("the close screen reads its own tier, the same way as the ClearDeviceSection below it", () => {
  assert.match(source, /import \{ tierShows, useTier \} from "@\/lib\/billing\/useTier";/);
  assert.match(source, /const account = useTier\(\);/);
  /*
    Generous while the answer is unknown — the same guard
    components/account/ClearDeviceSection.tsx uses for this exact feature a
    few lines further down this same screen. A subscriber should not read the
    Free sentence for the second it takes /api/account/status to answer.
  */
  assert.match(
    source,
    /const hasProgressSync =\s*\n\s*account\.phase !== "ready" \|\| !account\.accountsEnabled \|\| tierShows\(account, "progress-sync"\);/,
  );
});

test("the sign-out paragraph tells the truth for whichever tier is actually signed in", () => {
  const at = source.indexOf("Ends the session on this device");
  assert.ok(at >= 0, "the sign-out paragraph must still exist");
  const block = source.slice(at, source.indexOf("</p>", at));

  assert.match(
    block,
    /hasProgressSync\s*\n\s*\? "Nothing is deleted from your account — sign back in and your placement result, plan and saved words return\."\s*\n\s*: "Signing out clears your practice on this device\. On Free it is not kept on the account\."/,
  );
});

test("the reassurance sentence appears exactly once, and only inside that ternary", () => {
  // It used to be printed unconditionally; this guards against a future edit
  // re-adding a second, unguarded copy of it elsewhere on the screen.
  const matches = source.match(/Nothing is deleted from your account/g) ?? [];
  assert.equal(matches.length, 1);
});
