-- Issue 28: local, durable extraction/maintenance. No optional integration is required.
alter table public.job_queue drop constraint if exists job_queue_kind_check;
alter table public.job_queue add constraint job_queue_kind_check check(kind in (
 'inbound_turn','followup_turn','watchdog','flywheel','case_reply_turn','operator_turn',
 'transactional_delivery','approved_reply','workbench_start','workbench_resume','internal_im_event','internal_im_question',
 'customer_memory_extract','customer_memory_consolidate'
));
alter table public.job_queue drop constraint if exists job_queue_turn_needs_contact;
alter table public.job_queue add constraint job_queue_turn_needs_contact check (
 (kind in ('inbound_turn','followup_turn','case_reply_turn','operator_turn','transactional_delivery','approved_reply',
   'customer_memory_extract','customer_memory_consolidate')) = (contact_id is not null)
);
create unique index if not exists orders_memory_scope_idx on public.orders(id,organization_id,contact_id);
alter table public.ai_customer_memory_conflicts add column if not exists business_order_id uuid;
alter table public.ai_customer_memory_conflicts add column if not exists business_fingerprint text;
alter table public.ai_customer_memory_conflicts add column if not exists business_field text;
alter table public.ai_customer_memory_conflicts drop constraint if exists ai_memory_conflict_order_fk;
alter table public.ai_customer_memory_conflicts add constraint ai_memory_conflict_order_fk
 foreign key(business_order_id,organization_id,contact_id) references public.orders(id,organization_id,contact_id) on delete set null (business_order_id);

-- Reassigning a business source must not move a customer's conflict into another contact.
create or replace function public.fn_ai_memory_business_detach() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.contact_id is distinct from old.contact_id or new.organization_id is distinct from old.organization_id then
  if TG_TABLE_NAME='crm_leads' then
   update public.ai_customer_memory_conflicts set business_lead_id=null,status='resolved',resolved_at=now(),resolution='business_source_scope_changed'
    where organization_id=old.organization_id and contact_id=old.contact_id and business_lead_id=old.id;
  else
   update public.ai_customer_memory_conflicts set business_order_id=null,status='resolved',resolved_at=now(),resolution='business_source_scope_changed'
    where organization_id=old.organization_id and contact_id=old.contact_id and business_order_id=old.id;
  end if;
 end if;
 return new;
end $$;
revoke all on function public.fn_ai_memory_business_detach() from public,anon,authenticated;
drop trigger if exists trg_ai_memory_lead_detach on public.crm_leads;
create trigger trg_ai_memory_lead_detach before update of contact_id,organization_id on public.crm_leads for each row execute function public.fn_ai_memory_business_detach();
drop trigger if exists trg_ai_memory_order_detach on public.orders;
create trigger trg_ai_memory_order_detach before update of contact_id,organization_id on public.orders for each row execute function public.fn_ai_memory_business_detach();

create or replace function public.fn_ai_memory_schedule_night(p_org uuid,p_contact uuid,p_after timestamptz default now()) returns uuid
language plpgsql security definer set search_path=public,extensions as $$
declare tz text; due timestamptz; event_id uuid;
begin
 select o.timezone into tz from public.organizations o join public.contacts c on c.organization_id=o.id
  where o.id=p_org and c.id=p_contact and not c.is_anonymized and c.is_merged_into is null;
 if not found then return null; end if;
 if not exists(select 1 from pg_timezone_names where name=tz) then tz:='America/Sao_Paulo'; end if;
 due:=(((p_after at time zone tz)::date+1)+time '02:00') at time zone tz;
 event_id:=extensions.uuid_generate_v5('7d9db30a-0409-5410-8410-000000000001'::uuid,
  'memory-night:'||p_org::text||':'||p_contact::text||':'||(due at time zone tz)::date::text);
 insert into public.event_log(id,organization_id,event_type,entity_kind,entity_id,payload,next_attempt_at)
  values(event_id,p_org,'customer_memory.consolidate','contact',p_contact,
   jsonb_build_object('contact_id',p_contact,'run_after',due),due) on conflict(id) do nothing;
 return event_id;
