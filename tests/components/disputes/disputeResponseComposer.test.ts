/**
 * N3b — DisputeResponseComposer source + error-mapping contract.
 *
 * Like the PayoutFailureBanner test, we rely on source inspection to lock
 * down the wiring (workflow call, two-step confirm, error-mapping table)
 * plus targeted unit tests on the exported error-mapper.
 *
 * Behavioral state-flow is exercised via the existing
 * `disputeResponseWorkflow.test.ts` integration suite (N3a). The composer
 * is the thin React glue around it.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { mapDisputeResponseSubmitError } from '../../../src/components/disputes/disputeResponseErrorMessages'
import {
  DisputeResponseError,
  type DisputeResponseErrorCode,
} from '../../../src/lib/workflow/disputeResponseWorkflow'
import { RbacError } from '../../../src/lib/auth/rbacGuards'

const COMPOSER = resolve(
  __dirname,
  '../../../src/components/disputes/DisputeResponseComposer.tsx',
)

describe('DisputeResponseComposer — wiring contract', () => {
  const src = readFileSync(COMPOSER, 'utf-8')

  it('imports the N3a workflow as the only submit path', () => {
    expect(src).toContain(
      "import { submitDisputeResponseWorkflow } from '../../lib/workflow/disputeResponseWorkflow'",
    )
    expect(src).toContain('submitDisputeResponseWorkflow({ jobId, statement: trimmed })')
  })

  it('uses the deadline-formatting selectors (not inline math)', () => {
    expect(src).toContain('formatResponseDeadlineLabel')
    expect(src).toContain('isDisputeResponseDeadlineUrgent')
  })

  it('delegates error-mapping to the shared message helper', () => {
    expect(src).toContain(
      "import { mapDisputeResponseSubmitError } from './disputeResponseErrorMessages'",
    )
  })

  it('enforces a two-step confirm path (editing → confirming)', () => {
    expect(src).toMatch(/'idle' \| 'editing' \| 'confirming' \| 'submitting'/)
    expect(src).toContain("setStep('confirming')")
    expect(src).toContain("setStep('submitting')")
  })

  it('locks the statement length cap to 4000', () => {
    expect(src).toContain('const MAX_LENGTH = 4000')
    expect(src).toContain('e.target.value.slice(0, MAX_LENGTH)')
  })

  it('forbids submit with empty trimmed statement (UI guard)', () => {
    expect(src).toContain('if (trimmed.length === 0) return')
  })

  it('uses the wording "SaFix" / "SaFix/Operator", never "Stripe"', () => {
    expect(src).not.toMatch(/Stripe/i)
    expect(src).toContain('SaFix')
  })

  it('shows the irreversibility hint on the confirm step', () => {
    expect(src).toContain('nicht mehr ändern')
  })
})

describe('mapDisputeResponseSubmitError', () => {
  const codes: DisputeResponseErrorCode[] = [
    'dispute_not_found',
    'dispute_terminal',
    'dispute_not_awaiting_response',
    'dispute_response_empty',
    'job_not_found',
  ]

  for (const code of codes) {
    it(`maps DisputeResponseError(${code}) to a user-facing message`, () => {
      const msg = mapDisputeResponseSubmitError(new DisputeResponseError(code))
      expect(msg).toBeTruthy()
      expect(msg).not.toContain(code) // not the raw code
      expect(msg.toLowerCase()).not.toContain('stripe')
    })
  }

  it('maps RbacError(rbac_owner) with owner-specific copy', () => {
    const msg = mapDisputeResponseSubmitError(new RbacError('rbac_owner'))
    expect(msg).toContain('Inhaber')
  })

  it('maps RbacError(rbac_customer) with customer-specific copy', () => {
    const msg = mapDisputeResponseSubmitError(new RbacError('rbac_customer'))
    expect(msg).toContain('Auftraggeber')
  })

  it('maps RbacError(other) to a generic permission message', () => {
    const msg = mapDisputeResponseSubmitError(new RbacError('rbac_role'))
    expect(msg).toContain('Berechtigung')
  })

  it('falls back to a neutral retry message for unknown errors', () => {
    const msg = mapDisputeResponseSubmitError(new Error('boom'))
    expect(msg).toContain('Senden fehlgeschlagen')
  })
})
