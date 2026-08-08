-- ---------------------------------------------------------------------------
-- Two corrections from the legal review.
--
-- 1. Gender goes. It was collected because it was asked for, and then nothing
--    read it: no page, no plan, no marking. Holding personal data with no
--    purpose is the thing a data protection regime asks you to justify, and
--    the honest answer here was that there was no justification. The column is
--    dropped rather than left empty, because a column that exists will be
--    filled in again by somebody.
--
-- 2. The under-13 claim becomes a control rather than a sentence. /privacy has
--    always said this app is not aimed at children under 13. Nothing checked.
--    A date of birth is now collected, so the claim can be enforced for the
--    first time — and a claim that is enforced is worth more than one that is
--    merely made.
-- ---------------------------------------------------------------------------

alter table public.profiles drop constraint if exists profiles_gender_check;
alter table public.profiles drop column if exists gender;

-- The check lives in the database as well as in the route, for the same reason
-- the role column does: application code can be bypassed by anything that
-- holds a token and talks to PostgREST directly, and a constraint cannot.
alter table public.profiles
  drop constraint if exists profiles_birth_date_check;
alter table public.profiles
  add constraint profiles_birth_date_check
  check (
    birth_date is null
    or (
      birth_date > date '1900-01-01'
      and birth_date < current_date
      -- Thirteen years, to the day.
      and birth_date <= (current_date - interval '13 years')
    )
  );
