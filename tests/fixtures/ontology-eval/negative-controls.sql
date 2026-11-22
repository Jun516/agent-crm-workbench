-- Isolated database only. Each mutation is rolled back; every assertion must detect its mutation.
BEGIN;
DO $$
DECLARE before_count integer; after_count integer; a uuid;
BEGIN
  SELECT id INTO STRICT a FROM public.organizations WHERE slug='e2e-test-org';
  SELECT count(*) INTO before_count FROM public.crm_leads WHERE organization_id=a AND contact_id='36000003-0000-4000-8000-000000000001' AND status='open';
  UPDATE public.crm_leads SET contact_id=NULL WHERE id='36000004-0000-4000-8000-000000000001' AND organization_id=a;
  SELECT count(*) INTO after_count FROM public.crm_leads WHERE organization_id=a AND contact_id='36000003-0000-4000-8000-000000000001' AND status='open';
  IF before_count <> 2 OR after_count = before_count THEN RAISE EXCEPTION 'relation negative control not detected'; END IF;
  SELECT count(*) INTO before_count FROM public.crm_leads WHERE organization_id=a AND title='B1';
  SELECT count(*) INTO after_count FROM public.crm_leads WHERE title='B1'; -- deliberately omit tenant scope
  IF before_count <> 0 OR after_count <> 1 THEN RAISE EXCEPTION 'tenant negative control not detected'; END IF;
END $$;
ROLLBACK;
