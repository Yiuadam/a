-- ---------------------------------------------------------------------------
-- Profile fields: what a learner chooses to tell us about themselves.
--
-- Every column here is optional and every one is nullable. That is not
-- politeness, it is the design: none of this is needed to sit a practice test,
-- mark an essay or apply a usage limit, so an account that holds nothing but
-- an id must keep working exactly as well as one that is filled in.
--
-- The two personal ones are worth naming plainly, because a schema is where
-- data collection quietly becomes permanent:
--
--   gender      has no use anywhere in this application. It is stored because
--               it was asked for, it is optional, it is free text so nobody is
--               told which answers exist, and it is disclosed on /privacy.
--   birth_date  is the one with a purpose. /privacy states this app is not
--               aimed at children under 13, and a date of birth is the only
--               way that claim can ever be checked rather than asserted.
--
-- Anything added to this table has to be added to app/privacy/page.tsx in the
-- same change. A field held but not disclosed makes the policy false.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists display_name text,
  add column if not exists avatar_path  text,
  add column if not exists gender       text,
  add column if not exists birth_date   date;

-- A name is shown back to the person who typed it and to nobody else, so the
-- only limits are the ones that keep it renderable.
alter table public.profiles
  drop constraint if exists profiles_display_name_check;
alter table public.profiles
  add constraint profiles_display_name_check
  check (display_name is null or char_length(trim(display_name)) between 1 and 60);

alter table public.profiles
  drop constraint if exists profiles_gender_check;
alter table public.profiles
  add constraint profiles_gender_check
  check (gender is null or char_length(trim(gender)) between 1 and 40);

-- A date in the future is a typo, and one before 1900 is a different typo.
-- Neither is worth a friendly error; both are worth refusing to store.
alter table public.profiles
  drop constraint if exists profiles_birth_date_check;
alter table public.profiles
  add constraint profiles_birth_date_check
  check (birth_date is null or (birth_date > date '1900-01-01' and birth_date < current_date));

-- ---------------------------------------------------------------------------
-- Avatars.
--
-- A private bucket, not a public one. The usual reasoning for public avatars is
-- that other people need to see them — and here nobody does. BandUp has no
-- profile pages, no leaderboards and no comments, so a learner's picture is
-- shown to exactly one person: the learner. A public bucket would put it at a
-- guessable URL for no benefit at all.
--
-- The application therefore hands out short-lived signed URLs instead. See
-- lib/auth/supabase.ts.
-- ---------------------------------------------------------------------------

-- Both blocks below are guarded, and they are guarded separately.
--
-- The reason is the SQL editor: it runs a pasted file as a single transaction,
-- so one refused statement rolls back everything above it. Storage is the part
-- of this file most likely to be refused — `storage.buckets` and
-- `storage.objects` are owned by `supabase_storage_admin`, and not every
-- project's SQL editor is a member of that role — and it would take the
-- profile columns down with it. Those columns are what the application
-- actually needs; the bucket can be made by hand in thirty seconds and the
-- policy is a second lock on a private bucket. The optional part must not be
-- able to veto the necessary part.
--
-- Two blocks rather than one because a plpgsql exception handler rolls back
-- its own block: a refused policy in the same block would undo a bucket that
-- had already been created.
--
-- Nothing is swallowed. Each handler reports the real error as a notice.

do $guard$
begin
  execute $stmt$
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('avatars', 'avatars', false, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public             = excluded.public,
          file_size_limit    = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types
  $stmt$;
exception
  when others then
    raise notice 'Could not create the avatars bucket (%). Everything else in this file applied. Make it by hand: Storage -> New bucket, name "avatars", Public OFF, file size limit 2 MB, allowed MIME types image/jpeg, image/png, image/webp. Profile pictures will not upload until it exists.', sqlerrm;
end;
$guard$;

-- Objects live under a folder named for the owner's id, which is what the
-- policy below matches on. Two things about it are worth stating plainly,
-- because the obvious version of this policy does nothing at all.
--
-- It matches on the *path*, not on `owner`. Every avatar is uploaded by the
-- server holding the service role key, and the service role has no auth.uid()
-- — so `owner` is null on every row this application will ever create, and a
-- policy reading `owner = auth.uid()` can never match anything. It looks like
-- a lock and is a picture of one.
--
-- It grants select and nothing else. The application writes through the
-- service role, which bypasses this policy entirely, so a client write grant
-- would buy no feature and would let anyone with a token fill their own folder
-- with 2 MB files. Same rule as 0002: read your own rows, write nothing.
do $guard$
begin
  execute $stmt$
    drop policy if exists "avatars are readable by their owner" on storage.objects
  $stmt$;
  execute $stmt$
    create policy "avatars are readable by their owner"
      on storage.objects for select
      to authenticated
      using (
        bucket_id = 'avatars'
        and split_part(name, '/', 1) = (select auth.uid())::text
      )
  $stmt$;

  -- Policies from an earlier draft of this file that keyed on `owner`. They
  -- never matched a row; dropping them stops them reading as protection.
  execute $stmt$drop policy if exists "avatars are writable by their owner" on storage.objects$stmt$;
  execute $stmt$drop policy if exists "avatars are replaceable by their owner" on storage.objects$stmt$;
  execute $stmt$drop policy if exists "avatars are deletable by their owner" on storage.objects$stmt$;
exception
  when others then
    raise notice 'Skipped the avatars storage policy (%). Nothing is exposed: the bucket is private, no client role holds a storage grant, and every read is a short-lived signed URL issued by the server. Add it from Storage -> Policies if you want the second lock.', sqlerrm;
end;
$guard$;
