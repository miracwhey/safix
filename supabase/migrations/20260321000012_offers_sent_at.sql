-- Adds a canonical sent_at timestamp to offers so send state is persisted even
-- when no job exists yet. Backfills existing rows to keep reload-stable truth.

alter table offers
  add column if not exists sent_at bigint;

update offers
set sent_at = created_at
where sent_at is null;
