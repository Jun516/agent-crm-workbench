-- Serialize sequence allocation with the run row already locked by Mission
-- cancellation and approval transactions. Only the trusted service may append.
create or replace function public.fn_append_workbench_event(
  p_org uuid, p_run uuid, p_type text, p_payload jsonb
) returns integer
language plpgsql security definer set search_path = public
as $$
declare v_sequence integer;
begin
  perform 1 from public.ai_workbench_runs
    where organization_id = p_org and id = p_run for update;
  if not found then raise exception 'workbench_run_not_found'; end if;
  insert into public.ai_agent_run_events (organization_id, run_id, sequence, event_type, payload)
    select p_org, p_run, coalesce(max(sequence), 0) + 1, p_type, p_payload
    from public.ai_agent_run_events where organization_id = p_org and run_id = p_run
    returning sequence into v_sequence;
  return v_sequence;
end;
$$;
revoke all on function public.fn_append_workbench_event(uuid,uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.fn_append_workbench_event(uuid,uuid,text,jsonb) to service_role;
