/**
 * Provider-Pre-Sales-Spatial · Domain Types (V1.5 · Phase B-P1)
 *
 * A provider-presales-project (PSP) is a 3D-aufmaß the provider runs BEFORE a
 * customer-job exists. The provider scans the room, prepares a quote, then
 * converts the PSP to a real `jobs` row once the customer agrees.
 *
 * Lifecycle:
 *   draft → scanned → quoted → converted (terminal) | archived (terminal)
 *
 * Anchors:
 *   - provider_org_id is the hard ownership key (RLS).
 *   - created_by_user_id is the audit-attribution (immutable post-create).
 *   - converted_to_job_id is set ONLY when status transitions to 'converted'.
 *
 * Customer fields (`customer_*_draft`) are free-text BEFORE conversion. After
 * conversion, the canonical customer lives on `jobs.customer_user_id` etc.
 */

export type PresalesProjectStatus =
  | 'draft'
  | 'scanned'
  | 'quoted'
  | 'converted'
  | 'archived'

export interface PresalesProject {
  id: string
  providerOrgId: string
  createdByUserId: string

  title: string
  locationHint: string | null

  customerNameDraft: string | null
  customerEmailDraft: string | null
  customerPhoneDraft: string | null
  notes: string | null

  status: PresalesProjectStatus

  scannedAt: string | null
  quotedAt: string | null
  convertedAt: string | null
  convertedToJobId: string | null

  createdAt: string
  updatedAt: string
}

/** Allowed forward transitions (terminal states excluded).
 *
 * V1.5 design: conversion (`→ converted`) is allowed from `scanned` OR `quoted`
 * because the provider may decide to create the job directly after scanning,
 * before sending a formal quote. `draft → converted` is intentionally blocked —
 * a job without an aufmaß makes no semantic sense for the pre-sales pipeline.
 */
export const PRESALES_TRANSITIONS: Readonly<Record<PresalesProjectStatus, readonly PresalesProjectStatus[]>> = {
  draft: ['scanned', 'archived'],
  scanned: ['quoted', 'converted', 'archived'],
  quoted: ['converted', 'archived'],
  converted: [],
  archived: [],
}

export function canTransition(
  from: PresalesProjectStatus,
  to: PresalesProjectStatus,
): boolean {
  return PRESALES_TRANSITIONS[from].includes(to)
}
