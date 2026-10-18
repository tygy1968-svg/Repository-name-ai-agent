-- Laboratory-only proposal. NOT applied to Supabase production.
-- Append-only ledger with separate namespace and no client access by default.
create table if not exists public.kuzya_decision_ledger_lab (
  id uuid primary key default gen_random_uuid(),
  namespace text not null check (namespace ~ '^lab-[a-z0-9-]{1,64}$'),
  event_id text not null check (char_length(event_id) between 1 and 128),
  parent_event_id text,
  event_type text not null check (event_type in ('decision','observation','correction','checkpoint')),
  summary text not null check (char_length(summary) between 1 and 4000),
  reason text not null default '' check (char_length(reason) <= 4000),
  event_timestamp timestamptz not null,
  inserted_at timestamptz not null default now(),
  unique (namespace, event_id),
  foreign key (namespace, parent_event_id)
    references public.kuzya_decision_ledger_lab(namespace, event_id),
  check (event_type <> 'correction' or parent_event_id is not null)
);

alter table public.kuzya_decision_ledger_lab enable row level security;
revoke all on public.kuzya_decision_ledger_lab from anon, authenticated;
-- No policies: client roles cannot read or write. Never expose service_role credentials.
-- Application-side append-only writes must be enforced through a dedicated role and grants
-- before this schema is used. No UPDATE or DELETE permissions should be granted.
