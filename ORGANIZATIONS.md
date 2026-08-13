# BandUp organization operations

> **Production is already cut over.** `npm run migration:production` now stops
> immediately and must not be used as a reconciliation command: replaying the
> former Supabase source can overwrite organisation changes committed to D1
> after cutover. Use `/admin/config` readiness/parity checks and the ordinary
> Worker deployment workflow for subsequent releases.

## Current data architecture

- Supabase Auth remains the identity provider during the Cloudflare cutover.
- Cloudflare D1 stores normalized learner, billing and organization records.
- Private R2 stores large progress payloads, essays, speaking transcripts and
  immutable migration source rows. D1 stores a SHA-256 digest and byte count.
- `CLOUDFLARE_DATA_MODE=supabase` independently keeps learner progress,
  profiles and billing on Supabase during the organization rollout.
- `ORGANIZATION_DATA_MODE=supabase` is the separate safe default for the
  organization portal, commands, history permissions and attempt ledger.
  `dual` keeps Supabase authoritative while copying attempt-ledger writes;
  `cloudflare` makes D1 authoritative for organization data only.
- The two switches never inherit from one another. A missing or invalid value
  safely resolves to `supabase` for that data domain.
- When `ORGANIZATION_DATA_MODE` is `dual` or `cloudflare`, successful
  Supabase-authoritative profile and verified billing writes also refresh the
  normalized D1 copies used by organization views, even while
  `CLOUDFLARE_DATA_MODE=supabase`. Supabase commits first; a D1 replica error
  is logged and retried by a later profile save or duplicate webhook delivery,
  and never turns the successful source write into a failure.

## Release gate

- Never apply either database path directly to production first.
- Apply it to an isolated Supabase staging project, run the probes below, and test every role.
- Keep two isolated preview stores:
  - `bandup-data-preview` / `bandup-files-preview` hold private migration
    verification evidence. Only `wrangler.migration-preview.jsonc` may target
    them; they must never be bound to a public role preview.
  - `bandup-organization-ui-preview` D1/R2 contain synthetic
    `@preview.bandup.invalid` fixtures only and are the public UI preview.
- Apply `cloudflare/migrations` to the synthetic UI-preview D1 and run both
  rehearsal scripts before any Cloudflare cutover.
- Take and verify a restorable encrypted database backup immediately before production migration.
- Enable point-in-time recovery for the production database before organizations hold learner records.
- Deploy the application only after the migration succeeds; the UI safely reports unavailable before it exists.

## Verified Cloudflare preview procedure

```sh
# Synthetic source rows -> temporary local D1/R2 -> count/hash verification.
node scripts/rehearse-cloudflare-migration.mjs

# Full permissions and workflow against temporary local D1/R2.
node scripts/rehearse-organization-runtime.mjs

# Preview only. Never substitute the production database name here.
npx wrangler d1 migrations apply bandup-organization-ui-preview \
  --config wrangler.preview.jsonc --remote

npx wrangler d1 execute bandup-organization-ui-preview \
  --config wrangler.preview.jsonc --remote \
  --file cloudflare/preview/seed-organization.sql
```

The actual copy is source-read-only and target-idempotent. It uploads large
JSON to private R2, downloads it again, verifies SHA-256/length, writes D1, then
re-reads the Supabase source before completing a checkpoint. It never updates
or deletes Supabase:

```sh
SUPABASE_URL=https://SOURCE-PROJECT.supabase.co \
SUPABASE_SERVICE_ROLE_KEY='temporary-source-service-key' \
node scripts/migrate-supabase-to-cloudflare.mjs --preview --remote --dry-run

# Run only after checking the dry-run table counts.
SUPABASE_URL=https://SOURCE-PROJECT.supabase.co \
SUPABASE_SERVICE_ROLE_KEY='temporary-source-service-key' \
node scripts/migrate-supabase-to-cloudflare.mjs --preview --remote
```

`--preview` deliberately resolves `wrangler.migration-preview.jsonc`, never
the public UI Worker's `wrangler.preview.jsonc`. This prevents a later source
copy from putting real learner data into the synthetic role preview.

Production storage is deliberately separate: D1 `bandup-data-production` and
private R2 `bandup-files-production`. A production copy is accepted only with
all three explicit switches, preventing an ordinary rehearsal command from
targeting live storage:

```sh
npm run migration:production
```

The command asks for the Supabase project URL and a temporary service-role key
without echoing either value. It first performs a source-read-only dry run,
then requires `COPY` before writing to production. Once the copy reconciles,
it requires a separate `ACTIVATE` confirmation before rebuilding and deploying
the Worker with only `ORGANIZATION_DATA_MODE=cloudflare`; existing
dashboard-managed variables are preserved. Entering anything else at either
prompt stops at the safe earlier stage.

The runner asks for the source URL and temporary service-role key without
echoing either, completes the read-only dry run first, then requires `COPY`
before it writes to production. The profile migration also downloads each private avatar, validates the JPEG,
PNG or WebP signature and size, uploads it privately to R2 and verifies a
downloaded SHA-256 checksum before recording the new object key.

