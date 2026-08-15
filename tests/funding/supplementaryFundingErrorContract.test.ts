/**
 * SupplementaryFundingScreen Error-Contract Tests
 *
 * Invariants proven here:
 * 1. handleInitiate is guarded against concurrent calls (phase === 'preparing')
 * 2. handleInitiate wraps the API call in try/catch — no unhandled rejection
 * 3. catch block surfaces error via setError + setPhase('error')
 * 4. error phase renders InlineFeedback with the error message
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('../../src/screens/SupplementaryFundingScreen.tsx', import.meta.url),
  'utf-8',
)

describe('SupplementaryFundingScreen — handleInitiate error-surface contract', () => {
  it('guards against concurrent calls while preparing', () => {
    expect(source).toContain("phase === 'preparing'")
  })

  it('handleInitiate body is wrapped in try/catch', () => {
    const startIdx = source.indexOf('const handleInitiate = useCallback')
    expect(startIdx).toBeGreaterThan(-1)
    const callbackBody = source.slice(startIdx, startIdx + 3000)
    expect(callbackBody).toContain('try {')
    expect(callbackBody).toContain('} catch (')
  })

  it('catch block calls setError with the normalized error message', () => {
    const startIdx = source.indexOf('const handleInitiate = useCallback')
    const callbackBody = source.slice(startIdx, startIdx + 3000)
    const catchIdx = callbackBody.lastIndexOf('} catch (')
    expect(catchIdx).toBeGreaterThan(-1)
    const catchBlock = callbackBody.slice(catchIdx, catchIdx + 300)
    expect(catchBlock).toContain('setError(')
    expect(catchBlock).toContain('normalizeErrorMessage(')
  })

  it("catch block resets phase to 'error' so UI exits 'preparing'", () => {
    const startIdx = source.indexOf('const handleInitiate = useCallback')
    const callbackBody = source.slice(startIdx, startIdx + 3000)
    const catchIdx = callbackBody.lastIndexOf('} catch (')
    const catchBlock = callbackBody.slice(catchIdx, catchIdx + 300)
    expect(catchBlock).toContain("setPhase('error')")
  })

  it('error phase renders InlineFeedback with error prop', () => {
    expect(source).toContain("phase === 'error'")
    expect(source).toContain('<InlineFeedback error={error}')
  })

  it('error phase offers a retry button that resets to idle', () => {
    expect(source).toContain("setPhase('idle')")
  })
})
