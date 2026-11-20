-- Issue 28: L1 remains the only confirmed truth. L2 is service-owned and never a model fact.
alter table public.ai_customer_memories
  add column if not exists memory_type text not null default 'relationship_context',
  add column if not exists attribute_key text,
  add column if not exists attribute_value text,
  add column if not exists risk_level text not null default 'high',
  add column if not exists retention_policy text not null default 'durable',
  add column if not exists ttl_expires_at timestamptz,
  add column if not exists review_due_at timestamptz,
  add column if not exists locked boolean not null default false,
  add column if not exists needs_review boolean not null default false,
  add column if not exists review_reason text,
  add column if not exists supersedes uuid,
  add column if not exists confirmed_at timestamptz,
  add column if not exists policy_revision integer not null default 1,
  add column if not exists policy_hash text,
  add column if not exists evidence_conversation_id uuid;
update public.ai_customer_memories set confirmed_at=created_at where confirmed_at is null;
alter table public.ai_customer_memories alter column confirmed_at set default now();
alter table public.ai_customer_memories alter column confirmed_at set not null;
create unique index if not exists ai_customer_memories_id_org_contact_idx on public.ai_customer_memories(id,organization_id,contact_id);
create unique index if not exists conversations_memory_evidence_scope_idx on public.conversations(id,organization_id,contact_id);
create unique index if not exists messages_memory_evidence_scope_idx on public.messages(id,organization_id,contact_id,conversation_id);
alter table public.ai_customer_memories drop constraint if exists ai_customer_memory_policy_check;
alter table public.ai_customer_memories add constraint ai_customer_memory_policy_check check (
  memory_type in ('constraint','commercial_preference','communication_preference','temporary_request','relationship_context')
  and risk_level in ('medium','high') and policy_revision>0
  and retention_policy in ('durable','ephemeral')
  and (retention_policy<>'ephemeral' or ttl_expires_at is not null)
  and (retention_policy<>'durable' or ttl_expires_at is null)
  and (memory_type<>'temporary_request' or retention_policy='ephemeral')
  and (not locked or retention_policy='durable')
  and ((attribute_key is null and attribute_value is null) or (attribute_key is not null and attribute_value is not null))
  and (attribute_key is null or (attribute_key ~ '^[a-z][a-z0-9_.-]{0,119}$' and attribute_key !~ '^(order|contract|stage|amount|owner)([_.-]|$)'))
  and (attribute_value is null or char_length(attribute_value)<=300)
  and (policy_hash is null or policy_hash ~ '^[a-f0-9]{64}$')
  and (supersedes is null or supersedes<>id)
);
alter table public.ai_customer_memories drop constraint if exists ai_customer_memory_supersedes_fk;
alter table public.ai_customer_memories add constraint ai_customer_memory_supersedes_fk
  foreign key(supersedes,organization_id,contact_id) references public.ai_customer_memories(id,organization_id,contact_id);
alter table public.ai_customer_memories drop constraint if exists ai_customer_memory_evidence_fk;
alter table public.ai_customer_memories add constraint ai_customer_memory_evidence_fk
  foreign key(evidence_conversation_id,organization_id,contact_id) references public.conversations(id,organization_id,contact_id) on delete set null (evidence_conversation_id);
create index if not exists ai_customer_memory_locked_idx on public.ai_customer_memories(organization_id,contact_id) where locked and deleted_at is null;
create index if not exists ai_customer_memory_expiry_idx on public.ai_customer_memories(ttl_expires_at) where deleted_at is null and retention_policy='ephemeral';

