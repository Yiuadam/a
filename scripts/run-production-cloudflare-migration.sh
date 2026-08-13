#!/usr/bin/env bash
#
# One protected, resumable handoff for the final Supabase -> production D1/R2
# copy. The source credential is read without echoing it, kept only in this
# process environment, and never appears in shell history or a command line.
#
set -euo pipefail

printf "Migration stopped: this command is pre-cutover only. Production organisation data is already Cloudflare-authoritative, so replaying the old Supabase copy could overwrite newer D1 records. Use the owner readiness report and the ordinary Worker deployment workflow instead.\n" >&2
exit 2

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

cleanup() {
  unset SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
}
trap cleanup EXIT

if [[ -z "${SUPABASE_URL:-}" ]]; then
  read -r -p "Supabase project URL: " SUPABASE_URL
fi

if [[ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]]; then
  printf "Paste temporary service-role key: " >&2
  IFS= read -r -s SUPABASE_SERVICE_ROLE_KEY
  printf "\n" >&2
fi

if [[ -z "$SUPABASE_URL" || -z "$SUPABASE_SERVICE_ROLE_KEY" ]]; then
  printf "Migration stopped: both Supabase URL and temporary service-role key are required.\n" >&2
  exit 1
fi

export SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY
readonly migration_args=(
  --production
  --remote
  --confirm-production=bandup-data-production
)

printf "Running a source-read-only production dry run…\n" >&2
node scripts/migrate-supabase-to-cloudflare.mjs "${migration_args[@]}" --dry-run

printf "\nDry run passed. Type COPY to write the verified copy into production D1/R2: " >&2
read -r confirmation
if [[ "$confirmation" != "COPY" ]]; then
  printf "Copy cancelled. No production rows or files were written.\n" >&2
  exit 0
fi

node scripts/migrate-supabase-to-cloudflare.mjs "${migration_args[@]}"

printf "\nCopy verified. Type ACTIVATE to deploy the tested production Worker with organization data served from D1; anything else leaves the safe Supabase organization path active: " >&2
read -r activation
if [[ "$activation" != "ACTIVATE" ]]; then
  printf "Copy is complete, but organization cutover was not activated. Re-run this command when ready; it will safely upsert the same migration data.\n" >&2
  exit 0
fi

# `--keep-vars` preserves the existing dashboard-managed production values and
# this is deliberately the only variable introduced by the cutover deployment.
npm run cf:build
npx wrangler deploy --config wrangler.jsonc --keep-vars --var ORGANIZATION_DATA_MODE:cloudflare

printf "Production migration is verified and the organization D1 path is active. Revoke the temporary Supabase service-role key now.\n" >&2
