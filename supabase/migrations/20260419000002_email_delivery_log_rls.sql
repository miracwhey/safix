-- Enable RLS on email_delivery_log.
--
-- This table is written exclusively by server-side API routes using the
-- service-role key, which bypasses RLS. No client-side code reads from it.
-- Enabling RLS with no permissive policies blocks all anon/authenticated
-- access via the PostgREST/anon key, preventing unintentional PII exposure
-- (recipient_email, recipient_user_id) to arbitrary authenticated users.

ALTER TABLE public.email_delivery_log ENABLE ROW LEVEL SECURITY;
