# Cloudflare-native cutover release gate

This is the final release checklist for moving BandUp authentication and
billing authority from Supabase compatibility paths to Cloudflare. It is
intentionally all-or-nothing: do not set either native feature flag simply
because D1 has rows. Every item below must pass for the **same fresh source
snapshot**.

## What is already ready

- Preview D1 has migrations `0019`, `0020`, and `0021` applied.
- The Worker has a native Google subject mapping path, a bcrypt-compatible
  email/password path, short-lived D1 sessions with one-time refresh rotation,
  and a Stripe receipt/original-payment ledger.
- The owner readiness endpoint exposes aggregate status only. It never exposes
  an address, provider subject, password verifier, session token, payment
  intent, or raw Stripe event.

## Production preparation — do not flip flags yet

1. Review the exact migrations, then apply `0019_native_stripe_event_ledger`,
   `0020_account_deletion_auth_authority`, and
   `0021_native_password_migration_proof` to **production D1**. These are
   schema/data migrations, not a Worker deploy; take a Cloudflare D1 export
   first and apply them only during a quiet window.

2. With a current owner session, open **Admin → Config → Cloudflare account
   identity** and run the read-only identity audit. It must report all of:

   - all current Supabase Auth users matched to live D1 `app_users` IDs;
   - every Google provider subject mapped to that same immutable D1 user ID;
   - no duplicate/malformed/unsupported providers;
   - no unhandled Apple identities.

3. Follow [the confidential password-import procedure](native-cloudflare-password-import.md)
   with a fresh, direct read-only `auth.users` export. The final owner card
   must say **Legacy passwords — exact source-to-D1 match**. A count match
   alone is not sufficient.

4. Run the payment-history preflight, using a read-only Supabase service-role
   credential from a secure owner machine:

   ```sh
   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
   node scripts/check-stripe-cutover-readiness.mjs --production
   ```

   It must exit successfully with `ready: true`. It compares the immutable
   original paid amount for every historic one-time Stripe purchase with the
   D1 prepaid ledger, so partial and full refunds remain correct after
   cutover.

5. Confirm the production identity/session aggregate audit and the payment
   preflight were generated after the password export. Record only the
   aggregate reports in the release ticket; delete confidential exports under
   the organisation retention policy.

## The release flip

The feature flags are versioned in `wrangler.jsonc`, so do **not** change them
only in the Cloudflare dashboard: the next Worker deployment would restore the
repository values. Make a small, reviewed release commit that changes both:

```jsonc
"CLOUDFLARE_NATIVE_AUTH": "1",
"CLOUDFLARE_NATIVE_STRIPE_BILLING": "1"
```

Deploy that reviewed commit only after all preparation checks pass. This gives
one auditable, rollbackable release point. `CLOUDFLARE_DATA_MODE` and
`ORGANIZATION_DATA_MODE` are already Cloudflare-authoritative and must remain
so.

## Session continuity and retirement

- At release, existing valid Supabase browser sessions stay usable while the
  compatibility configuration remains present. Each page silently exchanges a
  verified legacy token for a D1 session without replacing a newer tab's
  session.
- Native access tokens are signed and checked against a live D1 session row;
  refresh credentials rotate once, rather than creating a parallel session.
- Keep Supabase compatibility configuration for at least the native refresh
  lifetime (currently 30 days) and until the aggregate bridge telemetry shows
  no active legacy sessions. Do not delete Supabase merely because the native
  flags were enabled.
- Only after that compatibility period, a final read-only source-vs-D1 audit,
  and an owner-approved production rollback plan may Supabase runtime
  credentials and infrastructure be retired.

## Immediate rollback

If any sign-in, entitlement, or payment issue appears after the release,
redeploy the last reviewed version with both native flags at `"0"`. Do not
delete D1 identity, session, payment, or proof records during rollback; they
are needed to diagnose and safely resume the migration.
