-- provider_media.sort_order: integer → bigint
--
-- The portfolio create paths (createPortfolioItemFromUpload,
-- createPortfolioItemFromJob in src/lib/providerMedia/portfolioItemService.ts)
-- use Date.now() as the sort value so newest entries surface first without
-- a separate read-modify-write. Date.now() is a 13-digit ms-epoch value
-- (1.78e12 in May 2026) which exceeds the int4 ceiling of 2.147e9, causing
-- every publish attempt to fail with PG 22003 "out of range for type integer".
--
-- Widening to bigint fixes the failure path. The conversion is loss-free
-- (every int4 fits in int8) and only rewrites the column metadata when
-- USING is the identity cast, but PostgreSQL still requires a table rewrite
-- on this kind of ALTER COLUMN TYPE — provider_media is small (portfolio
-- entries per provider), so the rewrite is fast.

ALTER TABLE public.provider_media
  ALTER COLUMN sort_order TYPE bigint USING sort_order::bigint;

-- Default + NOT NULL survive the type change, but re-state DEFAULT so the
-- new literal is bigint-typed and matches future inserts at the planner
-- level without an implicit cast.
ALTER TABLE public.provider_media
  ALTER COLUMN sort_order SET DEFAULT 0;
