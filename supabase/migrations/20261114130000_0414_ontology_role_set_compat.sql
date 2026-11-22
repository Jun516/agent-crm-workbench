-- Make ontology role bootstrap safe to replay on PostgreSQL 16 and later.
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
  -- PostgreSQL 16+ separates membership from permission to SET ROLE.
  -- A redundant GRANT requires ADMIN OPTION on PostgreSQL 17.
  if not pg_has_role(current_user, 'ontology_reader',
      case when current_setting('server_version_num')::int >= 160000 then 'SET' else 'MEMBER' end) then
    begin
      execute format('grant ontology_reader to %I', current_user);
    exception when insufficient_privilege then
      raise exception 'ontology_reader bootstrap requires ADMIN OPTION or an existing SET-capable membership'
        using errcode = '42501', hint = 'Ask a role administrator to grant ontology_reader to the schema role.';
    end;
  end if;
end
$ontology_role$;
