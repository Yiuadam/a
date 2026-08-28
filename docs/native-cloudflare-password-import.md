# Importing existing password accounts into Cloudflare

This is a one-time migration for people who already use an email address and
password. It preserves their existing bcrypt verifier, so they can continue to
sign in with the password they already know. It does **not** export, show, or
store plaintext passwords.

Do this only after the Cloudflare preview schema migrations `0016` and `0017`
have been reviewed and applied, and before enabling `CLOUDFLARE_NATIVE_AUTH`
in production. The runtime flag must remain `0` there until the Google mapping,
password import, session signing key, Cloudflare Email Sending, account
recovery, and final cutover checks are complete.

1. From a secure owner machine, use a direct, read-only PostgreSQL connection
   to the existing Supabase project. The GoTrue HTTP Admin API deliberately
   does not expose password verifiers. Export only `id`, `email`,
   `encrypted_password`, and `updated_at` from `auth.users`, excluding blank
   `encrypted_password` values (those are provider-only accounts). Do not
   export access tokens, MFA information, recovery tokens, identities, or any
   other Auth columns.

   The export must be JSON Lines in this exact shape:

   ```json
   {"id":"existing-user-id","email":"person@example.com","encrypted_password":"$2b$…","updated_at":"2026-08-28T00:00:00.000Z"}
   ```

   Keep that file in a private directory outside this repository. Do not paste
   it into a terminal transcript, chat, GitHub issue, or code review.

2. Put a current owner bearer token into an environment variable (not a shell
   argument), then send one encrypted verifier at a time to the private,
   owner-only importer on **preview**:

   ```sh
   BANDUP_MIGRATION_BEARER_TOKEN='current-owner-session-token' \
   node scripts/import-native-password-credentials.mjs \
     --input /secure/bandup-password-export.jsonl \
     --origin https://organization-preview.bandup.life
   ```

   The script rejects plaintext-shaped input, bad bcrypt verifiers, duplicate
   user IDs/emails, and an input file inside the Git worktree. Every record is
   handled in a D1 `batch()` transaction: it only writes when its user ID and
   email match the exact live D1 account. A mismatch makes no change and stops
   the import. The token, emails, IDs and verifiers are never printed.

3. Verify only aggregate counts and test a non-owner account whose password is
   known; never query or print the verifier column. Do not enable the
   native-auth flag during this step.

4. After preview verification, create a fresh production export and repeat the
   same check for production. Do not reuse a preview export in production.

5. Remove the private export under the organisation's approved retention
   policy. It contains encrypted password verifiers, not plaintext, but must
   still be treated as confidential authentication data.

The native sign-in code stays fail-closed: a missing/malformed credential,
unknown email, disabled account, unavailable D1 binding, or wrong password all
return the same sign-in failure. No password hash can be returned by an API.
