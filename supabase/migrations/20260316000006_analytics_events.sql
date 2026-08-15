-- Analytics events table
-- Append-only storage for marketplace signals used by the internal metrics layer.
-- No personal data is stored — only event-level signals with entity references.

create table if not exists analytics_events (
  event_id     text primary key,
  event_type   text not null,
  entity_type  text not null,
  entity_id    text not null,
  actor_user_id uuid,
  metadata     jsonb,
  created_at   bigint not null
);

-- Indexes for efficient queries by event type and time range
create index if not exists idx_analytics_events_event_type on analytics_events (event_type);
create index if not exists idx_analytics_events_created_at on analytics_events (created_at desc);

-- Row Level Security: analytics data is operator-only; no public access.
alter table analytics_events enable row level security;

-- Allow authenticated users to insert analytics events (recorded from workflows).
create policy "Authenticated users can insert analytics events"
  on analytics_events
  for insert
  to authenticated
  with check (true);

-- Only operators can read analytics data.
-- Non-operator users cannot query the analytics_events table.
create policy "Operators can read analytics events"
  on analytics_events
  for select
  to authenticated
  using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
        and profiles.is_operator = true
    )
  );
