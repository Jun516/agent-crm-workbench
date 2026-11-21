-- Run only after seed.sql, outside the model context. The expected data come
-- from independent SQL under authenticated RLS, not from an agent response.
BEGIN READ ONLY;
SELECT set_config('request.jwt.claims', json_build_object('sub', id)::text, true)
  FROM auth.users WHERE email='e2e-manager@pi-native.test' \gset
SET LOCAL ROLE authenticated;
WITH a AS (SELECT id FROM public.organizations WHERE slug='e2e-test-org'),
 leads AS (SELECT l.* FROM public.crm_leads l JOIN a ON a.id=l.organization_id),
 tasks AS (SELECT t.* FROM public.crm_tasks t JOIN a ON a.id=t.organization_id),
 activities AS (SELECT x.* FROM public.crm_lead_activities x JOIN a ON a.id=x.organization_id)
SELECT jsonb_build_object(
 'open', (SELECT coalesce(jsonb_agg(title ORDER BY title),'[]') FROM leads WHERE status='open'),
 'alice_leads', (SELECT coalesce(jsonb_agg(title ORDER BY title),'[]') FROM leads WHERE contact_id='36000003-0000-4000-8000-000000000001'),
 'no_contact', (SELECT coalesce(jsonb_agg(title ORDER BY title),'[]') FROM leads WHERE contact_id IS NULL),
 'a1_activities', (SELECT coalesce(jsonb_agg(jsonb_build_object('type', type, 'performed_at', performed_at) ORDER BY performed_at),'[]') FROM activities WHERE lead_id='36000004-0000-4000-8000-000000000001'),
 'tasks_no_due', (SELECT coalesce(jsonb_agg(title ORDER BY title),'[]') FROM tasks WHERE due_date IS NULL),
 'alice_open', (SELECT coalesce(jsonb_agg(title ORDER BY title),'[]') FROM leads WHERE contact_id='36000003-0000-4000-8000-000000000001' AND status='open'),
 'activity_gap', (SELECT coalesce(jsonb_agg(l.title ORDER BY l.title),'[]') FROM leads l WHERE l.status='open' AND l.value_cents>=100000 AND l.currency='BRL' AND NOT EXISTS (SELECT 1 FROM activities x WHERE x.lead_id=l.id AND x.type='appointment_completed' AND x.performed_at >= '2026-10-31T00:00:00Z'::timestamptz AND x.performed_at < '2026-11-14T00:00:00Z'::timestamptz)),
 'won_interval', (SELECT coalesce(jsonb_agg(title ORDER BY title),'[]') FROM leads WHERE status='won' AND closed_at >= '2026-10-31T00:00:00Z'::timestamptz AND closed_at < '2026-11-14T00:00:00Z'::timestamptz),
 'currency_groups', (SELECT coalesce(jsonb_agg(jsonb_build_object('currency',currency,'sum_cents',total,'missing_values',missing) ORDER BY currency NULLS LAST),'[]') FROM (SELECT currency,sum(value_cents) total,count(*) FILTER (WHERE value_cents IS NULL) missing FROM leads WHERE status='open' GROUP BY currency) x),
 'open_pipeline_p1', (SELECT coalesce(jsonb_agg(title ORDER BY title),'[]') FROM leads WHERE status='open' AND pipeline_id='36000001-0000-4000-8000-000000000001'),
 'cross_tenant', (SELECT count(*) FROM public.crm_leads WHERE title='B1'),
 'task_contact_scope', (SELECT coalesce(jsonb_agg(c.display_name ORDER BY c.display_name),'[]') FROM tasks t JOIN public.contacts c ON c.id=t.contact_id AND c.organization_id=t.organization_id),
 'local_date_boundary', (SELECT ('2026-10-31T02:30:00Z'::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date = '2026-10-31'::date)
) AS manager_oracle;
RESET ROLE;
SELECT set_config('request.jwt.claims', json_build_object('sub', id)::text, true)
  FROM auth.users WHERE email='e2e-agent@pi-native.test' \gset
SET LOCAL ROLE authenticated;
SELECT jsonb_build_object('agent_open', coalesce(jsonb_agg(l.title ORDER BY l.title),'[]')) AS agent_oracle
FROM public.crm_leads l JOIN public.organizations o ON o.id=l.organization_id WHERE o.slug='e2e-test-org' AND l.status='open';
ROLLBACK;
