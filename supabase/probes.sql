-- ---------------------------------------------------------------------------
-- Do the locks actually hold?
--
-- Paste the whole file into the Supabase SQL editor and run it. It prints one
-- line per check, each PASS or FAIL. It writes nothing and changes nothing.
--
-- What it does: becomes the `authenticated` role and presents the JWT claims of
-- the first real account in the project, which is what a signed-in learner's
-- token does when it talks to PostgREST directly — bypassing the application
-- entirely. Then it tries the things a learner must not be able to do.
--
-- Worth running once against a real project, because a policy that is subtly
-- wrong looks exactly like a policy that is right.
-- ---------------------------------------------------------------------------

do $probe$
declare
  me    uuid;
  other uuid;
  n     integer;
  msg   text;
  pass  integer := 0;
  fail  integer := 0;
  total integer;
begin
  -- Counted here, while still privileged, so the checks below can say how many
  -- rows exist rather than only how many were visible.
  select count(*) into total from public.profiles;
  select id into me from public.profiles order by created_at limit 1;
  select id into other from public.profiles where id <> me order by created_at limit 1;

  if me is null then
    raise notice 'No accounts yet. Sign in to the app once, then run this again.';
    return;
  end if;

  raise notice '--------------------------------------------------------------';
  raise notice 'Probing as account %', me;
  raise notice 'The project holds % account(s).', total;
  if other is null then
    raise notice ' ';
    raise notice 'Only one account exists, so the "someone else''s row" checks are';
    raise notice 'reported as SKIP. They cannot pass honestly: with nothing to hide,';
    raise notice 'an empty result proves the policy works and an absent policy';
    raise notice 'would look identical. Sign in with a second Google account and';
    raise notice 'run this again to test them for real.';
    raise notice ' ';
  end if;
  raise notice '--------------------------------------------------------------';

  -- Become a signed-in learner: the role a user token maps to, carrying that
  -- user's id as the `sub` claim, which is what auth.uid() reads.
  perform set_config('request.jwt.claims', json_build_object('sub', me, 'role', 'authenticated')::text, true);
  set local role authenticated;

  ---------------------------------------------------------------- 1 ----------
  begin
    select count(*) into n from public.profiles;
    if n = 1 then
      pass := pass + 1; raise notice 'PASS  1. Reading profiles returns 1 row of % that exist.', total;
    else
      fail := fail + 1; raise notice 'FAIL  1. Reading profiles returned % rows of % — it must return only your own.', n, total;
    end if;
  exception when others then
    fail := fail + 1; raise notice 'FAIL  1. Could not read own profile at all (%).', sqlerrm;
  end;

  ---------------------------------------------------------------- 2 ----------
  if other is null then
    raise notice 'SKIP  2. Reading someone else''s profile — needs a second account.';
  else
    begin
      select count(*) into n from public.profiles where id = other;
      if n = 0 then
        pass := pass + 1; raise notice 'PASS  2. Someone else''s profile is invisible.';
      else
        fail := fail + 1; raise notice 'FAIL  2. Someone else''s profile was readable.';
      end if;
    exception when others then
      pass := pass + 1; raise notice 'PASS  2. Someone else''s profile is unreachable (%).', sqlerrm;
    end;
  end if;

  ---------------------------------------------------------------- 3 ----------
  -- The one that matters most: an admin has no usage limit, so a learner who
  -- can write this column can give themselves an uncapped paid API.
  begin
    update public.profiles set role = 'admin' where id = me;
    fail := fail + 1; raise notice 'FAIL  3. A learner promoted themselves to admin.';
  exception when others then
    pass := pass + 1;
    get stacked diagnostics msg = message_text;
    raise notice 'PASS  3. Cannot promote self to admin (%).', msg;
  end;

  ---------------------------------------------------------------- 4 ----------
  begin
    perform public.set_account_role('anything@example.com', 'admin');
    fail := fail + 1; raise notice 'FAIL  4. set_account_role is callable by a learner.';
  exception when others then
    pass := pass + 1;
    get stacked diagnostics msg = message_text;
    raise notice 'PASS  4. set_account_role is not callable by a learner (%).', msg;
  end;

  ---------------------------------------------------------------- 5 ----------
  -- A meter anyone can call is a meter anyone can reset.
  begin
    perform public.check_and_record_usage(me, 'x', 'define', 3600, '{"free":20}'::jsonb);
    fail := fail + 1; raise notice 'FAIL  5. The usage meter is callable from outside the app.';
  exception when others then
    pass := pass + 1;
    get stacked diagnostics msg = message_text;
    raise notice 'PASS  5. The usage meter is not callable by a learner (%).', msg;
  end;

  ---------------------------------------------------------------- 6 ----------
  begin
    perform public.resolve_entitlement(me);
    fail := fail + 1; raise notice 'FAIL  6. resolve_entitlement is callable by a learner.';
  exception when others then
    pass := pass + 1;
    get stacked diagnostics msg = message_text;
    raise notice 'PASS  6. resolve_entitlement is not callable by a learner (%).', msg;
  end;

  ---------------------------------------------------------------- 7 ----------
  if other is null then
    raise notice 'SKIP  7. Reading someone else''s progress — needs a second account.';
  else
    begin
      select count(*) into n from public.progress_snapshots where user_id = other;
      if n = 0 then
        pass := pass + 1; raise notice 'PASS  7. Someone else''s saved progress is invisible.';
      else
        fail := fail + 1; raise notice 'FAIL  7. Someone else''s saved progress was readable.';
      end if;
    exception when others then
      pass := pass + 1; raise notice 'PASS  7. Someone else''s progress is unreachable (%).', sqlerrm;
    end;
  end if;

  ---------------------------------------------------------------- 8 ----------
  -- Deleting your own usage rows would give the allowance back.
  begin
    delete from public.usage_events where user_id = me;
    fail := fail + 1; raise notice 'FAIL  8. A learner can delete their own usage history.';
  exception when others then
    pass := pass + 1;
    get stacked diagnostics msg = message_text;
    raise notice 'PASS  8. Usage history cannot be deleted by a learner (%).', msg;
  end;

  ---------------------------------------------------------------- 9 ----------
  -- Billing payloads are not user-facing data.
  begin
    select count(*) into n from public.provider_events;
    fail := fail + 1; raise notice 'FAIL  9. Billing provider events are readable by a learner.';
  exception when others then
    pass := pass + 1;
    get stacked diagnostics msg = message_text;
    raise notice 'PASS  9. Billing provider events are unreachable (%).', msg;
  end;

  --------------------------------------------------------------- 10 ----------
  -- Writing progress directly would make the record itself untrusted input.
  begin
    insert into public.progress_snapshots (user_id, store_key, payload)
    values (me, 'ielts-prep-v1', '{"forged":true}');
    fail := fail + 1; raise notice 'FAIL 10. A learner can write progress straight into the database.';
  exception when others then
    pass := pass + 1;
    get stacked diagnostics msg = message_text;
    raise notice 'PASS 10. Progress cannot be written directly (%).', msg;
  end;

  reset role;
  raise notice '--------------------------------------------------------------';
  if fail = 0 then
    raise notice 'All % checks passed. Nothing was written or changed.', pass;
  else
    raise notice '% passed, % FAILED — read the FAIL lines above.', pass, fail;
  end if;
  raise notice '--------------------------------------------------------------';
end;
$probe$;