Use a temporary source credential, enter it only in the shell environment,
and revoke it after the verified copy. Never paste it into a file, dashboard
note, command history, Git commit or chat message.

## Cutover sequence

1. Run the source dry-run and record every table count.
2. Copy to the isolated preview D1/R2 and verify the completed run/checkpoints.
3. Test owner, manager, teacher, assigned student, unassigned student and
   learner-clear-history behavior on preview.
4. Enable `ORGANIZATION_DATA_MODE=dual` in preview only; test organization
   commands and new attempt sync while learner progress remains on Supabase.
5. Take a fresh Supabase backup, run one final incremental verified copy, and
   record the cutover timestamp.
6. Switch preview `ORGANIZATION_DATA_MODE` to `cloudflare`; keep
   `CLOUDFLARE_DATA_MODE=supabase` and keep Supabase untouched as rollback.
7. Observe errors/latency and row-count reconciliation before scheduling a
   separately approved production cutover.

## Required staging probes

- Run `supabase/organization-probes.sql` in the staging SQL editor after the migration. It exercises the complete role and consent flow inside one transaction and rolls every fixture back at the end.

1. Anonymous and ordinary authenticated clients cannot select any organization table or execute helper functions.
2. Organization RPCs remain service-role-only, including the incremental batch-assignment, selected-admin-workspace, consent, and former-member consent upgrades; none are callable by `anon` or `authenticated` directly.
3. A teacher cannot open an unassigned student; a manager cannot manage another organization; a forged platform-admin flag fails.
4. Email invitations require the matching account and the original token. Reusing a consumed token fails.
5. Students in `active`, `leave_requested`, or `suspended` status cannot clear history through either UI or a direct progress upload.
6. Archive is reversible. Permanent organization removal needs a reason and never deletes `practice_attempts`.
7. Deleting a learner account removes learner-owned attempts without deleting immutable audit/tombstone evidence.
8. Retrying a command with the same idempotency key returns the prior result; reusing the key with different data fails.

The local organization rehearsal now executes item 7 end to end. It prepares
an account deletion, proves writes are frozen, simulates the already-confirmed
Supabase Auth deletion, purges D1 profile/progress/subscription/attempt and
subject-tagged migration copies, removes referenced and superseded private R2
objects, then proves the organization, migration checkpoint, audit ledger and
permanent-removal tombstone survived unchanged:

```sh
node scripts/rehearse-organization-runtime.mjs
```

### Attempt history durability

When learner progress is saved successfully, normalized organization attempts
are secondary: a transient D1/R2 failure must not make the primary progress
write fail. `cloudflare/migrations/0006_organization_history_durability.sql`
therefore adds one coalescing outbox row per learner. It holds at most the
latest 100 normalized attempts, backs off retries with a two-minute lease, and
is drained in bounded pages after progress and organization reads. A duplicate
attempt receipt makes processing at-least-once and crash-safe.

A permitted learner history clear is copied as a monotonic D1 watermark.
Attempts at or before that time are purged, and every delayed/outbox resync
rechecks the watermark before inserting, so an older device cannot make cleared
history reappear in an organization view.

Detailed reviews carry an explicit `result_has_review` bit. This preserves both
inline and R2-backed essay/transcript reviews when a later score-only client
resyncs the same sitting. Replacement and purge commit D1 pointers first, then
delete only R2 keys no attempt or outbox still references. Transient R2 delete
failures enter a separate bounded cleanup ledger and are retried later.

## Monitoring

- Alert on organization API 5xx rate, RPC latency, failed background attempt syncs, backup failures, and database storage growth.
- Alert on old `organization_attempt_sync_outbox.available_at` rows, repeated
  `last_error_code`, and `organization_attempt_object_cleanup` rows approaching
  20 failed attempts. These indicate D1/R2 reconciliation is not converging.
- Alert on `account_deletion_tombstones.state <> 'complete'` older than ten
  minutes. Retry `auth_deleted`/`data_deleted`; reconcile `prepared` and
  `auth_delete_started` through the owner-only
  `/api/admin/account-deletions` endpoint, which fails closed unless Supabase
  Auth definitively answers whether the identity exists.
- Review audit events for platform-admin actions, role changes, member removal, access decisions, and permanent organization removals.
- Keep organization endpoints `private, no-store`; never log request payloads, invitation tokens, essays, or transcripts.
- Rotate service-role credentials after suspected exposure and invalidate outstanding invitation links.

## Recovery

- Prefer forward fixes. Do not drop organization tables to roll back an application release.
- If writes are unsafe, disable organization entry points while leaving learner practice available.
- Restore into an isolated project first, compare row counts and audit continuity, then choose a controlled cutover.
- Reconcile `practice_attempts` from account progress snapshots only after confirming the restored cutoff; synchronization is idempotent.
- Document the incident, time range, affected organizations, recovery point, and every operator action.
- During the organization cutover, rollback means changing only
  `ORGANIZATION_DATA_MODE` back to `supabase`; do not delete D1/R2 or Supabase
  data. Reconcile later from immutable migration rows and checkpoints.
