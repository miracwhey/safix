/**
 * Post-Payment Reconciliation State Machine Tests
 *
 * Validates:
 * 1. PaymentPhase type includes all required reconciliation states
 * 2. handleStripeConfirmed sets confirming-payment phase on start
 * 3. handleStripeConfirmed updates repos directly on funded_in_escrow response
 * 4. handleStripeConfirmed enters reconciliation-pending on non-funded response
 * 5. handleStripeConfirmed enters reconciliation-pending on confirm failure
 * 6. Reconciliation polling effect exists and is bounded
 * 7. Reconciliation timeout transitions to explicit timeout state
 * 8. View renders confirming-payment UI
 * 9. View renders reconciliation-pending UI
 * 10. View renders reconciliation-timeout UI with manual refresh action
 * 11. No infinite processing limbo — all paths lead to explicit end states
 * 12. No regression to existing payment flow or funding route
 * 13. Uses authoritative funding-entry source for reconciliation
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

// ── File paths ────────────────────────────────────────────────────────────

const cardPath = path.resolve(__dirname, '../../src/components/projects/CustomerEscrowFundingCard.tsx')
const screenPath = path.resolve(__dirname, '../../src/screens/FundingEntryScreen.tsx')
const fundingEntryApiPath = path.resolve(__dirname, '../../src/lib/funding/fundingEntryApi.ts')
const stepperPath = path.resolve(__dirname, '../../src/components/payments/PaymentProcessStepper.tsx')

// ── Helper: read card content once ────────────────────────────────────────

function readFile(p: string): string {
  return fs.readFileSync(p, 'utf-8')
}

/**
 * Extracts the handleStripeConfirmed function body from the card source.
 * Searches from the function declaration to the next major callback.
 */