end $$;
revoke all on function public.fn_ai_memory_schedule_night(uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.fn_ai_memory_schedule_night(uuid,uuid,timestamptz) to service_role;

create or replace function public.fn_ai_memory_emit_extract(p_org uuid,p_contact uuid,p_source text,
 p_conversation uuid,p_revision bigint,p_until timestamptz,p_run uuid default null,p_not_before timestamptz default now(),p_key text default null) returns uuid
language plpgsql security definer set search_path=public,extensions as $$
declare event_id uuid;
begin
 if p_source not in ('conversation_close','checkpoint','workbench_complete','business_change','maintenance_review') then raise exception 'memory_source_invalid'; end if;
 if not exists(select 1 from public.contacts where organization_id=p_org and id=p_contact and not is_anonymized and is_merged_into is null) then return null; end if;
 if p_conversation is not null and not exists(select 1 from public.conversations where organization_id=p_org and contact_id=p_contact and id=p_conversation) then raise exception 'memory_source_scope_invalid'; end if;
 if p_run is not null and not exists(select 1 from public.ai_workbench_runs where organization_id=p_org and id=p_run and scope->>'contactId'=p_contact::text) then raise exception 'memory_source_scope_invalid'; end if;
 if p_until is null or (p_conversation is not null and p_revision is null) then raise exception 'memory_source_boundary_missing'; end if;
 event_id:=extensions.uuid_generate_v5('7d9db30a-0409-5410-8410-000000000002'::uuid,
  concat_ws(':','memory-extract',p_org,p_contact,p_source,p_conversation,p_revision,p_run,coalesce(p_key,to_char(p_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US'))));
 insert into public.event_log(id,organization_id,event_type,entity_kind,entity_id,payload,next_attempt_at)
  values(event_id,p_org,'customer_memory.extract','contact',p_contact,
   jsonb_build_object('contact_id',p_contact,'source_kind',p_source,'conversation_id',p_conversation,
    'service_revision',p_revision,'until_at',p_until,'source_run_id',p_run,'run_after',p_not_before),p_not_before)
  on conflict(id) do nothing;
 return event_id;
end $$;
revoke all on function public.fn_ai_memory_emit_extract(uuid,uuid,text,uuid,bigint,timestamptz,uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.fn_ai_memory_emit_extract(uuid,uuid,text,uuid,bigint,timestamptz,uuid,timestamptz,text) to service_role;

create or replace function public.fn_ai_memory_close_extract() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if not new.is_group and new.status in ('closed','resolved','archived') and old.status is distinct from new.status then
  perform public.fn_ai_memory_emit_extract(new.organization_id,new.contact_id,'conversation_close',new.id,old.service_revision,clock_timestamp());
 end if;
 return new;
end $$;
revoke all on function public.fn_ai_memory_close_extract() from public,anon,authenticated;
drop trigger if exists trg_ai_memory_close_extract on public.conversations;
create trigger trg_ai_memory_close_extract after update of status on public.conversations for each row execute function public.fn_ai_memory_close_extract();

create or replace function public.fn_ai_memory_checkpoint_extract() returns trigger
language plpgsql security definer set search_path=public as $$
declare n bigint; prior_objections jsonb;
begin
 if new.conversation_id is null or new.service_revision is null then return new; end if;
 select count(*) into n from public.lead_checkpoints where organization_id=new.organization_id and contact_id=new.contact_id
  and conversation_id=new.conversation_id and service_revision=new.service_revision and seq<=new.seq;
 select objections into prior_objections from public.lead_checkpoints where organization_id=new.organization_id and contact_id=new.contact_id
  and conversation_id=new.conversation_id and service_revision=new.service_revision and seq<new.seq order by seq desc limit 1;
 if (n%5=0 and new.rolling_summary<>'') or (new.objections<>'[]'::jsonb and new.objections is distinct from coalesce(prior_objections,'[]'::jsonb)) then
  perform public.fn_ai_memory_emit_extract(new.organization_id,new.contact_id,'checkpoint',new.conversation_id,new.service_revision,new.created_at,null,now()+interval '5 minutes');
 end if;
 return new;
end $$;
revoke all on function public.fn_ai_memory_checkpoint_extract() from public,anon,authenticated;
drop trigger if exists trg_ai_memory_checkpoint_extract on public.lead_checkpoints;
create trigger trg_ai_memory_checkpoint_extract after insert on public.lead_checkpoints for each row execute function public.fn_ai_memory_checkpoint_extract();

create or replace function public.fn_ai_memory_task_extract() returns trigger
language plpgsql security definer set search_path=public as $$
declare cid uuid; conv uuid; rev bigint;
begin
 if new.parent_run_id is not null or new.status not in ('completed','partial') or old.status is not distinct from new.status then return new; end if;
 if coalesce(new.scope->>'contactId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return new; end if;
 cid:=(new.scope->>'contactId')::uuid;
 select id,service_revision into conv,rev from public.conversations where organization_id=new.organization_id and contact_id=cid and not is_group
  and (coalesce(new.scope->>'conversationId','')='' or id::text=new.scope->>'conversationId') order by last_message_at desc nulls last,id limit 1;
 perform public.fn_ai_memory_emit_extract(new.organization_id,cid,'workbench_complete',conv,rev,clock_timestamp(),new.id);
 return new;
end $$;
revoke all on function public.fn_ai_memory_task_extract() from public,anon,authenticated;
drop trigger if exists trg_ai_memory_task_extract on public.ai_workbench_runs;
create trigger trg_ai_memory_task_extract after update of status on public.ai_workbench_runs for each row execute function public.fn_ai_memory_task_extract();

create or replace function public.fn_ai_memory_business_extract() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.contact_id is null then return new; end if;
 if not exists(select 1 from public.ai_customer_memories where organization_id=new.organization_id and contact_id=new.contact_id
  and deleted_at is null and (ttl_expires_at is null or ttl_expires_at>now())) then return new; end if;
 if TG_TABLE_NAME='crm_leads' then
  if row(new.stage_id,new.status,new.value_cents,new.currency,new.owner_user_id) is not distinct from row(old.stage_id,old.status,old.value_cents,old.currency,old.owner_user_id) then return new; end if;
 else
  if row(new.status,new.total_cents,new.currency,new.payment_method) is not distinct from row(old.status,old.total_cents,old.currency,old.payment_method) then return new; end if;
 end if;
 perform public.fn_ai_memory_emit_extract(new.organization_id,new.contact_id,'business_change',null,null,clock_timestamp());
 return new;
end $$;
revoke all on function public.fn_ai_memory_business_extract() from public,anon,authenticated;
drop trigger if exists trg_ai_memory_lead_extract on public.crm_leads;
create trigger trg_ai_memory_lead_extract after update of stage_id,status,value_cents,currency,owner_user_id on public.crm_leads for each row execute function public.fn_ai_memory_business_extract();
drop trigger if exists trg_ai_memory_order_extract on public.orders;
create trigger trg_ai_memory_order_extract after update of status,total_cents,currency,payment_method on public.orders for each row execute function public.fn_ai_memory_business_extract();

create or replace function public.fn_ai_memory_changed_schedule() returns trigger
language plpgsql security definer set search_path=public as $$
begin
 if new.contact_id is not null then perform public.fn_ai_memory_schedule_night(new.organization_id,new.contact_id); end if;
 return new;
end $$;
revoke all on function public.fn_ai_memory_changed_schedule() from public,anon,authenticated;
drop trigger if exists trg_ai_memory_changed_schedule on public.ai_customer_memories;
create trigger trg_ai_memory_changed_schedule after insert or update on public.ai_customer_memories for each row execute function public.fn_ai_memory_changed_schedule();
drop trigger if exists trg_ai_candidate_changed_schedule on public.ai_customer_memory_candidates;
create trigger trg_ai_candidate_changed_schedule after insert or update on public.ai_customer_memory_candidates for each row execute function public.fn_ai_memory_changed_schedule();
-- Existing installations enter maintenance too; identity per tenant/contact/local date deduplicates reapplication.
select public.fn_ai_memory_schedule_night(organization_id,contact_id) from (
 select distinct organization_id,contact_id from public.ai_customer_memories where contact_id is not null and deleted_at is null
 union select distinct organization_id,contact_id from public.ai_customer_memory_candidates where deleted_at is null and status='pending'
) subjects;
notify pgrst,'reload schema';
