export type ReportReason = 'harassment' | 'spam' | 'fraud' | 'inappropriate' | 'other';

// Mirrors the user_reports_status_chk DB constraint. 'actioned' is written by the
// operator_enforce_report() RPC (enforcement taken); 'resolved' is the manual
// triage-close written by the operator panel's 'Gelöst' button.
export type ReportStatus = 'pending' | 'reviewed' | 'resolved' | 'dismissed' | 'actioned';

export interface UserReport {
  id: string;
  reporterId: string;
  reportedUserId: string;
  reason: ReportReason;
  context: string | null;
  /** Surface the reported content lives on (e.g. 'message', 'reel', 'review'). */
  contextType: string | null;
  /** Id of the reported content on that surface. */
  contextId: string | null;
  status: ReportStatus;
  resolvedBy: string | null;
  resolvedAt: string | null;
  operatorNotes: string | null;
  createdAt: string;
}

export interface UserBlock {
  id: string;
  blockerId: string;
  blockedUserId: string;
  createdAt: string;
}

/**
 * The five enforcement actions an operator can take on a report, mirroring
 * the `operator_enforce_report` RPC's `p_action` argument.
 */
export type ModerationActionType =
  | 'warn'
  | 'hide_content'
  | 'suspend'
  | 'ban'
  | 'dismiss';

/**
 * Arguments for `enforceReport`, mapped 1:1 onto the
 * `operator_enforce_report(p_action, p_report_id, p_target_user_id, p_notes,
 * p_suspend_hours, p_target_message_id)` RPC.
 */
export interface EnforceReportParams {
  action: ModerationActionType;
  reportId: string;
  targetUserId: string;
  notes?: string | null;
  /** Required (> 0) when action is 'suspend'; the suspension duration in hours. */
  suspendHours?: number | null;
  /** Required when action is 'hide_content'; the message to hide. */
  targetMessageId?: string | null;
}

/**
 * Result returned by the `operator_enforce_report` RPC.
 */
export interface EnforcementResult {
  ok: boolean;
  action: ModerationActionType;
  reportStatus: string;
  expiresAt: string | null;
}
