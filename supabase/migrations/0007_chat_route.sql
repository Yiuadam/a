-- ---------------------------------------------------------------------------
-- The tutor chat becomes a fifth metered route.
--
-- `usage_events_route_check` is an allowlist, and that was deliberate in 0001:
-- a typo in a route name would otherwise write rows nobody ever counts, and a
-- meter that quietly stops counting is worse than one that stops working. The
-- cost of that choice is exactly this file — a new AI feature cannot ship
-- without naming itself here.
--
-- It is worth being precise about how the app fails without this migration,
-- because the failure is not the one you would guess. `check_and_record_usage`
-- inserts the usage row *before* it decides, so the refused insert raises
-- inside the RPC, lib/usage/guard.ts logs it and falls closed, and every
-- request to /api/chat answers 503 — for everyone, including admins, and
-- including the callers who are well inside their allowance. So the route is
-- not merely unmetered until this runs; it is entirely dead. That is the right
-- direction to fail in, and it is why this migration is part of shipping the
-- feature rather than a follow-up to it.
--
-- Nothing here is destructive. The new list is a superset of the old one, so
-- no existing row can violate it and Postgres validates the constraint against
-- the table in a single pass with no rewrite. Dropping and re-adding is the
-- only way to widen a CHECK — Postgres has no `alter constraint` for the
-- expression — and `if exists` on the drop keeps the file safe to run twice,
-- which matters because supabase/README.md tells a human to paste these into
-- the SQL editor by hand.
-- ---------------------------------------------------------------------------

alter table public.usage_events
  drop constraint if exists usage_events_route_check;

alter table public.usage_events
  add constraint usage_events_route_check check (
    route in ('define', 'generate', 'grade/writing', 'grade/speaking', 'chat')
  );

-- The name is 'chat' rather than 'tutor' or 'ask' because it has to match the
-- string the route passes to checkAiUsage, and that string is typed once, in
-- lib/usage/limits.ts, as a member of AI_ROUTES. TypeScript keeps the call
-- sites honest against that union; this constraint keeps the database honest
-- against the same list. The two are kept in step by hand, so if you are here
-- adding a route, add it in both places.
