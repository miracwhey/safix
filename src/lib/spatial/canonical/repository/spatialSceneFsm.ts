/**
 * Spatial · Canonical · Repository · Scene FSMs (XM-7 audit-fix)
 *
 * Mirrors the Postgres triggers in `20260520120011_spatial_canonical_triggers
 * .sql`. The DB enforces the same transitions; this module runs the same FSM
 * client-side so the repository can fail loud BEFORE hitting the network.
 *
 * Three machines:
 *   - `validation_state`        (`spatial_scenes.validation_state`)
 *   - `customer_verify_state`   (`spatial_scenes.customer_verify_state`)
 *   - `change_order_status`     (`spatial_change_orders.status`)
 *
 * Every illegal transition raises a {@link SpatialFsmViolation}. The TS error
 * carries the same metadata the DB trigger does (fsm name, from, to) so a
 * shared catch-block can rewrite it into a user-facing message.
 */

import { SpatialFsmViolation } from '../types/errors.ts'

/** All legal values for `spatial_scenes.validation_state`. */
export type ValidationState =
  | 'pending'
  | 'passed'
  | 'passed_with_warnings'
  | 'blocked'
  | 're_review'

/** All legal values for `spatial_scenes.customer_verify_state`. */
export type CustomerVerifyState =
  | 'not_started'
  | 'in_progress'
  | 'approved'
  | 'rejected'
  | 'expired'

/** All legal values for `spatial_change_orders.status`. */
export type ChangeOrderStatus = 'proposed' | 'accepted' | 'rejected' | 'withdrawn'

/** Allowed transitions for `validation_state`. */
const VALIDATION_STATE_TRANSITIONS: Readonly<Record<ValidationState, ReadonlyArray<ValidationState>>> = {
  pending: ['passed', 'passed_with_warnings', 'blocked'],
  passed: ['re_review', 'blocked'],
  passed_with_warnings: ['passed', 're_review', 'blocked'],
  blocked: ['re_review', 'pending'],
  re_review: ['passed', 'passed_with_warnings', 'blocked'],
}

/** Allowed transitions for `customer_verify_state`. */
const CUSTOMER_VERIFY_STATE_TRANSITIONS: Readonly<Record<CustomerVerifyState, ReadonlyArray<CustomerVerifyState>>> = {
  not_started: ['in_progress'],
  in_progress: ['approved', 'rejected', 'expired'],
  approved: ['not_started'],
  rejected: ['in_progress'],
  expired: ['in_progress'],
}

/** Allowed transitions for `spatial_change_orders.status`. */
const CHANGE_ORDER_STATUS_TRANSITIONS: Readonly<Record<ChangeOrderStatus, ReadonlyArray<ChangeOrderStatus>>> = {
  proposed: ['accepted', 'rejected', 'withdrawn'],
  accepted: [],
  rejected: [],
  withdrawn: [],
}

/** Return true when `from → to` is a permitted `validation_state` transition. */
export function canTransitionValidationState(from: ValidationState, to: ValidationState): boolean {
  if (from === to) return true
  return VALIDATION_STATE_TRANSITIONS[from].includes(to)
}

/** Return true when `from → to` is a permitted `customer_verify_state` transition. */
export function canTransitionCustomerVerifyState(
  from: CustomerVerifyState,
  to: CustomerVerifyState,
): boolean {
  if (from === to) return true
  return CUSTOMER_VERIFY_STATE_TRANSITIONS[from].includes(to)
}

/** Return true when `from → to` is a permitted change-order `status` transition. */
export function canTransitionChangeOrderStatus(
  from: ChangeOrderStatus,
  to: ChangeOrderStatus,
): boolean {
  if (from === to) return true
  return CHANGE_ORDER_STATUS_TRANSITIONS[from].includes(to)
}

/**
 * Assert a transition is legal or throw {@link SpatialFsmViolation}.
 * Convenient helper for repository update paths — the same check the
 * Postgres trigger performs, but evaluated locally before the round-trip.
 */
export function assertValidationStateTransition(from: ValidationState, to: ValidationState): void {
  if (!canTransitionValidationState(from, to)) {
    throw new SpatialFsmViolation('validation_state', from, to)
  }
}

export function assertCustomerVerifyStateTransition(
  from: CustomerVerifyState,
  to: CustomerVerifyState,
): void {
  if (!canTransitionCustomerVerifyState(from, to)) {
    throw new SpatialFsmViolation('customer_verify_state', from, to)
  }
}

export function assertChangeOrderStatusTransition(
  from: ChangeOrderStatus,
  to: ChangeOrderStatus,
): void {
  if (!canTransitionChangeOrderStatus(from, to)) {
    throw new SpatialFsmViolation('change_order_status', from, to)
  }
}