create table if not exists public.ai_customer_memory_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null,
  request_key uuid not null,
  category text not null check(category in ('preference','confirmed_fact','communication_context')),
  memory_type text not null check(memory_type in ('constraint','commercial_preference','communication_preference','temporary_request','relationship_context')),
  body text not null check(char_length(body)<=2000),
  attribute_key text check(attribute_key ~ '^[a-z][a-z0-9_.-]{0,119}$' and attribute_key !~ '^(order|contract|stage|amount|owner)([_.-]|$)'),
  attribute_value text check(char_length(attribute_value)<=300),
  risk_level text not null check(risk_level in ('medium','high')),
  ttl_expires_at timestamptz,
  model_confidence numeric check(model_confidence between 0 and 1),
  normalized_hash text not null check(normalized_hash ~ '^[a-f0-9]{64}$'),
  source_kind text not null check(source_kind in ('explicit','conversation_close','checkpoint','workbench_complete')),
  source_run_id uuid,
  proposed_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check(status in ('pending','confirmed','rejected','merged')),
  confirmed_memory_id uuid,
  merged_into uuid,
  decision_reason text check(char_length(decision_reason)<=1000),
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  rejected_until timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,request_key), unique(id,organization_id,contact_id),
  foreign key(contact_id,organization_id) references public.contacts(id,organization_id) on delete cascade,
  foreign key(source_run_id,organization_id) references public.ai_workbench_runs(id,organization_id) on delete cascade,
  foreign key(confirmed_memory_id,organization_id,contact_id) references public.ai_customer_memories(id,organization_id,contact_id),
  foreign key(merged_into,organization_id,contact_id) references public.ai_customer_memory_candidates(id,organization_id,contact_id),
  check((attribute_key is null)=(attribute_value is null)),
  check(memory_type<>'temporary_request' or ttl_expires_at is not null),
  check(merged_into is null or merged_into<>id),
  check(status<>'confirmed' or confirmed_memory_id is not null),
  check(deleted_at is not null or status<>'rejected' or (decision_reason is not null and decided_at is not null and rejected_until is not null)),
  check(status<>'merged' or merged_into is not null)
);
create unique index if not exists ai_customer_candidate_pending_hash_idx on public.ai_customer_memory_candidates(organization_id,contact_id,normalized_hash) where status='pending' and deleted_at is null;
create index if not exists ai_customer_candidate_queue_idx on public.ai_customer_memory_candidates(organization_id,contact_id,status,created_at);
create table if not exists public.ai_customer_memory_evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null,
  candidate_id uuid not null,
  conversation_id uuid,
  message_id uuid,
  excerpt text not null check(char_length(excerpt)<=2000),
  observed_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key(candidate_id,organization_id,contact_id) references public.ai_customer_memory_candidates(id,organization_id,contact_id) on delete cascade,
  foreign key(conversation_id,organization_id,contact_id) references public.conversations(id,organization_id,contact_id) on delete cascade,
  foreign key(message_id,organization_id,contact_id,conversation_id) references public.messages(id,organization_id,contact_id,conversation_id) on delete cascade,
  check(message_id is null or conversation_id is not null)
);
create unique index if not exists ai_customer_evidence_dedup_idx on public.ai_customer_memory_evidence(candidate_id,message_id,md5(excerpt)) where message_id is not null;
create unique index if not exists crm_leads_memory_scope_idx on public.crm_leads(id,organization_id,contact_id);
create table if not exists public.ai_customer_memory_conflicts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null,
  memory_id uuid not null,
  other_memory_id uuid,
  candidate_id uuid,
  business_lead_id uuid,
  conflict_key text not null,
  kind text not null check(kind in ('l0_l1','l1_l1','l2_l1')),
  status text not null default 'open' check(status in ('open','resolved')),
  resolution text check(char_length(resolution)<=1000),
  resolved_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique(organization_id,contact_id,conflict_key),
  foreign key(contact_id,organization_id) references public.contacts(id,organization_id) on delete cascade,
  foreign key(memory_id,organization_id,contact_id) references public.ai_customer_memories(id,organization_id,contact_id),
  foreign key(other_memory_id,organization_id,contact_id) references public.ai_customer_memories(id,organization_id,contact_id),
  foreign key(candidate_id,organization_id,contact_id) references public.ai_customer_memory_candidates(id,organization_id,contact_id) on delete cascade,
  foreign key(business_lead_id,organization_id,contact_id) references public.crm_leads(id,organization_id,contact_id) on delete set null (business_lead_id)
);
create table if not exists public.ai_customer_memory_usage (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_id uuid not null,
  run_id uuid not null,
  memory_id uuid not null,
  memory_revision text not null,
  policy_revision integer not null,
  used_at timestamptz not null default now(),
  corrected_at timestamptz,
  corrected_by uuid references auth.users(id) on delete set null,
  correction_reason text check(char_length(correction_reason)<=1000),
  primary key(organization_id,run_id,memory_id),
  foreign key(contact_id,organization_id) references public.contacts(id,organization_id) on delete cascade,
  foreign key(run_id,organization_id) references public.ai_workbench_runs(id,organization_id) on delete cascade,
  foreign key(memory_id,organization_id,contact_id) references public.ai_customer_memories(id,organization_id,contact_id)
);
-- SQL pools are trusted backend only. Browser roles cannot read L1 or hypotheses directly.
alter table public.ai_customer_memory_candidates enable row level security;
alter table public.ai_customer_memory_evidence enable row level security;
alter table public.ai_customer_memory_conflicts enable row level security;
alter table public.ai_customer_memory_usage enable row level security;
revoke all on public.ai_customer_memory_candidates,public.ai_customer_memory_evidence,public.ai_customer_memory_conflicts,public.ai_customer_memory_usage from public,anon,authenticated;
grant select,insert,update,delete on public.ai_customer_memory_candidates,public.ai_customer_memory_evidence,public.ai_customer_memory_conflicts,public.ai_customer_memory_usage to service_role;

