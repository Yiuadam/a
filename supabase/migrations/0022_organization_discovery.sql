-- Privacy-bounded organization discovery and account-bound invitations.
-- User lookup is exact by canonical username and never returns an email.

create or replace function public.organization_discovery(
  p_actor uuid,
  p_platform_admin boolean,
  p_kind text,
  p_query text,
  p_organization uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_query text := lower(btrim(coalesce(p_query, '')));
begin
  if p_actor is null or not exists (select 1 from auth.users u where u.id = p_actor) then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;
  if coalesce(p_platform_admin, false) <> public.organization_actor_is_platform_admin(p_actor) then
    raise exception 'Invalid platform authority.' using errcode = '42501';
  end if;

  if p_kind = 'user' then
    if p_organization is null or v_query !~ '^[a-z0-9][a-z0-9._-]{2,29}$' then
      return jsonb_build_object('kind', 'user', 'results', '[]'::jsonb);
    end if;
    select public.organization_member_role(p_actor, p_organization) into v_role;
    if not coalesce(p_platform_admin, false) and v_role not in ('teacher', 'manager', 'owner') then
      return jsonb_build_object('kind', 'user', 'results', '[]'::jsonb);
    end if;
    return jsonb_build_object('kind', 'user', 'results', coalesce((
      select jsonb_agg(jsonb_build_object(
        'userId', n.user_id,
        'username', n.username,
        'displayName', p.display_name
      ))
      from public.usernames n
      left join public.profiles p on p.id = n.user_id
      where n.username = v_query
        and not exists (
          select 1 from public.organization_memberships m
          where m.organization_id = p_organization
            and m.user_id = n.user_id
            and m.status <> 'removed'
        )
    ), '[]'::jsonb));
  end if;

  if p_kind = 'organization' then
    if char_length(btrim(coalesce(p_query, ''))) < 2 or char_length(p_query) > 80 then
      return jsonb_build_object('kind', 'organization', 'results', '[]'::jsonb);
    end if;
    return jsonb_build_object('kind', 'organization', 'results', coalesce((
      select jsonb_agg(item.result order by item.exact_match desc, item.name_length, item.name)
      from (
        select jsonb_build_object('organizationId', o.id, 'name', o.name) as result,
               lower(o.name) = v_query as exact_match,
               char_length(o.name) as name_length,
               lower(o.name) as name
        from public.organizations o
        where o.status = 'active'
          and position(v_query in lower(o.name)) > 0
          and not exists (
            select 1 from public.organization_memberships m
            where m.organization_id = o.id and m.user_id = p_actor
              and m.status <> 'removed'
          )
        order by exact_match desc, name_length, name
        limit 8
      ) item
    ), '[]'::jsonb));
  end if;

  raise exception 'Invalid search.' using errcode = '22023';
end;
$$;

create or replace function public.organization_invite_account(
  p_actor uuid,
  p_platform_admin boolean,
  p_organization uuid,
  p_target uuid,
  p_role text,
  p_token text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_actor_role text;
  v_hash text;
  v_prior public.organization_command_receipts%rowtype;
  v_request uuid := gen_random_uuid();
  v_response jsonb;
begin
  if p_actor is null or not exists (select 1 from auth.users u where u.id = p_actor) then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;
  if coalesce(p_platform_admin, false) <> public.organization_actor_is_platform_admin(p_actor) then
    raise exception 'Invalid platform authority.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.organizations o where o.id = p_organization and o.status = 'active') then
    raise exception 'Organization not found.' using errcode = '42501';
  end if;
  v_actor_role := public.organization_member_role(p_actor, p_organization);
  if not coalesce(p_platform_admin, false) and v_actor_role not in ('teacher', 'manager', 'owner') then
    raise exception 'Not permitted.' using errcode = '42501';
  end if;
  if v_actor_role = 'teacher' and p_role <> 'student' then
    raise exception 'Teachers can invite students only.' using errcode = '42501';
  end if;
  if p_role not in ('student', 'teacher', 'manager')
     or (p_role = 'manager' and not (coalesce(p_platform_admin, false) or v_actor_role = 'owner')) then
    raise exception 'Invalid role.' using errcode = '42501';
  end if;
  if p_target is null or not exists (select 1 from auth.users u where u.id = p_target) then
    raise exception 'Account not found.' using errcode = '42501';
  end if;
  if p_role = 'student' and not public.organization_student_is_eligible(p_target, p_organization) then
    raise exception 'The student needs an eligible plan or seat.' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.organization_memberships m
    where m.organization_id = p_organization and m.user_id = p_target and m.status <> 'removed'
  ) then
    raise exception 'That person already has a membership in this organization.' using errcode = '23505';
  end if;
  if p_token is null or char_length(p_token) < 24 then
    raise exception 'A strong invitation token is required.' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{12,120}$' then
    raise exception 'Invalid request identifier.' using errcode = '22023';
  end if;

  v_hash := encode(sha256(convert_to(
    'invite_member:' || p_organization::text || ':' || p_target::text || ':' || p_role || ':' || p_token,
    'UTF8'
  )), 'hex');
  perform pg_advisory_xact_lock(
    ('x' || substr(md5('org-invite:' || p_actor::text || ':' || p_idempotency_key), 1, 16))::bit(64)::bigint
  );
  select * into v_prior from public.organization_command_receipts
  where actor_user_id = p_actor and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.request_hash <> v_hash or v_prior.action <> 'invite_member' then
      raise exception 'Request identifier was already used with different data.' using errcode = '22023';
    end if;
    return v_prior.response;
  end if;

  insert into public.organization_requests (
    id, organization_id, kind, requester_user_id, target_user_id,
    requested_role, invitation_token_hash
  ) values (
    v_request, p_organization, 'invitation', p_actor, p_target,
    p_role, encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  );
  perform public.organization_audit(
    p_organization, p_actor, 'invite_member', p_target,
    'request', v_request, jsonb_build_object('role', p_role, 'method', 'username')
  );
  v_response := jsonb_build_object('ok', true, 'invitation', jsonb_build_object('requestId', v_request));
  insert into public.organization_command_receipts (
    actor_user_id, idempotency_key, action, request_hash, response
  ) values (p_actor, p_idempotency_key, 'invite_member', v_hash, v_response);
  return v_response;
end;
$$;

revoke all on function public.organization_discovery(uuid, boolean, text, text, uuid)
  from public, anon, authenticated;
revoke all on function public.organization_invite_account(uuid, boolean, uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.organization_discovery(uuid, boolean, text, text, uuid)
  to service_role;
grant execute on function public.organization_invite_account(uuid, boolean, uuid, uuid, text, text, text)
  to service_role;

notify pgrst, 'reload schema';
