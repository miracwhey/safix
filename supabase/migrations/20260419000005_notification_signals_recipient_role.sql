-- Add recipient_role to notification_signals; scope SELECT and UPDATE per role.
--
-- Problem: notification_signals.read is a single shared boolean per row.
-- Without role-scoped access, calling markAllRead() as one role can mark
-- the other role's unread state, and unread counts aggregate both roles.
--
-- Fix:
--   1. Add recipient_role column (default 'craftsman' for backward compat).
--   2. Recreate SELECT policy so each role fetches only its own rows —
--      craftsman fetches craftsman rows, customer fetches customer rows.
--      This naturally isolates the in-memory cache in each repository, so
--      markAllRead() and getUnread() only operate on the caller's signals.
--   3. Recreate UPDATE policy with matching recipient_role scoping.
--
-- INSERT is unchanged: craftsmen can insert rows of any recipient_role for
-- their jobs (the bridge inserts customer-targeted rows from the craftsman
-- session on dual-role events).

ALTER TABLE public.notification_signals
  ADD COLUMN IF NOT EXISTS recipient_role text NOT NULL DEFAULT 'craftsman';

-- ── SELECT ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS notification_signals_select_own ON public.notification_signals;

CREATE POLICY notification_signals_select_own ON public.notification_signals
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM jobs j
      LEFT JOIN providers p ON (p.id = j.provider_id)
      WHERE j.id = notification_signals.job_id
        AND (
          (notification_signals.recipient_role = 'craftsman' AND p.profile_id = auth.uid())
          OR (notification_signals.recipient_role = 'customer'
              AND j.customer_user_id::text = auth.uid()::text)
        )
    )
  );

-- ── UPDATE ─────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS notification_signals_update_own ON public.notification_signals;

CREATE POLICY notification_signals_update_own ON public.notification_signals
  FOR UPDATE USING (
    EXISTS (
      SELECT 1
      FROM jobs j
      LEFT JOIN providers p ON (p.id = j.provider_id)
      WHERE j.id = notification_signals.job_id
        AND (
          (notification_signals.recipient_role = 'craftsman' AND p.profile_id = auth.uid())
          OR (notification_signals.recipient_role = 'customer'
              AND j.customer_user_id::text = auth.uid()::text)
        )
    )
  );