-- Separate privacy trigger preserves the existing Mem0 cleanup/reconciliation protocol unchanged.
create or replace function public.fn_ai_memory_candidate_privacy() returns trigger
language plpgsql security definer set search_path=public as $$
begin
  if TG_OP='DELETE' then
    -- Confirmed rows survive as content-free remote-cleanup receipts. Optional
    -- references must not retain a contact FK that blocks that tombstone.
    delete from public.ai_customer_memory_usage where organization_id=old.organization_id and contact_id=old.id;
    delete from public.ai_customer_memory_conflicts where organization_id=old.organization_id and contact_id=old.id;
    delete from public.ai_customer_memory_candidates where organization_id=old.organization_id and contact_id=old.id;
    update public.ai_customer_memories set evidence_conversation_id=null,attribute_key=null,attribute_value=null,review_reason=null
      where organization_id=old.organization_id and contact_id=old.id;
    return old;
  end if;
  if new.is_anonymized is true or new.is_merged_into is not null then
    update public.ai_customer_memory_evidence set excerpt='',message_id=null,conversation_id=null
      where organization_id=new.organization_id and contact_id=new.id;
    update public.ai_customer_memory_candidates set body='',attribute_key=null,attribute_value=null,decision_reason=null,
      deleted_at=coalesce(deleted_at,now()),updated_at=now()
      where organization_id=new.organization_id and contact_id=new.id;
    update public.ai_customer_memory_conflicts set resolution=null where organization_id=new.organization_id and contact_id=new.id;
    update public.ai_customer_memory_usage set correction_reason=null where organization_id=new.organization_id and contact_id=new.id;
    update public.ai_customer_memories set attribute_key=null,attribute_value=null,review_reason=null,evidence_conversation_id=null
      where organization_id=new.organization_id and contact_id=new.id;
  end if;
  return new;
end $$;
revoke all on function public.fn_ai_memory_candidate_privacy() from public,anon,authenticated;
drop trigger if exists trg_ai_memory_candidate_privacy on public.contacts;
create trigger trg_ai_memory_candidate_privacy before update of is_anonymized,is_merged_into or delete on public.contacts
  for each row execute function public.fn_ai_memory_candidate_privacy();
notify pgrst,'reload schema';
