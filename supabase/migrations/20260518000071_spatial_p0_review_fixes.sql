-- Spatial Core · Post-Review P0 Fixes — Part 1 (enum add only)
--
-- Split from main P0 batch because Postgres rejects ALTER TYPE ADD VALUE
-- mixed with usage of the new value in the same transaction (the new
-- value must be committed before it becomes castable in SQL). The next
-- migration (72) uses 'download_requested' and depends on this commit.

ALTER TYPE public.scan_event_action ADD VALUE IF NOT EXISTS 'download_requested';
