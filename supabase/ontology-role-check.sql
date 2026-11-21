-- Run through the application connection; no tenant claims means zero rows.
\set ON_ERROR_STOP on
begin read only;
set local request.jwt.claims = '{}';
set local role ontology_reader;
select case when
  exists (select 1 from pg_roles where rolname=current_user
    and not (rolcanlogin or rolsuper or rolcreatedb or rolcreaterole or rolinherit or rolbypassrls))
  and not exists (select 1 from unnest(array['public.crm_leads','public.crm_tasks','public.contacts','public.crm_lead_activities','public.organizations']) t
    where has_table_privilege(current_user,t,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
       or has_any_column_privilege(current_user,t,'INSERT,UPDATE'))
  and not exists (select 1 from (values
    ('public.crm_leads','id'),('public.crm_leads','organization_id'),('public.crm_leads','status'),('public.crm_leads','value_cents'),('public.crm_leads','currency'),('public.crm_leads','pipeline_id'),('public.crm_leads','owner_user_id'),
    ('public.crm_tasks','id'),('public.crm_tasks','organization_id'),('public.crm_tasks','lead_id'),('public.crm_tasks','contact_id'),('public.crm_tasks','status'),('public.crm_tasks','due_date'),
    ('public.contacts','id'),('public.contacts','organization_id'),
    ('public.crm_lead_activities','organization_id'),('public.crm_lead_activities','lead_id'),('public.crm_lead_activities','type'),('public.crm_lead_activities','performed_at'),
    ('public.organizations','id'),('public.organizations','settings')) c(t,col)
    where not has_column_privilege(current_user,c.t,c.col,'SELECT'))
  and not exists (select 1 from unnest(array['public.fn_user_org_ids()','public.fn_user_role_in_org(uuid)','public.fn_is_platform_admin()','public.fn_can_view_lead(uuid,uuid)','public.fn_role_at_least(uuid,text)']) f
    where not has_function_privilege(current_user,f,'EXECUTE'))
  -- Inspect the exact zero-argument auth functions by OID: text signature
  -- resolution requires auth schema USAGE, which hosted Supabase does not
  -- grant to ontology_reader and the already-bound RLS policies do not need.
  and not exists (select 1 from (values ('uid'),('jwt')) required(name)
    where not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='auth' and p.proname=required.name and p.pronargs=0 and p.prokind='f'
        and has_function_privilege(current_user,p.oid,'EXECUTE')))
  and not exists (select 1 from unnest(array['public.crm_leads','public.crm_tasks','public.contacts','public.crm_lead_activities','public.organizations']) t
    where not coalesce((select relrowsecurity from pg_class where oid=t::regclass),false))
  and not exists (select 1 from (values ('crm_leads','crm_leads_select'),('crm_tasks','crm_tasks_select'),('contacts','tenant_isolation_contacts_all'),('crm_lead_activities','crm_lead_activities_select'),('organizations','orgs_select')) p(t,n)
    where not exists (select 1 from pg_policies where schemaname='public' and tablename=p.t and policyname=p.n))
  and (select count(id) from public.crm_leads)=0
  and (select count(id) from public.crm_tasks)=0
  and (select count(id) from public.contacts)=0
  and (select count(organization_id) from public.crm_lead_activities)=0
  and (select count(id) from public.organizations)=0
then 'ok' else 'failed' end;
rollback;
