-- Operator Action Audit Log
--
-- Provides a permanent, tamper-evident record of every privileged operator
-- action that affects system state (dispute resolution, manual payment
-- releases/refunds, etc.).
--
-- This table is append-only in normal operation. No UPDATE or DELETE is
-- issued by application code.

create table if not exists operator_action_audit (
  id           uuid    primary key default gen_random_uuid(),
  operator_id  uuid    not null,
  action_type  text    not null,
  entity_type  text    not null,
  entity_id    uuid,
  metadata     jsonb,
  created_at   bigint  not null default extract(epoch from now()) * 1000
);

-- Allow efficient lookup of all actions performed by a given operator.
create index if not exists index_operator_action_audit_operator
  on operator_action_audit (operator_id);

-- Allow efficient time-range queries and chronological listing.
create index if not exists index_operator_action_audit_created
  on operator_action_audit (created_at);

-- Row-Level Security: operators may insert their own audit entries.
-- Only service-role / platform code may read the full log.
alter table operator_action_audit enable row level security;

create policy "Operators can insert own audit entries"
  on operator_action_audit
  for insert
  with check (operator_id = auth.uid());
