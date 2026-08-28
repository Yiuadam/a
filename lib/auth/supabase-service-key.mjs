/**
 * Header handling shared by the application and the source-read-only
 * migration runner.
 *
 * Supabase's current secret API keys use the opaque `sb_secret_` form. They
 * belong in `apikey` only: unlike the older JWT service_role key they cannot
 * be used as an HTTP Bearer token. Keeping the rule in one small dependency
 * prevents the migration path from drifting away from the application path.
 */

export function isOpaqueSupabaseSecret(value) {
  return value.startsWith("sb_secret_");
}

export function setSupabaseServiceHeaders(headers, serviceRoleKey) {
  headers.set("apikey", serviceRoleKey);
  if (isOpaqueSupabaseSecret(serviceRoleKey)) {
    headers.delete("Authorization");
  } else {
    headers.set("Authorization", `Bearer ${serviceRoleKey}`);
  }
}

export function supabaseServiceHeaders(serviceRoleKey, accept) {
  const headers = new Headers();
  setSupabaseServiceHeaders(headers, serviceRoleKey);
  if (accept) headers.set("Accept", accept);
  return Object.fromEntries(headers.entries());
}
