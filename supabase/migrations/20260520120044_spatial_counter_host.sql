-- Spatial Canonical · Zwischen-Latte · B-2 · Counter-Hosting
--
-- Purpose:
--   Adds the `is_counter_host` catalog flag to `spatial_assets`. It marks an
--   asset (a vanity / kitchen worktop) as a surface that can host other
--   objects on its top — the DB mirror of `CatalogAsset.isCounterHost` in
--   src/lib/spatial/canonical/catalog/asset-catalog.ts.
--
--   A `SpatialObject` with `host = 'counter'` anchors to such an asset; the
--   renderer (`ObjectAdapter`) places it on the counter's top surface and the
--   validator (`checkObjectHostNotFound`) resolves its `host_id` against the
--   room's objects.
--
-- Shape: purely additive — new column defaults to false, existing rows keep
--   working. The backfill aligns prod with the code catalog's two V1 vanities.

alter table public.spatial_assets
  add column if not exists is_counter_host boolean not null default false;

comment on column public.spatial_assets.is_counter_host is
  'True when the asset is a counter / vanity that can host objects on its top surface.';

-- Backfill the V1 counter-host assets (idempotent · no-op when rows are absent).
update public.spatial_assets
  set is_counter_host = true
  where slug in ('sanitary-sink-vanity-rectangle', 'sanitary-sink-double-vanity')
    and is_counter_host = false;
