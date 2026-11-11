-- Isolated bridge state. No existing memory, calls, archives or Auth settings
-- are read or changed. Only the trusted server role can call these RPCs.
create schema kuzya_bridge;
revoke all on schema kuzya_bridge from public, anon, authenticated;
grant usage on schema kuzya_bridge to service_role;

create table kuzya_bridge.state (
  namespace text primary key check (namespace ~ '^[a-z0-9_-]{1,100}$'),
  revision bigint not null check (revision between 1 and 9007199254740991),
  commit_id uuid not null,
  state jsonb not null,
  updated_at timestamptz not null default now(),
  constraint bridge_state_shape check (
    jsonb_typeof(state) = 'object' and state->'version' = '1'::jsonb and
    jsonb_typeof(state->'tasks') = 'array' and jsonb_array_length(state->'tasks') <= 1000
  )
);
alter table kuzya_bridge.state enable row level security;
revoke all on table kuzya_bridge.state from public, anon, authenticated;
grant select, insert, update on table kuzya_bridge.state to service_role;
create policy bridge_server_only on kuzya_bridge.state for all to service_role using (true) with check (true);

create function public.kuzya_bridge_read_state(p_namespace text)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('revision', s.revision, 'commit_id', s.commit_id, 'state', s.state)
     from kuzya_bridge.state s where s.namespace = p_namespace),
    jsonb_build_object('revision', 0, 'commit_id', null,
      'state', jsonb_build_object('version', 1, 'tasks', '[]'::jsonb))
  );
$$;
revoke all on function public.kuzya_bridge_read_state(text) from public, anon, authenticated;
grant execute on function public.kuzya_bridge_read_state(text) to service_role;

create function public.kuzya_bridge_cas_state(
  p_namespace text, p_expected_revision bigint, p_state jsonb, p_commit_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare written_revision bigint;
begin
  if p_namespace is null or p_namespace !~ '^[a-z0-9_-]{1,100}$' or p_commit_id is null or
     p_expected_revision is null or p_expected_revision < 0 or p_expected_revision >= 9007199254740991 or
     p_state is null or jsonb_typeof(p_state) <> 'object' or
     p_state->'version' is distinct from '1'::jsonb or
     jsonb_typeof(p_state->'tasks') is distinct from 'array' then
    raise exception 'invalid_bridge_state' using errcode = '22023';
  end if;
  if jsonb_array_length(p_state->'tasks') > 1000 or octet_length(p_state::text) > 33554432 then
    raise exception 'bridge_capacity_reached' using errcode = '22023';
  end if;
  if p_state ? 'outbox' then
    if jsonb_typeof(p_state->'outbox') <> 'array' then
      raise exception 'invalid_bridge_state' using errcode = '22023';
    end if;
    if jsonb_array_length(p_state->'outbox') > 2000 then
      raise exception 'bridge_capacity_reached' using errcode = '22023';
    end if;
  end if;
  if p_state ? 'subscriptions' then
    if jsonb_typeof(p_state->'subscriptions') <> 'array' then
      raise exception 'invalid_bridge_state' using errcode = '22023';
    end if;
    if jsonb_array_length(p_state->'subscriptions') > 100 then
      raise exception 'bridge_capacity_reached' using errcode = '22023';
    end if;
  end if;
  -- PostgreSQL serializes conflicting INSERT/UPDATE operations. The revision
  -- predicate is rechecked after waiting; only one process wins a given CAS.
  if p_expected_revision = 0 then
    insert into kuzya_bridge.state(namespace, revision, commit_id, state)
    values(p_namespace, 1, p_commit_id, p_state)
    on conflict(namespace) do nothing returning revision into written_revision;
  else
    update kuzya_bridge.state set revision = revision + 1, commit_id = p_commit_id,
      state = p_state, updated_at = now()
    where namespace = p_namespace and revision = p_expected_revision
    returning revision into written_revision;
  end if;
  if written_revision is null then return jsonb_build_object('committed', false); end if;
  return jsonb_build_object('committed', true, 'revision', written_revision, 'commit_id', p_commit_id);
end;
$$;
revoke all on function public.kuzya_bridge_cas_state(text,bigint,jsonb,uuid) from public, anon, authenticated;
grant execute on function public.kuzya_bridge_cas_state(text,bigint,jsonb,uuid) to service_role;
notify pgrst, 'reload schema';
