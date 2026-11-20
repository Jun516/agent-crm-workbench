-- Issue 28: consumption receipts cover workbench, conversational turns and drafts.
-- No prompt/body copies: the SQL memory remains the only customer-fact authority.
create unique index if not exists job_queue_memory_receipt_scope_idx on public.job_queue(id,organization_id);
create unique index if not exists llm_calls_memory_receipt_scope_idx on public.llm_calls(id,organization_id);
create unique index if not exists ai_reply_drafts_memory_scope_idx on public.ai_reply_drafts(id,organization_id,contact_id);
create table if not exists public.ai_customer_memory_recalls (
 id uuid primary key,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 contact_id uuid not null,
 run_id uuid,
 conversation_id uuid,
 draft_id uuid,
 draft_generation_token uuid,
 job_id uuid,
 call_id uuid,
 purpose text not null,
 call_outcome text not null check(call_outcome in ('success','error')),
 status text not null,
 provider_status text not null,
 coverage text not null check(coverage in ('complete','partial','unavailable')),
 returned_count integer not null check(returned_count between 0 and 32),
 business_coverage text not null check(business_coverage in ('complete','partial','unavailable')),
 injected_at timestamptz not null,
 consumed_at timestamptz not null default now(),
 unique(id,organization_id,contact_id),
 foreign key(contact_id,organization_id) references public.contacts(id,organization_id) on delete cascade,
 foreign key(run_id,organization_id) references public.ai_workbench_runs(id,organization_id) on delete cascade,
 foreign key(conversation_id,organization_id,contact_id) references public.conversations(id,organization_id,contact_id) on delete cascade,
 foreign key(draft_id,organization_id,contact_id) references public.ai_reply_drafts(id,organization_id,contact_id) on delete cascade,
 foreign key(job_id,organization_id) references public.job_queue(id,organization_id) on delete set null(job_id),
 foreign key(call_id,organization_id) references public.llm_calls(id,organization_id) on delete set null(call_id),
 check(run_id is not null or conversation_id is not null),
 check(draft_id is null or conversation_id is not null),
 check(run_id is null or draft_id is null)
);
alter table public.ai_customer_memory_recalls enable row level security;
revoke all on public.ai_customer_memory_recalls from public,anon,authenticated;
grant select,insert,update,delete on public.ai_customer_memory_recalls to service_role;
create index if not exists ai_customer_memory_recalls_run_idx on public.ai_customer_memory_recalls(organization_id,run_id,consumed_at desc);
create index if not exists ai_customer_memory_recalls_draft_idx on public.ai_customer_memory_recalls(organization_id,draft_id,consumed_at desc);
create index if not exists ai_customer_memory_recalls_conversation_idx on public.ai_customer_memory_recalls(organization_id,conversation_id,consumed_at desc);

alter table public.ai_customer_memory_usage
 add column if not exists id uuid not null default gen_random_uuid(),
 add column if not exists recall_id uuid,
 add column if not exists memory_type text,
 add column if not exists risk_level text,
 add column if not exists locked boolean,
 add column if not exists needs_review boolean,
 add column if not exists confirmed_by uuid references auth.users(id) on delete set null,
 add column if not exists confirmed_at timestamptz;
alter table public.ai_customer_memory_usage drop constraint if exists ai_customer_memory_usage_pkey;
alter table public.ai_customer_memory_usage alter column run_id drop not null;
alter table public.ai_customer_memory_usage add primary key(id);
alter table public.ai_customer_memory_usage drop constraint if exists ai_customer_memory_usage_recall_fk;
alter table public.ai_customer_memory_usage add constraint ai_customer_memory_usage_recall_fk
 foreign key(recall_id,organization_id,contact_id) references public.ai_customer_memory_recalls(id,organization_id,contact_id) on delete cascade;
alter table public.ai_customer_memory_usage drop constraint if exists ai_customer_memory_usage_context_check;
alter table public.ai_customer_memory_usage add constraint ai_customer_memory_usage_context_check check(run_id is not null or recall_id is not null);
create unique index if not exists ai_customer_memory_usage_request_idx on public.ai_customer_memory_usage(organization_id,recall_id,memory_id) where recall_id is not null;
create unique index if not exists ai_customer_memory_usage_legacy_idx on public.ai_customer_memory_usage(organization_id,run_id,memory_id) where recall_id is null;
notify pgrst,'reload schema';
