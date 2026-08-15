-- disputes RLS — Worker-Branch
--
-- Active workers (team_members.is_active = true) can SELECT and UPDATE disputes
-- for their provider. Worker DELETE stays blocked. INSERT stays owner/customer-only.
--
-- Verified against Prod 2026-05-10: disputes_select_own_side + disputes_update_own_side
-- currently allow opened_by | customer | provider-owner | operator.
-- team_members.profile_id is nullable; NULL != auth.uid() → no false positives.

-- ── SELECT ───────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS disputes_select_own_side ON disputes;

CREATE POLICY disputes_select_own_side ON disputes
  FOR SELECT
  USING (
    opened_by_profile_id = auth.uid()
    OR customer_profile_id = auth.uid()
    OR provider_id IN (
      SELECT id FROM providers WHERE profile_id = auth.uid()
    )
    OR provider_id IN (
      SELECT tm.provider_id FROM team_members tm
      WHERE tm.profile_id = auth.uid() AND tm.is_active = true
    )
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.is_operator = true
    )
  );

-- ── UPDATE ───────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS disputes_update_own_side ON disputes;

CREATE POLICY disputes_update_own_side ON disputes
  FOR UPDATE
  USING (
    opened_by_profile_id = auth.uid()
    OR customer_profile_id = auth.uid()
    OR provider_id IN (
      SELECT id FROM providers WHERE profile_id = auth.uid()
    )
    OR provider_id IN (
      SELECT tm.provider_id FROM team_members tm
      WHERE tm.profile_id = auth.uid() AND tm.is_active = true
    )
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.is_operator = true
    )
  )
  WITH CHECK (
    opened_by_profile_id = auth.uid()
    OR customer_profile_id = auth.uid()
    OR provider_id IN (
      SELECT id FROM providers WHERE profile_id = auth.uid()
    )
    OR provider_id IN (
      SELECT tm.provider_id FROM team_members tm
      WHERE tm.profile_id = auth.uid() AND tm.is_active = true
    )
    OR EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.is_operator = true
    )
  );
