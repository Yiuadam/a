import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const danger = readFileSync(
  join(process.cwd(), "components", "account", "DangerSection.tsx"),
  "utf8",
);
const closePage = readFileSync(
  join(process.cwd(), "app", "account", "close", "page.tsx"),
  "utf8",
);

test("account deletion cannot leave the UI on an endless spinner", () => {
  assert.match(danger, /new AbortController\(\)/);
  assert.match(danger, /Promise\.race\(/);
  assert.match(danger, /30_000/);
  assert.match(danger, /did not receive a final answer within 30 seconds/);
  assert.match(danger, /Check deletion status/);
});

test("slow deletion is explained and cannot be cancelled mid-request", () => {
  assert.match(danger, /Checking everything linked to your account/);
  assert.match(danger, /Still checking every place your data is stored/);
  assert.match(danger, /className="btn-secondary"[\s\S]*disabled=\{busy\}/);
});

test("a confirmed deletion clears the session and leaves the action page", () => {
  assert.match(danger, /setBusy\(false\);[\s\S]*setProgress\(null\);[\s\S]*onDeleted\(\)/);
  assert.match(closePage, /function accountDeleted\(\)[\s\S]*clearSession\(\)/);
  assert.match(closePage, /accountDeleted[\s\S]*router\.replace\("\/account"\)/);
  assert.match(closePage, /DeleteAccountSection onDeleted=\{accountDeleted\}/);
});
