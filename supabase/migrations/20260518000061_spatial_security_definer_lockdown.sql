-- Spatial Core · Final Review hotfix · lock down anon-callable SECURITY DEFINER paths
--
-- Two functions ship with REST exposure that the Supabase advisor flags
-- as anon-executable. Neither needs the anon role:
--
--   * request_scan_download — auth is required (RPC raises 28000 when
--     auth.uid() is null); REST exposure to anon is dead weight.
--   * spatial_notify_convert_done — trigger function only; calling it
--     directly via /rest/v1/rpc would be a privilege-escalation surface.

REVOKE EXECUTE ON FUNCTION public.request_scan_download(uuid, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.spatial_notify_convert_done() FROM anon, authenticated;
