-- Temporary source-side evidence for the Cloudflare-native identity cutover.
--
-- Run this as the Supabase project owner. It exposes no password verifier,
-- session, refresh token or MFA material. Both functions are SECURITY DEFINER
-- and executable only by Supabase's service_role, which the BandUp Worker uses
-- for the single audited copy. Drop both functions when Supabase is retired.

CREATE OR REPLACE FUNCTION public.bandup_native_auth_accounts()
RETURNS TABLE (id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, auth
AS $$
  SELECT users.id::text
    FROM auth.users AS users
   ORDER BY users.id;
$$;

CREATE OR REPLACE FUNCTION public.bandup_native_auth_identities()
RETURNS TABLE (
  auth_user_id text,
  identity_user_id text,
  provider text,
  provider_subject text,
  email text,
  email_verified boolean
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, auth
AS $$
  SELECT
    users.id::text AS auth_user_id,
    identities.user_id::text AS identity_user_id,
    identities.provider::text AS provider,
    identities.provider_id::text AS provider_subject,
    lower(coalesce(nullif(identities.email, ''), nullif(identities.identity_data ->> 'email', ''), users.email)) AS email,
    (
      users.email_confirmed_at IS NOT NULL
      OR coalesce(identities.identity_data ->> 'email_verified', '') = 'true'
    ) AS email_verified
  FROM auth.users AS users
  JOIN auth.identities AS identities ON identities.user_id = users.id
  ORDER BY users.id, identities.provider, identities.provider_id;
$$;

REVOKE ALL ON FUNCTION public.bandup_native_auth_accounts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bandup_native_auth_identities() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bandup_native_auth_accounts() TO service_role;
GRANT EXECUTE ON FUNCTION public.bandup_native_auth_identities() TO service_role;
