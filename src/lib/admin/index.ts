/**
 * Admin / backoffice boundary guard.
 *
 * @deprecated isAdminMode() has been removed. Operator access is now granted
 * exclusively via profiles.is_operator in the database, which is reflected in
 * session.isOperator and enforced by canAccessDisputeResolution() in
 * src/lib/access/index.ts. The VITE_ADMIN_MODE env-var override no longer has
 * any effect. Do not re-introduce env-var-based access bypasses.
 *
 * To grant a user operator access:
 *   UPDATE profiles SET is_operator = true WHERE id = '<user-uuid>';
 */
