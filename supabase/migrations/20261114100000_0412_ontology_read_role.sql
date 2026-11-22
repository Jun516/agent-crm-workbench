-- Narrow, non-login role for ontology templates. Authentication/token lookup
-- occurs before SET LOCAL ROLE; the data query itself has no write privilege.
do $ontology_role$
begin
  if not exists (select 1 from pg_roles where rolname = 'ontology_reader') then
    create role ontology_reader nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  if exists (select 1 from pg_roles where rolname = 'ontology_reader'
      and (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolbypassrls or rolinherit))
    or exists (select 1 from pg_auth_members m join pg_roles r on r.oid=m.member
      where r.rolname='ontology_reader') then
    raise exception 'ontology_reader role is not restricted';
  end if;
  execute format('grant ontology_reader to %I', current_user);
end
$ontology_role$;

grant usage on schema public, auth to ontology_reader;
grant execute on function auth.uid(), auth.jwt() to ontology_reader;
grant execute on function public.fn_user_org_ids(), public.fn_user_role_in_org(uuid),
  public.fn_is_platform_admin(), public.fn_can_view_lead(uuid,uuid),
  public.fn_role_at_least(uuid,text) to ontology_reader;
grant select (id, organization_id, status, value_cents, currency, pipeline_id, owner_user_id)
  on public.crm_leads to ontology_reader;
grant select (id, organization_id, lead_id, contact_id, status, due_date)
  on public.crm_tasks to ontology_reader;
grant select (id, organization_id) on public.contacts to ontology_reader;
grant select (organization_id, lead_id, type, performed_at)
  on public.crm_lead_activities to ontology_reader;
grant select (id, settings) on public.organizations to ontology_reader;
