-- Migration: block reverse visibility
-- Blocked users can see that they are blocked (read-only) so the app can
-- hide the blocker's content from the blocked user's perspective too.
-- This enables true bidirectional content hiding without exposing block details.

-- Blocked users can see the block record (but not who blocked them in detail —
-- the app uses the existence of the row to filter content).
create policy "blocked_users_read_block_record"
  on public.user_blocks for select
  using (auth.uid() = blocked_id);

-- Helper function: check if a block exists in either direction
create or replace function public.is_blocked(user_a uuid, user_b uuid)
returns boolean
language sql
stable
security definer
as $$
  select exists (
    select 1 from public.user_blocks
    where (blocker_id = user_a and blocked_id = user_b)
       or (blocker_id = user_b and blocked_id = user_a)
  );
$$;

comment on function public.is_blocked is
  'Returns true if either user has blocked the other. Use to filter content visibility.';
