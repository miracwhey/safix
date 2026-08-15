-- Enable Realtime on craftsman_subscriptions
--
-- REPLICA IDENTITY FULL required so RLS-filtered UPDATE/DELETE events include
-- the OLD row's profile_id for per-user channel filtering.
-- Without FULL, only PK is in OLD.* — filtered DELETE events are dropped silently.

ALTER TABLE public.craftsman_subscriptions REPLICA IDENTITY FULL;
ALTER PUBLICATION supabase_realtime ADD TABLE public.craftsman_subscriptions;
