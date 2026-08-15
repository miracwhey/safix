-- =============================================================================
-- Hardening Phase 3 (Audit 2026-07-06): L25 + L6-Orphan
-- Live-verifiziert vor Apply (2026-07-06): profiles-Duplikate haben identische
-- Durchsetzung (with_check-NULL faellt auf USING zurueck; public-Rolle deckt
-- authenticated ab); spatial_is_job_worker in 0 Policies/Funktionen/Views/Code.
-- Applied to prod itdntawwuzqfwmcwnwjr as 20260706090843.
-- =============================================================================

-- L25: exakte Duplikat-Policies auf profiles (identische quals, kommutativ):
--   "Profiles: read own"   ~ "Users can read own profile"   (SELECT, id = auth.uid())
--   "Profiles: update own" ~ "Users can update own profile" (UPDATE, id = auth.uid())
-- Je eins droppen; die breitere "Users can ..."-Variante (roles=public) bleibt.
drop policy if exists "Profiles: read own" on public.profiles;
drop policy if exists "Profiles: update own" on public.profiles;

-- L6-Orphan: spatial_is_job_worker ist nirgends referenziert (0 Policies/Funktionen/
-- Views/Repo-Refs -- Checks 2026-07-06). Uebrige SECDEF-EXECUTEs sind by-design.
revoke execute on function public.spatial_is_job_worker(uuid, uuid) from public, anon, authenticated;
