-- ---------------------------------------------------------------------------
-- What the billing screen needs that usage_summary cannot answer.
--
-- usage_summary returns one integer: how many requests were admitted inside the
-- window. That is all the meter ever needed, because the meter only has to
-- decide yes or no. A person looking at a usage bar wants two more things, and
-- both are questions about *when*:
--
--   "when does some of this come back?"  and  "what have I been spending it on?"
--
-- The first one is subtler than it looks, because the window rolls. There is no
-- midnight, no reset hour, nothing that empties. Each request expires 24 hours
-- after the moment it was made, one at a time, so the honest answer to "when
-- does my allowance reset" is "your oldest request drops off at
-- <oldest + 24h>". That is what `oldest_at` is for, and the page words it that
-- way rather than inventing a reset that does not exist. Getting this wrong is
-- how a learner ends up refreshing at midnight waiting for something that
-- already happened at 3pm.
--
-- The second is `by_route`: the same count, grouped. It exists because a bar
-- that says "18 of 20" tells a learner they are nearly out and nothing about
-- what to stop doing. Grouped, it says the twelve generated tests are the
-- reason, which is something they can act on.
--
-- Read-only, service_role only, and stable — like usage_summary, and for the
-- same reason: this is the screen's view of the meter, never the meter itself.
-- Nothing here can admit or refuse a request.
-- ---------------------------------------------------------------------------

create or replace function public.usage_detail(
  p_user_id        uuid,
  p_window_seconds integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with window_events as (
    select route, created_at
    from public.usage_events
    where user_id = p_user_id
      and outcome = 'admitted'
      and created_at > now() - make_interval(secs => greatest(p_window_seconds, 1))
  )
  select jsonb_build_object(
    'used', (select count(*)::integer from window_events),
    -- Null when nothing is in the window, which is the same as "nothing to
    -- expire". The caller must handle that rather than being handed a
    -- timestamp that means "never".
    'oldest_at', (select min(created_at) from window_events),
    'by_route', coalesce(
      (
        select jsonb_object_agg(route, n)
        from (
          select route, count(*)::integer as n
          from window_events
          group by route
        ) grouped
      ),
      '{}'::jsonb
    )
  );
$$;

revoke execute on function public.usage_detail(uuid, integer) from public, anon, authenticated;
grant execute on function public.usage_detail(uuid, integer) to service_role;

-- ---------------------------------------------------------------------------
-- The index this leans on.
--
-- Every query above filters by user, by outcome and by a time floor, and the
-- two aggregates both scan the same slice. Without an index this is a
-- sequential scan of usage_events, which is the fastest-growing table in the
-- schema — one row per AI request, forever. It is small today and will not
-- stay small, and the account screen calls this on every load.
--
-- `if not exists` so the file is safe to run twice: supabase/README.md tells a
-- human to paste these into the SQL editor by hand, and a human pasting a file
-- twice is a normal thing to do rather than an error.
-- ---------------------------------------------------------------------------

create index if not exists usage_events_user_admitted_at_idx
  on public.usage_events (user_id, created_at desc)
  where outcome = 'admitted';
