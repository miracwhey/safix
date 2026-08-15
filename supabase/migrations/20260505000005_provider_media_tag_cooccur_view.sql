-- 20260505000005_provider_media_tag_cooccur_view.sql
--
-- Tag co-occurrence view powering the Reels "Für dich" tag-adjacency boost.
--
-- Why
--   The for-you ranker scores reels by the viewer's like/save tag history.
--   A pure equality match misses semantically adjacent tags: a viewer who
--   liked items tagged "Bad" should also see items tagged "Fliesen" or
--   "Sanitär", because those tags routinely co-occur on the same portfolio
--   item. The view exposes that co-occurrence so the ranker can pull
--   adjacent tags with a single keyset SELECT.
--
-- Shape
--   For every published portfolio item with N >= 2 trade_tags, we emit the
--   N*(N-1) ordered pairs of (tag_a, tag_b). Aggregation produces a count
--   of how many publicly-visible items contain both tags. The ranker reads
--   tag_b values for a given tag_a, sorted by count desc.
--
-- Why a regular VIEW (not materialized)
--   Volume is small (< 10k items expected for the next year) and the view
--   reads only the items the caller can see anyway (RLS on provider_media
--   restricts to public providers). Materialization would add a refresh
--   pipeline that can drift; the regular view is always consistent. If
--   adjacency lookups become a hotspot we can swap in a materialized view
--   + nightly REFRESH or an indexed table without changing callers.
--
-- Filters (intentionally tight)
--   - kind='portfolio'        → ignore avatars, covers, etc.
--   - published=true          → unpublished drafts must not seed adjacency.
--   - tag_a <> tag_b          → drop self-pairs.
--   - non-empty trimmed tags  → defensive against any '' rows.
--
-- Permissions
--   GRANT SELECT to anon + authenticated. The view itself does not bypass
--   RLS (default security_invoker) — it sees what the caller could see via
--   provider_media's existing policies. After PR-A those policies admit any
--   public-provider row, so adjacency reflects the public surface.

CREATE OR REPLACE VIEW public.provider_media_tag_cooccur AS
SELECT
  t1.tag::text          AS tag_a,
  t2.tag::text          AS tag_b,
  count(*)::integer     AS cooccur_count
FROM public.provider_media pm
CROSS JOIN LATERAL unnest(pm.trade_tags) AS t1(tag)
CROSS JOIN LATERAL unnest(pm.trade_tags) AS t2(tag)
WHERE pm.kind      = 'portfolio'
  AND pm.published = true
  AND t1.tag <> t2.tag
  AND t1.tag IS NOT NULL AND length(trim(t1.tag)) > 0
  AND t2.tag IS NOT NULL AND length(trim(t2.tag)) > 0
GROUP BY t1.tag, t2.tag;

GRANT SELECT ON public.provider_media_tag_cooccur TO anon, authenticated;

COMMENT ON VIEW public.provider_media_tag_cooccur IS
  'M3.2 ranking adjacency: counts of (tag_a, tag_b) co-occurrences across '
  'public published portfolio items. Read-only; no RLS bypass. The Reels '
  'for-you ranker queries tag_b values by tag_a sorted by count desc.';
