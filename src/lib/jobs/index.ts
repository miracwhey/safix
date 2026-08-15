export type {
  Job,
  JobActivity,
  JobActivityType,
  JobConversation,
  JobMessage,
  JobMessageSender,
  IntakeContext,
  IntakeOrigin,
  DisputeJobStatus,
  PaymentState,
  TeamMember,
} from './types'

export type {
  NextActionViewModel,
  NextActionPriority,
  NextActionDomain,
} from './nextActionSelectors'

export { deriveNextAction } from './nextActionSelectors'

export {
  addJob,
  addJobNote,
  addJobPhoto,
  getActiveJobs,
  getCompletedJobs,
  getJobById,
  getJobs,
  getNextStep,
  getTeamMembers,
  isActiveJob,
  isCompletedJob,
  isJobRepositoryHydrated,
  markProposalSent,
  markProposalAccepted,
  reloadJobsFromService,
  linkJobToProject,
  linkJobToSourceOffer,
  removeJob,
  sortJobsByPriority,
  subscribeJobs,
  toggleAssignedMember,
  updateJobPaymentState,
  updateJobAmount,
  updateJobProposalFields,
  updateJobStatus,
  updateJobWorkCompleted,
  updateJobWorkMarkedComplete,
  updateJobWorkConfirmedComplete,
  updateJobWorkMarkedCompleteCleared,
  updateJobPaymentReleased,
  updateJobDisputeStatus,
} from './service'

export { canTransitionJob, allowedJobTransitions, TERMINAL_JOB_STATUSES } from './stateMachine'

export type { JobRepository } from './repository'
export { getJobRepository, setJobRepository, initializeJobRepository, SupabaseJobRepository } from './repository'

export {
  getAttentionJobCount,
  getJobsInProgress,
  getJobsWaitingPayment,
  getNewIncomingJobs,
  getRecentCompletedJobs,
  getRecentlyActiveJobs,
  getUpcomingScheduledJobs,
  getUrgentJobs,
} from './dashboardSelectors'

export { deriveCustomerNextAction } from './customerNextActionSelectors'

export type {
  HealthStatus,
  ProjectHealthIndicator,
  ProjectHealthSummaryViewModel,
} from './projectHealthSelectors'
export { deriveProjectHealth } from './projectHealthSelectors'

export type {
  OperationalBlocker,
  OperationalBlockerReason,
  OperationalPhase,
  TimelineContextNote,
  JobOperationalSummary,
} from './operationalSummarySelectors'
export { deriveJobOperationalSummary } from './operationalSummarySelectors'

export type {
  IntakeReadiness,
  IntakeMissingField,
  IntakeReadinessViewModel,
} from './intakeSelectors'
export { deriveIntakeReadiness } from './intakeSelectors'

export type {
  ProposalReadiness,
  ProposalPrerequisite,
  ProposalReadinessViewModel,
  ProposalDraftPrefill,
  ProposalState,
  ProposalStateView,
} from './proposalReadinessSelectors'
export {
  deriveProposalReadiness,
  derivePrefillFromIntake,
  deriveProposalState,
} from './proposalReadinessSelectors'

export type {
  PostAcceptancePhase,
  PostAcceptanceViewModel,
} from './postAcceptanceSelectors'
export { derivePostAcceptanceReadiness } from './postAcceptanceSelectors'

export type {
  PaymentPrepPhase,
  PaymentPrepViewModel,
} from './paymentPrepSelectors'
export { derivePaymentPrepReadiness, parseJobAmount } from './paymentPrepSelectors'

export type {
  ReleaseReadinessPhase,
  ReleaseReadinessViewModel,
} from './releaseReadinessSelectors'
export { deriveReleaseReadiness } from './releaseReadinessSelectors'

export type {
  JobCompletionSummaryViewModel,
} from './jobCompletionSelectors'
export { deriveJobCompletionSummary } from './jobCompletionSelectors'

export type { JobOutcomeViewModel, JobOutcomeType } from './jobOutcomeSelectors'
export { deriveJobOutcome } from './jobOutcomeSelectors'

export {
  getAssignedJobsForUser,
  getActiveAssignedJobsForUser,
  deriveWorkerLinkageDiagnostic,
} from './workerSelectors'
export type {
  WorkerLinkageState,
  WorkerLinkageDiagnostic,
} from './workerSelectors'

export type { WorkerWorkload, JobsByWorker } from './teamWorkloadSelectors'
export {
  getWorkerAssignmentSummary,
  getTeamWorkloadDistribution,
  getUpcomingWorkPressure,
  getActiveJobsByWorker,
  getUnassignedJobs,
} from './teamWorkloadSelectors'

export type {
  ProofSignalKind,
  ProofSignal,
  CompletedWorkProofViewModel,
} from './completedWorkProofSelectors'
export { deriveCompletedWorkProof } from './completedWorkProofSelectors'

export type {
  ExecutionStatus,
  ExecutionStatusConfig,
  ExecutionSummary,
  AssignmentIntegrityWarning,
} from './executionSelectors'
export {
  EXECUTION_STATUS_CONFIG,
  deriveExecutionStatus,
  deriveExecutionNextStep,
  deriveExecutionSummary,
  deriveAssignmentIntegrityWarning,
  resolveAssigneeLabel,
  getAssigneeCount,
} from './executionSelectors'

export type {
  CustomerJobStage,
  CustomerStageViewModel,
} from './customerJobStageSelectors'
export {
  CUSTOMER_STAGE_ORDER,
  CUSTOMER_STAGE_LABELS,
  deriveCustomerJobStage,
} from './customerJobStageSelectors'

export type { CustomerNextStep } from './customerNextStepSelectors'
export { deriveCustomerNextStep } from './customerNextStepSelectors'

export type {
  OperatorPriorityCaseType,
  OperatorPrioritySeverity,
  OperatorPriorityCase,
} from './operatorPrioritySelectors'
export { deriveOperatorPriorityCases } from './operatorPrioritySelectors'

export type { CustomerProjectSummary } from './customerProfileSelectors'
export { deriveCustomerProjectSummary } from './customerProfileSelectors'

export {
  isProposalStuck,
  isSchedulingStuck,
  isExecutionSilent,
  isPaymentReleasePending,
} from './customerStuckStateSelectors'

export type { JobHealthStatus } from './jobHealthSelectors'
export { deriveJobHealth } from './jobHealthSelectors'

export {
  resolveCanonicalJob,
  isSupersededByCanonicalJob,
  filterSupersededJobs,
  findCanonicalOverride,
} from './canonicalJobResolver'

export type {
  ProviderJobPhase,
  ProviderPhaseConfig,
  ProviderPhaseViewModel,
  ProviderExecutionGroup,
  ProviderExecutionSummary,
} from './providerJobPhaseSelectors'
export {
  PROVIDER_PHASE_CONFIG,
  PROVIDER_PHASE_ORDER,
  deriveProviderJobPhase,
  deriveProviderExecutionSummary,
} from './providerJobPhaseSelectors'

export type {
  ProviderNextAction,
  ProviderActionId,
} from './providerNextActionSelectors'
export { deriveProviderNextAction } from './providerNextActionSelectors'
