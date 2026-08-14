-- Organization creation no longer asks applicants for an open-ended purpose.
-- Keep the legacy non-null column compatible with already-installed databases
-- while ensuring old clients and direct RPC calls cannot reintroduce arbitrary
-- purpose text.

alter table public.organization_applications
  alter column purpose set default 'Organization workspace request.';

create or replace function public.organization_application_neutral_purpose()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.purpose := 'Organization workspace request.';
  return new;
end;
$$;

drop trigger if exists organization_applications_neutral_purpose
  on public.organization_applications;
create trigger organization_applications_neutral_purpose
  before insert or update of purpose on public.organization_applications
  for each row execute function public.organization_application_neutral_purpose();

revoke all on function public.organization_application_neutral_purpose()
  from public, anon, authenticated;
