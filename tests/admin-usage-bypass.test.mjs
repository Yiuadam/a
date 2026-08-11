/*
  ADMIN_EMAILS is a server-side entitlement source, while the database usage
  function can only see stored profile roles. Keep the two gates aligned: the
  verified admin email must be exempt before the database meter is called.
*/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync("lib/usage/guard.ts", "utf8");

test("the usage meter honours a verified ADMIN_EMAILS session", () => {
  assert.match(source, /import \{[^}]*isAdminEmail[^}]*\} from "@\/lib\/auth\/env";/s);
  assert.match(source, /if \(isAdminEmail\(user\?\.email\)\) return null;/);

  const exemption = source.indexOf("if (isAdminEmail(user?.email)) return null;");
  const meter = source.indexOf('rpc<UsageDecision | null>("check_and_record_usage"');
  assert.ok(exemption >= 0 && exemption < meter, "admin exemption must run before metering");
});
