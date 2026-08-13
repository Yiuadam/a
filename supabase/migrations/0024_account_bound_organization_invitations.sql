-- Account-bound invitations can be accepted from the private notification
-- inbox without putting their invitation secret in a URL. Email invitations
-- remain bound to both the recipient email and the strong fragment secret.
-- This migration also prevents repeated pending joins/invitations from being
-- fanned out under fresh idempotency keys.

-- Retain the oldest pending invitation if an older deployment allowed more
-- than one for the same account or email. Nothing is deleted: superseded rows
-- stay in the decision ledger as cancelled requests.
with ranked as (
  select r.id,
         row_number() over (
           partition by r.organization_id, r.target_user_id
           order by r.created_at, r.id
         ) as position
  from public.organization_requests r
  where r.kind = 'invitation'
    and r.status = 'pending'
    and r.target_user_id is not null
)
update public.organization_requests r
set status = 'cancelled',
    decided_at = coalesce(r.decided_at, now()),
    updated_at = now()
from ranked duplicate
where duplicate.id = r.id and duplicate.position > 1;

with ranked as (
  select r.id,
         row_number() over (
           partition by r.organization_id, lower(r.invitation_email)
           order by r.created_at, r.id
         ) as position
  from public.organization_requests r
  where r.kind = 'invitation'
    and r.status = 'pending'
    and r.invitation_email is not null
)
update public.organization_requests r
set status = 'cancelled',
    decided_at = coalesce(r.decided_at, now()),
    updated_at = now()
from ranked duplicate
where duplicate.id = r.id and duplicate.position > 1;

create unique index if not exists organization_requests_one_pending_target_invitation
  on public.organization_requests (organization_id, target_user_id)
  where kind = 'invitation' and status = 'pending' and target_user_id is not null;

create unique index if not exists organization_requests_one_pending_email_invitation
  on public.organization_requests (organization_id, lower(invitation_email))
  where kind = 'invitation' and status = 'pending' and invitation_email is not null;

