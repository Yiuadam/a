import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();

test("the temporary Supabase identity source exposes only the immutable cutover facts to service_role", () => {
  const sql = readFileSync(join(ROOT, "scripts", "provision-supabase-native-identity-source.sql"), "utf8");
  const source = readFileSync(join(ROOT, "lib", "auth", "supabase.ts"), "utf8");
  const audit = readFileSync(join(ROOT, "lib", "cloudflare", "native-identity-audit.ts"), "utf8");
  const backfill = readFileSync(join(ROOT, "lib", "cloudflare", "native-identity-backfill.ts"), "utf8");
  assert.match(sql, /FUNCTION public\.bandup_native_auth_accounts\(\)/);
  assert.match(sql, /FUNCTION public\.bandup_native_auth_identities\(\)/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /SET search_path = pg_catalog, auth/);
  assert.match(sql, /REVOKE ALL[\s\S]*?FROM PUBLIC/);
  assert.match(sql, /GRANT EXECUTE[\s\S]*?TO service_role/);
  assert.doesNotMatch(sql, /encrypted_password|refresh_token|mfa_/i);
  assert.match(source, /listSupabaseNativeIdentitySource/);
  assert.match(source, /bandup_native_auth_identities/);
  assert.match(audit, /listSupabaseNativeIdentitySource/);
  assert.match(audit, /identities: null/);
  assert.match(backfill, /listSupabaseNativeIdentitySource/);
  assert.match(backfill, /sourceGoogleIdentities/);
});
