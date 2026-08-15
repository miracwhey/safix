import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const script = readFileSync(
  resolve(__dirname, '../../ios/App/ci_scripts/ci_post_clone.sh'),
  'utf-8',
)

describe('ci_post_clone Stripe live-key gate', () => {
  it('accepts only pk_live_* and fails a pk_test_* App Store build', () => {
    expect(script).toContain('pk_live_*) ;;')
    expect(script).toContain('pk_test_*)')
    expect(script).toContain('App Store builds require a pk_live_* publishable key.')
    expect(script).not.toContain('pk_live_*|pk_test_*)')
  })
})

describe('ci_post_clone runtime pin', () => {
  it('enforces Node 24 instead of accepting the latest installed major', () => {
    expect(script).toContain('REQUIRED_NODE_MAJOR="24"')
    expect(script).toContain('brew install node@24')
    expect(script).toContain('active Node must be 24.x for App Store builds')
    expect(script).not.toContain('brew install node;')
  })
})