create or replace function public.organization_consent_command(
  p_actor uuid,
  p_platform_admin boolean,
  p_action text,
  p_payload jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_requested_role text;
  v_request_id uuid;
  v_request public.organization_requests%rowtype;
  v_membership public.organization_memberships%rowtype;
  v_prior public.organization_command_receipts%rowtype;
  v_join_organization uuid;
  v_join_code text;
  v_effective_payload jsonb;
  v_hash text;
  v_result jsonb;
begin
  if p_actor is null or not exists (select 1 from auth.users u where u.id = p_actor) then
    raise exception 'Sign in required.' using errcode = '42501';
  end if;
  if coalesce(p_platform_admin, false) <> public.organization_actor_is_platform_admin(p_actor) then
    raise exception 'Invalid platform authority.' using errcode = '42501';
  end if;
  if p_action not in ('request_to_join', 'accept_invitation') then
    raise exception 'Unsupported consent action.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 65536 then
    raise exception 'Invalid command data.' using errcode = '22023';
  end if;
  if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{12,120}$' then
    raise exception 'Invalid request identifier.' using errcode = '22023';
  end if;

  if p_action = 'accept_invitation' then
    begin
      v_request_id := nullif(p_payload ->> 'requestId', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'Invitation not found.' using errcode = '42501';
    end;
    if v_request_id is null then
      raise exception 'Invitation not found.' using errcode = '42501';
    end if;
    select r.requested_role into v_requested_role
      from public.organization_requests r
      where r.id = v_request_id
        and r.kind = 'invitation'
        and r.status = 'pending';
  else
    v_requested_role := 'student';
  end if;
  if v_requested_role = 'student'
     and not coalesce((p_payload ->> 'shareFutureHistoryConsent')::boolean, false) then
    raise exception 'Consent to share future practice history is required.' using errcode = '42501';
  end if;

  if p_action = 'request_to_join' then
    begin
      v_join_organization := nullif(p_payload ->> 'organizationId', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'Organization not found.' using errcode = '42501';
    end;
    if v_join_organization is not null then
      select o.join_code into v_join_code
        from public.organizations o
        where o.id = v_join_organization and o.status = 'active';
    else
      select o.id, o.join_code into v_join_organization, v_join_code
        from public.organizations o
        where o.join_code = lower(btrim(p_payload ->> 'code'))
          and o.status = 'active';
    end if;
    if v_join_organization is null or v_join_code is null then
      raise exception 'Organization not found.' using errcode = '42501';
    end if;

    -- One organization/account lock serializes fresh idempotency keys. The
    -- delegated command keeps its own receipt lock as a second line of defence.
    perform pg_advisory_xact_lock(
      ('x' || substr(md5('org-join:' || v_join_organization::text || ':' || p_actor::text), 1, 16))::bit(64)::bigint
    );
    v_effective_payload := jsonb_set(p_payload, '{code}', to_jsonb(v_join_code), true);
    v_hash := encode(sha256(convert_to(p_action || ':' || v_effective_payload::text, 'UTF8')), 'hex');
    select * into v_prior
      from public.organization_command_receipts
      where actor_user_id = p_actor and idempotency_key = p_idempotency_key;
    if found then
      if v_prior.action <> p_action or v_prior.request_hash <> v_hash then
        raise exception 'Request identifier was already used with different data.' using errcode = '22023';
      end if;
      return v_prior.response;
    end if;
    if exists (
      select 1 from public.organization_memberships m
      where m.organization_id = v_join_organization
        and m.user_id = p_actor
        and m.status = 'pending'
    ) or exists (
      select 1 from public.organization_requests r
      where r.organization_id = v_join_organization
        and r.requester_user_id = p_actor
        and r.kind = 'join'
        and r.status = 'pending'
    ) then
      raise exception 'Your join request is already awaiting review.' using errcode = '23505';
    end if;
    if exists (
      select 1 from public.organization_memberships m
      where m.organization_id = v_join_organization
        and m.user_id = p_actor
        and m.status <> 'removed'
    ) then
      raise exception 'You already belong to this organization.' using errcode = '23505';
    end if;
    return public.organization_command(
      p_actor, p_platform_admin, p_action, v_effective_payload, p_idempotency_key
    );
  end if;

  -- Email invitation links and legacy account links with a secret continue
  -- through the original command, which validates the hash and recipient.
  if nullif(btrim(p_payload ->> 'token'), '') is not null then
    return public.organization_command(
      p_actor, p_platform_admin, p_action, p_payload, p_idempotency_key
    );
  end if;

  -- A request-only acceptance is deliberately narrower: it must name this
  -- exact authenticated account and it must not also be an email invitation.
  v_hash := encode(sha256(convert_to(p_action || ':' || p_payload::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(
    ('x' || substr(md5('org-targeted-invitation:' || v_request_id::text), 1, 16))::bit(64)::bigint
  );
  select * into v_prior
    from public.organization_command_receipts
    where actor_user_id = p_actor and idempotency_key = p_idempotency_key;
  if found then
    if v_prior.action <> p_action or v_prior.request_hash <> v_hash then
      raise exception 'Request identifier was already used with different data.' using errcode = '22023';
    end if;
    return v_prior.response;
  end if;

  select * into v_request
    from public.organization_requests r
    where r.id = v_request_id
      and r.kind = 'invitation'
      and r.status = 'pending'
      and r.target_user_id = p_actor
      and r.invitation_email is null
    for update;
  if not found or v_request.requested_role is null then
    raise exception 'Invitation not found.' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.organizations o
    where o.id = v_request.organization_id and o.status = 'active'
  ) then
    raise exception 'Organization is not active.' using errcode = '42501';
  end if;
  if v_request.requested_role = 'student'
     and not public.organization_student_is_eligible(p_actor, v_request.organization_id) then
    raise exception 'An eligible plan or seat is required.' using errcode = '42501';
  end if;

  select * into v_membership
    from public.organization_memberships m
    where m.organization_id = v_request.organization_id and m.user_id = p_actor
    for update;
  if v_membership.id is not null and v_membership.status <> 'removed' then
    raise exception 'You already have an active membership in this organization.' using errcode = '23505';
  end if;

  update public.organization_requests
     set status = 'approved', decided_by = p_actor, decided_at = now(), updated_at = now()
   where id = v_request.id and status = 'pending';
  if v_membership.id is not null then
    update public.organization_memberships
       set role = v_request.requested_role,
           status = 'active',
           share_future_history = true,
           joined_at = coalesce(joined_at, now()),
           status_changed_at = now(),
           updated_at = now()
     where id = v_membership.id;
  else
    insert into public.organization_memberships (
      organization_id, user_id, role, status,
      share_future_history, share_pre_join_history, joined_at
    ) values (
      v_request.organization_id, p_actor, v_request.requested_role, 'active',
      true, false, now()
    );
  end if;
  update public.organization_requests
     set status = 'cancelled', decided_by = p_actor, decided_at = now(), updated_at = now()
   where organization_id = v_request.organization_id
     and kind = 'invitation'
     and status = 'pending'
     and id <> v_request.id
     and (
       target_user_id = p_actor
       or (
         invitation_email is not null
         and exists (
           select 1 from auth.users invited
           where invited.id = p_actor and lower(invited.email) = invitation_email
         )
       )
     );
  perform public.organization_audit(
    v_request.organization_id, p_actor, p_action, p_actor,
    'request', v_request.id, jsonb_build_object('method', 'account_notification')
  );
  v_result := jsonb_build_object(
    'ok', true,
    'portal', public.organization_portal(p_actor, p_platform_admin)
  );
  insert into public.organization_command_receipts (
    actor_user_id, idempotency_key, action, request_hash, response
  ) values (p_actor, p_idempotency_key, p_action, v_hash, v_result);
  return v_result;
exception when invalid_text_representation then
  raise exception 'Invalid consent value.' using errcode = '22023';
end;
$$;

revoke all on function public.organization_consent_command(uuid, boolean, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.organization_consent_command(uuid, boolean, text, jsonb, text)
  to service_role;

notify pgrst, 'reload schema';
