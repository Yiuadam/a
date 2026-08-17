-- ---------------------------------------------------------------------------
-- Prove the payload bytes match, not just the row.
--
-- This is NOT in `migrations/`, and `supabase db push` will not run it. Paste
-- it into the SQL editor. Creating a function changes the live project the
-- moment you run it, so run it deliberately; it is otherwise read-only, adds
-- no table, alters no row, and can be dropped again with the statements at
-- the bottom.
--
-- Depends on `cloudflare_migration_money_field`, defined in
-- supabase/parity-canonical-evidence.sql. Run that one first, or the number
-- branch below will error the moment it sees a payload with a number in it.
-- This file is additive to parity-canonical-evidence.sql, not a replacement
-- for it: that file's fingerprints (identity columns only) still run, and
-- nothing here changes what they compute.
--
-- ---------------------------------------------------------------------------
-- The gap this closes
--
-- `cloudflare_migration_source_fingerprints` and
-- `cloudflare_migration_source_row_fingerprints` compare `progress_snapshots`,
-- `subscriptions` and `provider_events` on identity columns only — user_id /
-- store_key / source_updated_at, id, provider / event_id. The payload itself
-- (`payload`, `raw`, `payload`) is never read by either function, so D1 can
-- hold a stale or corrupt copy of a learner's entire record — every essay,
-- every mock report, every drill score — and both reports still say `equal`.
--
-- What follows adds `cloudflare_migration_source_payload_fingerprints`, a
-- keyset-paged listing of (row key, payload present, canonical payload hash)
-- for those three tables, so the Cloudflare Worker side
-- (lib/cloudflare/payload-parity.ts) can open the matching D1/R2 bytes,
-- canonicalise them the same way, and compare hashes instead of trusting that
-- an equal row-identity fingerprint means an equal payload.
--
-- ---------------------------------------------------------------------------
-- Canonical JSON, defined once and computed the same way on both sides
--
-- `jsonb` reorders object keys and does not round-trip a number's original
-- spelling (`1e2` becomes `100`); JavaScript's `JSON.stringify` preserves
-- insertion order and may print a number in scientific notation. Hashing
-- either side's natural serialisation makes a byte-identical payload read as
-- 100% corrupt — the same trap `parity-canonical-evidence.sql` already paid
-- for once, with microsecond timestamps and `cost_usd`.
--
-- `cloudflare_migration_canonical_json` below is the fix: it walks a `jsonb`
-- value into ONE canonical text form, matched field-for-field by
-- `canonicalizePayloadJson` in lib/cloudflare/payload-canonical.ts. The rules
-- (verified against a live PostgreSQL 16 instance while this was written —
-- see that file's header for what was checked and why):
--
--   1. Object keys sorted by ascending byte order (`collate "C"`).
--   2. Array order preserved as written.
--   3. A string is written as `to_json`/`jsonb::text` already write it —
--      quote, backslash and control characters escaped, `/` and non-ASCII
--      left alone — which is the same escaping `JSON.stringify` uses.
--   4. A number is reduced to the minimal decimal `cloudflare_migration_
--      money_field` already produces for `cost_usd`: no trailing fractional
--      zeros, no leading `+`, never scientific notation (PostgreSQL's
--      `numeric_out` never emits it), `-0` folded to `0`. Reused rather than
--      duplicated, so the two payload checks cannot quietly diverge.
--   5. `true` / `false` / `null` are written as those literal tokens.
--   6. An absent key is omitted; an explicit JSON `null` is written as
--      `null`. `jsonb` already keeps this distinction (JavaScript's
--      `JSON.parse`/`JSON.stringify` do too), so nothing extra is needed —
--      written down because collapsing the two would silently hide a real
--      difference.
--
-- A payload column that is SQL `NULL` (not JSON `null`, but literally absent
-- — a legacy `subscriptions.raw` or `provider_events.payload` row from before
-- payload replication existed) is reported as `payload_present = false` with
-- a `NULL` hash, distinct from a stored JSON `null`.
--
-- ---------------------------------------------------------------------------
-- No stored value leaves this function
--
-- The row key is an account id, a store key or a provider event id — never
-- personal data. The payload itself is read, canonicalised and hashed, and
-- only the one-way hash crosses the boundary; the same discipline
-- row-drift-rpc.sql already uses for whole rows.
--
-- Service role only, like every other migration-evidence function.
-- ---------------------------------------------------------------------------

create or replace function public.cloudflare_migration_canonical_json(p_value jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_type    text;
  v_key     text;
  v_element jsonb;
  v_parts   text[] := '{}';
begin
  if p_value is null then
    return 'null';
  end if;

  v_type := jsonb_typeof(p_value);

  if v_type = 'null' then
    return 'null';
  elsif v_type = 'boolean' then
    return p_value #>> '{}';
  elsif v_type = 'number' then
    -- `#>> '{}'` unwraps the scalar to text without any jsonb-specific
    -- normalisation quirk; casting that text to `numeric` is exact (no
    -- float in between), and `cloudflare_migration_money_field` reduces it
    -- to the same minimal spelling used for cost_usd.
    return public.cloudflare_migration_money_field((p_value #>> '{}')::numeric);
  elsif v_type = 'string' then
    -- jsonb's own text form of a string scalar IS the correctly quoted and
    -- escaped JSON string; nothing further to do.
    return p_value::text;
  elsif v_type = 'array' then
    for v_element in
      select t.value
        from jsonb_array_elements(p_value) with ordinality as t(value, ordinality)
       order by t.ordinality
    loop
      v_parts := v_parts || public.cloudflare_migration_canonical_json(v_element);
    end loop;
    return '[' || array_to_string(v_parts, ',') || ']';
  elsif v_type = 'object' then
    for v_key in
      select key from jsonb_object_keys(p_value) as key order by key collate "C"
    loop
      v_parts := v_parts || (to_json(v_key)::text || ':' || public.cloudflare_migration_canonical_json(p_value -> v_key));
    end loop;
    return '{' || array_to_string(v_parts, ',') || '}';
  else
    -- jsonb_typeof only ever returns one of the six branches above; this
    -- exists so a future PostgreSQL type this function does not know about
    -- fails loudly rather than silently hashing the wrong thing.
    raise exception 'cloudflare_migration_canonical_json: unrecognised jsonb type %', v_type;
  end if;
end;
$$;

revoke all on function public.cloudflare_migration_canonical_json(jsonb)
  from public, anon, authenticated;

create or replace function public.cloudflare_migration_payload_hash(p_value jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(extensions.digest(public.cloudflare_migration_canonical_json(p_value), 'sha256'), 'hex');
$$;

revoke all on function public.cloudflare_migration_payload_hash(jsonb)
  from public, anon, authenticated;

create or replace function public.cloudflare_migration_source_payload_fingerprints(
  p_domain text,
  p_after text default '',
  p_limit integer default 500
)
returns table (row_key text, payload_present boolean, payload_hash text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_after text := coalesce(p_after, '');
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 1000);
begin
  if p_domain = 'progress_snapshots' then
    return query
      select k.row_key, true, public.cloudflare_migration_payload_hash(k.payload)
        from (
          select s.user_id::text || '/' || s.store_key::text as row_key, s.payload
            from public.progress_snapshots s
        ) k
       where k.row_key collate "C" > v_after collate "C"
       order by k.row_key collate "C"
       limit v_limit;

  elsif p_domain = 'subscriptions' then
    return query
      select k.row_key, k.raw is not null,
             case when k.raw is not null then public.cloudflare_migration_payload_hash(k.raw) else null end
        from (
          select s.id::text as row_key, s.raw
            from public.subscriptions s
        ) k
       where k.row_key collate "C" > v_after collate "C"
       order by k.row_key collate "C"
       limit v_limit;

  elsif p_domain = 'provider_events' then
    return query
      select k.row_key, k.payload is not null,
             case when k.payload is not null then public.cloudflare_migration_payload_hash(k.payload) else null end
        from (
          select e.provider::text || '/' || e.event_id::text as row_key, e.payload
            from public.provider_events e
        ) k
       where k.row_key collate "C" > v_after collate "C"
       order by k.row_key collate "C"
       limit v_limit;

  else
    -- An unknown domain returns nothing rather than raising. The caller then
    -- reports the domain as missing on the source side, which is the truth.
    return;
  end if;
end;
$$;

revoke all on function public.cloudflare_migration_source_payload_fingerprints(text, text, integer)
  from public, anon, authenticated;
grant execute on function public.cloudflare_migration_source_payload_fingerprints(text, text, integer)
  to service_role;

notify pgrst, 'reload schema';

-- To remove it again:
-- drop function if exists public.cloudflare_migration_source_payload_fingerprints(text, text, integer);
-- drop function if exists public.cloudflare_migration_payload_hash(jsonb);
-- drop function if exists public.cloudflare_migration_canonical_json(jsonb);
-- notify pgrst, 'reload schema';
