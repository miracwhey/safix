-- Migration: user_reports & user_blocks tables
-- Adds safety infrastructure for FixUp marketplace: users can report and block others.

-- ============================================================
-- 1. user_reports
-- ============================================================
create table if not exists public.user_reports (
  id            uuid primary key default gen_random_uuid(),
  reporter_id   uuid not null references public.profiles(id) on delete cascade,
  reported_id   uuid not null references public.profiles(id) on delete cascade,
  reason        text not null,           -- enum-like: 'spam','harassment','fraud','inappropriate','other'
  details       text,                    -- free-text elaboration
  context_type  text,                    -- optional: 'job','conversation','offer','profile'
  context_id    uuid,                    -- optional FK to the related entity
  status        text not null default 'pending',  -- 'pending','reviewed','dismissed','actioned'
  reviewed_by   uuid references public.profiles(id),
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now(),

  constraint reports_no_self_report check (reporter_id <> reported_id)
);

comment on table public.user_reports is 'User-submitted reports against other users for safety review.';

-- ============================================================
-- 2. user_blocks
-- ============================================================
create table if not exists public.user_blocks (
  id            uuid primary key default gen_random_uuid(),
  blocker_id    uuid not null references public.profiles(id) on delete cascade,
  blocked_id    uuid not null references public.profiles(id) on delete cascade,
  created_at    timestamptz not null default now(),

  constraint blocks_no_self_block check (blocker_id <> blocked_id),
  constraint blocks_unique_pair  unique (blocker_id, blocked_id)
);

comment on table public.user_blocks is 'Bidirectional block relationships between users.';

-- ============================================================
-- 3. Indexes
-- ============================================================
create index if not exists idx_user_reports_reporter   on public.user_reports(reporter_id);
create index if not exists idx_user_reports_reported   on public.user_reports(reported_id);
create index if not exists idx_user_reports_status     on public.user_reports(status);
create index if not exists idx_user_blocks_blocker     on public.user_blocks(blocker_id);
create index if not exists idx_user_blocks_blocked     on public.user_blocks(blocked_id);

-- ============================================================
-- 4. RLS
-- ============================================================
alter table public.user_reports enable row level security;
alter table public.user_blocks  enable row level security;

-- Reports: users can insert their own reports and read reports they filed
create policy "users_insert_own_reports"
  on public.user_reports for insert
  with check (auth.uid() = reporter_id);

create policy "users_read_own_reports"
  on public.user_reports for select
  using (auth.uid() = reporter_id);

-- Blocks: users manage their own blocks
create policy "users_insert_own_blocks"
  on public.user_blocks for insert
  with check (auth.uid() = blocker_id);

create policy "users_read_own_blocks"
  on public.user_blocks for select
  using (auth.uid() = blocker_id);

create policy "users_delete_own_blocks"
  on public.user_blocks for delete
  using (auth.uid() = blocker_id);
