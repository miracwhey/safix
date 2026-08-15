-- Migration: operator access to user_reports
-- Operators (profiles.is_operator = true) can read and update all reports.

-- Operators can read all reports for moderation
create policy "operators_read_all_reports"
  on public.user_reports for select
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.is_operator = true
    )
  );

-- Operators can update report status (review, dismiss, action)
create policy "operators_update_reports"
  on public.user_reports for update
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.is_operator = true
    )
  )
  with check (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.is_operator = true
    )
  );
