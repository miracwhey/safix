import type {
  ProjectCase,
  ProjectCaseStatus,
} from '../../domain/projects/projectCaseTypes'
import type { PaymentState } from '../shared/coreTypes'

export type ProjectStatus = ProjectCaseStatus
export type ProjectPaymentState = PaymentState
export type Project = ProjectCase
