-- Logical synthetic fixture only: omit nondeterministic timestamps and test-user UUIDs.
WITH fixture_orgs AS (SELECT id, slug FROM public.organizations WHERE slug IN ('e2e-test-org', 'ontology-36-tenant-b'))
SELECT jsonb_build_object(
  'pipelines', (SELECT coalesce(jsonb_agg(jsonb_build_array(p.id,o.slug,p.name,p.slug) ORDER BY p.id),'[]') FROM crm_pipelines p JOIN fixture_orgs o ON o.id=p.organization_id WHERE p.id::text LIKE '36000001-%'),
  'stages', (SELECT coalesce(jsonb_agg(jsonb_build_array(s.id,o.slug,s.pipeline_id,s.name,s.slug,s.position,s.is_won,s.is_lost) ORDER BY s.id),'[]') FROM crm_stages s JOIN fixture_orgs o ON o.id=s.organization_id WHERE s.id::text LIKE '36000002-%'),
  'contacts', (SELECT coalesce(jsonb_agg(jsonb_build_array(c.id,o.slug,c.name,c.display_name) ORDER BY c.id),'[]') FROM contacts c JOIN fixture_orgs o ON o.id=c.organization_id WHERE c.id::text LIKE '36000003-%'),
  'leads', (SELECT coalesce(jsonb_agg(jsonb_build_array(l.id,o.slug,l.pipeline_id,l.stage_id,l.contact_id,l.title,l.status,l.value_cents,l.currency,l.closed_at,CASE WHEN l.owner_user_id=(SELECT id FROM auth.users WHERE email='e2e-agent@pi-native.test') THEN 'agent_a' ELSE l.owner_user_id::text END) ORDER BY l.id),'[]') FROM crm_leads l JOIN fixture_orgs o ON o.id=l.organization_id WHERE l.id::text LIKE '36000004-%'),
  'activities', (SELECT coalesce(jsonb_agg(jsonb_build_array(a.id,o.slug,a.lead_id,a.contact_id,a.source_module,a.type,a.performed_at) ORDER BY a.id),'[]') FROM crm_lead_activities a JOIN fixture_orgs o ON o.id=a.organization_id WHERE a.id::text LIKE '36000005-%'),
  'tasks', (SELECT coalesce(jsonb_agg(jsonb_build_array(t.id,o.slug,t.title,t.lead_id,t.contact_id,t.due_date,t.status) ORDER BY t.id),'[]') FROM crm_tasks t JOIN fixture_orgs o ON o.id=t.organization_id WHERE t.id::text LIKE '36000006-%')
);