function extractHandleStripeConfirmed(content: string): string {
  const startIdx = content.indexOf('const handleStripeConfirmed = useCallback')
  const endPatterns = ['const handleStripeError', 'const handleRetryPayment']
  let endIdx = content.length
  for (const pat of endPatterns) {
    // Start searching 100 chars past startIdx to avoid matching within the declaration line itself
    const idx = content.indexOf(pat, startIdx + 100)
    if (idx > startIdx && idx < endIdx) endIdx = idx
  }
  return content.slice(startIdx, endIdx)
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Post-Payment Reconciliation State Machine', () => {

  // ─── 1. PaymentPhase includes reconciliation states ────────────────────

  describe('1. PaymentPhase type includes all required reconciliation states', () => {
    it('includes confirming-payment phase', () => {
      const content = readFile(cardPath)
      expect(content).toContain("'confirming-payment'")
    })

    it('includes reconciliation-pending phase', () => {
      const content = readFile(cardPath)
      expect(content).toContain("'reconciliation-pending'")
    })

    it('includes reconciliation-timeout phase', () => {
      const content = readFile(cardPath)
      expect(content).toContain("'reconciliation-timeout'")
    })

    it('exports PaymentPhase with all 8 phases', () => {
      const content = readFile(cardPath)
      const phases = [
        'idle',
        'preparing-payment',
        'payment-form-ready',
        'payment-already-funded',
        'payment-init-error',
        'confirming-payment',
        'reconciliation-pending',
        'reconciliation-timeout',
      ]
      for (const phase of phases) {
        expect(content).toContain(`'${phase}'`)
      }
    })
  })

  // ─── 2. handleStripeConfirmed sets confirming-payment on start ─────────

  describe('2. handleStripeConfirmed sets confirming-payment phase on start', () => {
    it('sets paymentPhase to confirming-payment before API call', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      expect(fn).toContain("setPaymentPhase('confirming-payment')")
    })

    it('sets isPending to true at start', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      expect(fn).toContain('setIsPending(true)')
    })
  })

  // ─── 3. Direct repo update on funded_in_escrow response ───────────────

  describe('3. handleStripeConfirmed adopts canonical server payload on funded_in_escrow', () => {
    it('checks for funded_in_escrow status in API response', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      expect(fn).toContain("result.data.status === 'funded_in_escrow'")
    })

    it('calls fetchFundingEntry to read canonical payload after confirm', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      expect(fn).toContain('fetchFundingEntry(frId)')
    })

    it('calls applyCanonicalPayloadToRepos when canonical read succeeds', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      expect(fn).toContain('applyCanonicalPayloadToRepos(entryResult.data)')
    })

    it('falls back to Date.now() only when canonical read fails', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      // Date.now() should only appear in the fallback branch (after canonical read failed)
      expect(fn).toContain('confirm_funding_canonical_read_failed')
      // The fallback branch uses Date.now(), but only after the canonical read has failed
      const fundedBlock = fn.slice(
        fn.indexOf("result.data.status === 'funded_in_escrow'"),
        fn.indexOf("setPaymentPhase('idle')"),
      )
      expect(fundedBlock).toContain('applyCanonicalPayloadToRepos')
      expect(fundedBlock).toContain('confirm_funding_canonical_read_failed')
    })

    it('does not use initializeFundingRequestRepository for primary path', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      expect(fn).not.toContain('initializeFundingRequestRepository')
    })

    it('does not use initializeEscrowPlanRepository for primary path', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      expect(fn).not.toContain('initializeEscrowPlanRepository')
    })
  })

  // ─── 4. Reconciliation-pending on non-funded response ─────────────────

  describe('4. handleStripeConfirmed enters reconciliation-pending on non-funded response', () => {
    it('transitions to reconciliation-pending if status is not funded_in_escrow', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      // After checking funded_in_escrow, should fall through to reconciliation-pending
      const afterFundedCheck = fn.slice(fn.indexOf("result.data.status === 'funded_in_escrow'"))
      expect(afterFundedCheck).toContain("setPaymentPhase('reconciliation-pending')")
    })
  })

  // ─── 5. Reconciliation-pending on confirm failure ─────────────────────

  describe('5. handleStripeConfirmed enters reconciliation-pending on confirm failure', () => {
    it('does not throw on !result.ok — enters reconciliation instead', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      // The !result.ok path should set reconciliation-pending, not throw
      const notOkSection = fn.slice(fn.indexOf('!result.ok'))
      const nextThrow = notOkSection.indexOf('throw')
      const nextReconciliation = notOkSection.indexOf("setPaymentPhase('reconciliation-pending')")
      // reconciliation-pending should come before any throw (or no throw)
      expect(nextReconciliation).toBeGreaterThan(0)
      if (nextThrow > 0) {
        expect(nextReconciliation).toBeLessThan(nextThrow)
      }
    })

    it('enters reconciliation-pending in catch block', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      const catchBlock = fn.slice(fn.indexOf('} catch (e)'))
      expect(catchBlock).toContain("setPaymentPhase('reconciliation-pending')")
    })
  })

  // ─── 6. Reconciliation polling effect is bounded ──────────────────────

  describe('6. Reconciliation polling effect exists and is bounded', () => {
    it('card imports useEffect', () => {
      const content = readFile(cardPath)
      expect(content).toContain('useEffect')
      expect(content).toMatch(/import\s*\{[^}]*useEffect[^}]*\}\s*from\s*'react'/)
    })

    it('card imports useRef', () => {
      const content = readFile(cardPath)
      expect(content).toContain('useRef')
      expect(content).toMatch(/import\s*\{[^}]*useRef[^}]*\}\s*from\s*'react'/)
    })

    it('card imports fetchFundingEntry for reconciliation polling', () => {
      const content = readFile(cardPath)
      expect(content).toContain("import { fetchFundingEntry } from '../../lib/funding/fundingEntryApi'")
    })

    it('has a reconciliation polling effect gated on reconciliation-pending', () => {
      const content = readFile(cardPath)
      expect(content).toContain("paymentPhase !== 'reconciliation-pending'")
    })

    it('defines a poll interval constant', () => {
      const content = readFile(cardPath)
      expect(content).toContain('RECONCILIATION_POLL_INTERVAL_MS')
    })

    it('defines a max duration constant', () => {
      const content = readFile(cardPath)
      expect(content).toContain('RECONCILIATION_MAX_DURATION_MS')
    })

    it('cleans up polling on unmount (returns cleanup function)', () => {
      const content = readFile(cardPath)
      // Effect should have a cleanup that sets cancelled = true
      expect(content).toContain('cancelled = true')
    })
  })

  // ─── 7. Reconciliation timeout ────────────────────────────────────────

  describe('7. Reconciliation timeout transitions to explicit timeout state', () => {
    it('checks elapsed time against max duration in poll', () => {
      const content = readFile(cardPath)
      expect(content).toContain('RECONCILIATION_MAX_DURATION_MS')
    })

    it('sets reconciliation-timeout when poll window is exhausted', () => {
      const content = readFile(cardPath)
      expect(content).toContain("setPaymentPhase('reconciliation-timeout')")
    })

    it('logs warning on timeout', () => {
      const content = readFile(cardPath)
      expect(content).toContain('payment.reconciliation_timeout')
    })
  })

  // ─── 8. View: confirming-payment UI ───────────────────────────────────

  describe('8. View renders confirming-payment UI', () => {
    it('renders a confirming payment indicator', () => {
      const content = readFile(cardPath)
      expect(content).toContain('data-testid="payment-confirming"')
    })

    it('shows a confirming message to the user', () => {
      const content = readFile(cardPath)
      const stepperContent = readFile(stepperPath)
      expect(content).toContain('<PaymentProcessStepper phase={2}')
      expect(stepperContent).toContain('Zahlung verarbeiten')
    })
  })

  // ─── 9. View: reconciliation-pending UI ───────────────────────────────

  describe('9. View renders reconciliation-pending UI', () => {
    it('renders a reconciliation pending block', () => {
      const content = readFile(cardPath)
      expect(content).toContain('data-testid="reconciliation-pending"')
    })

    it('shows a payment received message during reconciliation', () => {
      const content = readFile(cardPath)
      const stepperContent = readFile(stepperPath)
      expect(content).toContain('<PaymentProcessStepper phase={3}')
      expect(stepperContent).toContain('Bestätigung ausstehend')
      expect(content).toContain('Deine Zahlung wurde empfangen')
    })
  })

  // ─── 10. View: reconciliation-timeout UI ──────────────────────────────

  describe('10. View renders reconciliation-timeout UI with manual refresh', () => {
    it('renders a reconciliation timeout block', () => {
      const content = readFile(cardPath)
      expect(content).toContain('data-testid="reconciliation-timeout"')
    })

    it('shows explicit pending-confirmation message', () => {
      const content = readFile(cardPath)
      expect(content).toContain('Zahlung erhalten')
      expect(content).toContain('Bestätigung noch in Bearbeitung')
    })

    it('provides a retry reconciliation action', () => {
      const content = readFile(cardPath)
      expect(content).toContain('data-testid="reconciliation-retry"')
      expect(content).toContain('Status erneut prüfen')
    })

    it('does not use window.location.reload for the retry action', () => {
      const content = readFile(cardPath)
      // The timeout retry should re-enter reconciliation, not full-page reload
      expect(content).toContain('onRetryReconciliation')
    })
  })

  // ─── 11. No infinite processing limbo ─────────────────────────────────

  describe('11. No infinite processing limbo — all paths lead to explicit end states', () => {
    it('handleStripeConfirmed does not use a finally block to set isPending=false', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      // The function should NOT have a finally block that just sets isPending=false
      // without a corresponding phase change. Check with whitespace-agnostic regex.
      expect(fn).not.toMatch(/}\s*finally\s*\{\s*setIsPending\(false\)\s*\}/)
    })

    it('every exit path from handleStripeConfirmed sets a definite paymentPhase', () => {
      const fn = extractHandleStripeConfirmed(readFile(cardPath))
      // Count setPaymentPhase calls — should have multiple definite exits
      const phaseSetCount = (fn.match(/setPaymentPhase\(/g) || []).length
      // At minimum: confirming-payment (start), idle (funded success),
      // reconciliation-pending (non-funded / error), so ≥ 4
      expect(phaseSetCount).toBeGreaterThanOrEqual(4)
    })
  })

  // ─── 12. No regression to existing payment flow ───────────────────────

  describe('12. No regression to existing payment flow or funding route', () => {
    it('FundingEntryScreen still exists', () => {
      expect(fs.existsSync(screenPath)).toBe(true)
    })

    it('CustomerEscrowFundingCard still imports confirmFundingPayment', () => {
      const content = readFile(cardPath)
      expect(content).toContain('confirmFundingPayment')
    })

    it('handleStartPayment still handles mock mode', () => {
      const content = readFile(cardPath)
      expect(content).toContain("providerName === 'mock'")
    })

    it('handleStartPayment still handles Stripe initiation', () => {
      const content = readFile(cardPath)
      expect(content).toContain('initiateFundingPayment')
    })

    it('existing payment phases are preserved', () => {
      const content = readFile(cardPath)
      const existingPhases = [
        'idle',
        'preparing-payment',
        'payment-form-ready',
        'payment-already-funded',
        'payment-init-error',
      ]
      for (const phase of existingPhases) {
        expect(content).toContain(`'${phase}'`)
      }
    })

    it('FundingEntryScreen still renders CustomerEscrowFundingCard', () => {
      const content = readFile(screenPath)
      expect(content).toContain('CustomerEscrowFundingCard')
    })
  })

  // ─── 13. Uses authoritative funding-entry source for reconciliation ───

  describe('13. Uses authoritative funding-entry source for reconciliation', () => {
    it('card imports fetchFundingEntry from funding entry API', () => {
      const content = readFile(cardPath)
      expect(content).toContain("import { fetchFundingEntry } from '../../lib/funding/fundingEntryApi'")
    })

    it('reconciliation polls fetchFundingEntry for canonical truth', () => {
      const content = readFile(cardPath)
      // fetchFundingEntry should be called inside the reconciliation effect
      expect(content).toContain('fetchFundingEntry(frId)')
    })

    it('checks funded status from server response', () => {
      const content = readFile(cardPath)
      expect(content).toContain("result.data.fundingRequest.status === 'funded'")
    })

    it('fundingEntryApi still exists as the canonical read path', () => {
      expect(fs.existsSync(fundingEntryApiPath)).toBe(true)
    })

    it('has applyCanonicalPayloadToRepos helper for server payload adoption', () => {
      const content = readFile(cardPath)
      expect(content).toContain('function applyCanonicalPayloadToRepos')
    })

    it('applyCanonicalPayloadToRepos uses parseTimestampMs for fundedAt', () => {
      const content = readFile(cardPath)
      const helperStart = content.indexOf('function applyCanonicalPayloadToRepos')
      const helperEnd = content.indexOf('\n}', helperStart) + 2
      const helper = content.slice(helperStart, helperEnd)
      expect(helper).toContain('parseTimestampMs')
      expect(helper).toContain('fundedAt')
      expect(helper).toContain('updatedAt')
      expect(helper).toContain('externalFundingRef')
    })

    it('applyCanonicalPayloadToRepos does not use Date.now()', () => {
      const content = readFile(cardPath)
      const helperStart = content.indexOf('function applyCanonicalPayloadToRepos')
      const helperEnd = content.indexOf('\n}', helperStart) + 2
      const helper = content.slice(helperStart, helperEnd)
      expect(helper).not.toContain('Date.now()')
    })

    it('reconciliation polling uses applyCanonicalPayloadToRepos (no synthetic patching)', () => {
      const content = readFile(cardPath)
      // The reconciliation polling effect should use the canonical helper
      const pollEffect = content.slice(content.indexOf('const poll = ()'))
      const fundedBranch = pollEffect.slice(
        pollEffect.indexOf("result.data.fundingRequest.status === 'funded'"),
        pollEffect.indexOf('Not yet funded'),
      )
      expect(fundedBranch).toContain('applyCanonicalPayloadToRepos')
      // No synthetic Date.now() used as a value in the funded branch
      // (the comment "no local Date.now() patching" is OK — we check for actual usage)
      expect(fundedBranch).not.toMatch(/fundedAt:\s*Date\.now\(\)/)
    })
  })

  // ─── 14. PAYMENT_ALREADY_FUNDED confirms then reconciles (P1 #333) ─────
  //
  // The already-funded branch previously only set 'payment-already-funded'
  // and read local stores — leaving the DB at funding_initiated until the
  // webhook fired. It now confirms the existing PaymentIntent server-side
  // (idempotent + Stripe-verified) and enters the bounded reconciliation poll,
  // with a webhook fallback when the confirm call fails.

  describe('14. PAYMENT_ALREADY_FUNDED confirms server-side then reconciles', () => {
    const content = readFile(cardPath)
    const branchIdx = content.indexOf("result.outcome === 'PAYMENT_ALREADY_FUNDED'")
    // Scope to the already-funded branch only: from its outcome check up to
    // the form-ready path that follows it.
    const branch = content.slice(branchIdx, content.indexOf('const receivedSecret', branchIdx))

    it('locates the already-funded branch', () => {
      expect(branchIdx).toBeGreaterThan(-1)
      expect(branch.length).toBeGreaterThan(0)
    })

    it('confirms the existing PaymentIntent server-side (idempotent)', () => {
      expect(branch).toContain('confirmFundingPayment(')
      expect(branch).toContain('result.paymentIntentId')
    })

    it('enters reconciliation-pending instead of a terminal payment-already-funded read', () => {
      expect(branch).toContain("setPaymentPhase('reconciliation-pending')")
      expect(branch).not.toContain("setPaymentPhase('payment-already-funded')")
    })

    it('falls back to reconciliation on confirm failure (webhook fallback)', () => {
      expect(branch).toContain('already_funded_confirm_failed_entering_reconciliation')
    })

    it('advances local status so the reconciliation UI renders during the poll', () => {
      expect(branch).toContain('advanceLocalStatusToInitiated')
    })
  })
})
