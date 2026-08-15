/**
 * Failure classifier — pure unit tests.
 *
 * Covers every branch the SyncStatusBar / flushPendingMutations rely on:
 *
 *   - Auth-not-ready short-circuit driven by ClassifyContext
 *   - Postgres / PostgREST error codes (PGRST3xx, 23xxx, 42xxx)
 *   - HTTP status (401, 403, 408, 429, 5xx)
 *   - Known SDK error names (AbortError, AuthRetryableFetchError)
 *   - Message-based heuristics (RLS, fetch, timeout)
 *   - TypeError fetch failure
 *   - Fallback to 'unknown'
 *
 * The classifier is policy-critical: any wrong branch turns into a wrong
 * banner / wrong retry count / orphaned pending mutation.  Treat as a
 * frozen contract.
 */

import { describe, it, expect } from 'vitest'

import {
  classifyFailure,
  isPermanentKind,
  isRetryableKind,
  type FailureKind,
} from '../../src/lib/persistence/classifyFailure'

describe('classifyFailure — auth-not-ready short-circuit', () => {
  const networkError = new TypeError('Failed to fetch')

  it('returns auth-not-ready when mutation has userId but currentUid is null', () => {
    expect(
      classifyFailure(networkError, { currentUid: null, mutationUserId: 'user-A' }),
    ).toBe('auth-not-ready')
  })

  it('returns auth-not-ready when mutation belongs to a different user', () => {
    expect(
      classifyFailure(networkError, { currentUid: 'user-B', mutationUserId: 'user-A' }),
    ).toBe('auth-not-ready')
  })

  it('does NOT short-circuit when mutation has no userId (legacy entry)', () => {
    // Legacy mutations are treated as belonging to the current user.
    expect(
      classifyFailure(networkError, { currentUid: null, mutationUserId: null }),
    ).toBe('transient')
  })

  it('does NOT short-circuit when context is undefined', () => {
    expect(classifyFailure(networkError)).toBe('transient')
  })

  it('proceeds to error classification when uids match', () => {
    expect(
      classifyFailure(networkError, { currentUid: 'user-A', mutationUserId: 'user-A' }),
    ).toBe('transient')
  })
})

describe('classifyFailure — Postgres / PostgREST codes', () => {
  it('classifies PGRST301 (RLS deny) as permission-denied', () => {
    expect(classifyFailure({ code: 'PGRST301', message: 'JWT expired' })).toBe(
      'permission-denied',
    )
  })

  it('classifies any PGRST3xx as permission-denied', () => {
    expect(classifyFailure({ code: 'PGRST302' })).toBe('permission-denied')
    expect(classifyFailure({ code: 'PGRST399' })).toBe('permission-denied')
  })

  it('classifies 23505 (unique violation) as business-rejected', () => {
    expect(classifyFailure({ code: '23505' })).toBe('business-rejected')
  })

  it('classifies 23502 (NOT NULL) as business-rejected', () => {
    expect(classifyFailure({ code: '23502' })).toBe('business-rejected')
  })

  it('classifies 23503 (FK) as business-rejected', () => {
    expect(classifyFailure({ code: '23503' })).toBe('business-rejected')
  })

  it('classifies 23514 (check constraint) as business-rejected', () => {
    expect(classifyFailure({ code: '23514' })).toBe('business-rejected')
  })

  it('classifies 22P02 (invalid input syntax for type uuid) as validation', () => {
    expect(classifyFailure({ code: '22P02', message: 'invalid input syntax for type uuid: "cal_..."' })).toBe('validation')
  })

  it('classifies other class-22 data exceptions as validation', () => {
    expect(classifyFailure({ code: '22001' })).toBe('validation') // string_data_right_truncation
    expect(classifyFailure({ code: '22003' })).toBe('validation') // numeric_value_out_of_range
  })

  it('classifies 42703 (undefined column) as validation', () => {
    expect(classifyFailure({ code: '42703' })).toBe('validation')
  })

  it('classifies 42P01 (undefined table) as validation', () => {
    expect(classifyFailure({ code: '42P01' })).toBe('validation')
  })

  it('does not match unrelated codes starting with 2 or 4', () => {
    // 2xxxx is not a real Postgres class — fall through.
    expect(classifyFailure({ code: '20000' })).toBe('unknown')
    expect(classifyFailure({ code: '40001' })).toBe('unknown') // serialization, retryable in spirit but unmapped
  })
})

describe('classifyFailure — HTTP status', () => {
  it('classifies 401 as auth-not-ready (refreshable JWT)', () => {
    expect(classifyFailure({ status: 401, message: 'Unauthorized' })).toBe(
      'auth-not-ready',
    )
  })

  it('classifies 403 as permission-denied', () => {
    expect(classifyFailure({ status: 403 })).toBe('permission-denied')
  })

  it('classifies 408 (request timeout) as retryable', () => {
    expect(classifyFailure({ status: 408 })).toBe('retryable')
  })

  it('classifies 429 (rate-limit) as retryable', () => {
    expect(classifyFailure({ status: 429 })).toBe('retryable')
  })

  it('classifies 500 as retryable', () => {
    expect(classifyFailure({ status: 500 })).toBe('retryable')
  })

  it('classifies 502/503/504 as retryable', () => {
    expect(classifyFailure({ status: 502 })).toBe('retryable')
    expect(classifyFailure({ status: 503 })).toBe('retryable')
    expect(classifyFailure({ status: 504 })).toBe('retryable')
  })

  it('falls through for 200/3xx/4xx not specifically mapped', () => {
    expect(classifyFailure({ status: 400 })).toBe('unknown')
    expect(classifyFailure({ status: 404 })).toBe('unknown')
  })
})

describe('classifyFailure — error names', () => {
  it('classifies AbortError as transient', () => {
    const err = new Error('Aborted')
    err.name = 'AbortError'
    expect(classifyFailure(err)).toBe('transient')
  })

  it('classifies AuthRetryableFetchError as transient', () => {
    const err = new Error('failed')
    err.name = 'AuthRetryableFetchError'
    expect(classifyFailure(err)).toBe('transient')
  })

  it('classifies TimeoutError as transient', () => {
    const err = new Error('timeout')
    err.name = 'TimeoutError'
    expect(classifyFailure(err)).toBe('transient')
  })
})

describe('classifyFailure — message heuristics', () => {
  it('classifies "permission denied" message as permission-denied', () => {
    expect(classifyFailure(new Error('permission denied for table jobs'))).toBe(
      'permission-denied',
    )
  })

  it('classifies "row-level security" message as permission-denied', () => {
    expect(classifyFailure(new Error('new row violates row-level security policy'))).toBe(
      'permission-denied',
    )
  })

  it('classifies "RLS" message as permission-denied', () => {
    expect(classifyFailure(new Error('RLS check failed'))).toBe('permission-denied')
  })

  it('classifies "Failed to fetch" as transient', () => {
    expect(classifyFailure(new Error('Failed to fetch'))).toBe('transient')
  })

  it('classifies "network request failed" as transient', () => {
    expect(classifyFailure(new Error('network request failed'))).toBe('transient')
  })

  it('classifies ECONNREFUSED as transient', () => {
    expect(classifyFailure(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe(
      'transient',
    )
  })

  it('classifies "timed out" as transient', () => {
    expect(classifyFailure(new Error('Request timed out after 30 seconds'))).toBe(
      'transient',
    )
  })
})

describe('classifyFailure — TypeError fetch fallback', () => {
  it('classifies TypeError with /fetch/ in message as transient', () => {
    expect(classifyFailure(new TypeError('Failed to fetch'))).toBe('transient')
  })

  it('classifies TypeError with /network/ in message as transient', () => {
    expect(classifyFailure(new TypeError('NetworkError when attempting to load'))).toBe(
      'transient',
    )
  })
})

describe('classifyFailure — unknown / fallback', () => {
  it('returns unknown for null', () => {
    expect(classifyFailure(null)).toBe('unknown')
  })

  it('returns unknown for undefined', () => {
    expect(classifyFailure(undefined)).toBe('unknown')
  })

  it('returns unknown for empty string', () => {
    expect(classifyFailure('')).toBe('unknown')
  })

  it('returns unknown for plain string without keywords', () => {
    expect(classifyFailure('something happened')).toBe('unknown')
  })

  it('returns unknown for plain object without code/status/name', () => {
    expect(classifyFailure({ foo: 'bar' })).toBe('unknown')
  })

  it('returns unknown for empty Error', () => {
    expect(classifyFailure(new Error(''))).toBe('unknown')
  })
})

describe('classifyFailure — priority order', () => {
  it('auth context wins over Postgres code', () => {
    // Even a permission-denied looking error is auth-not-ready when the
    // mutation does not belong to the active session.
    expect(
      classifyFailure(
        { code: 'PGRST301', message: 'JWT expired' },
        { currentUid: null, mutationUserId: 'user-A' },
      ),
    ).toBe('auth-not-ready')
  })

  it('code wins over status', () => {
    // 23505 is more specific than the surrounding 400.
    expect(classifyFailure({ code: '23505', status: 400 })).toBe('business-rejected')
  })

  it('status wins over name when no code matches', () => {
    const err = new Error('something')
    err.name = 'AbortError' // would say transient
    Object.assign(err, { status: 403 })
    expect(classifyFailure(err)).toBe('permission-denied')
  })
})

describe('isRetryableKind', () => {
  const cases: Array<[FailureKind, boolean]> = [
    ['transient', true],
    ['retryable', true],
    ['unknown', true],
    ['auth-not-ready', false],
    ['permission-denied', false],
    ['business-rejected', false],
    ['validation', false],
  ]
  for (const [kind, expected] of cases) {
    it(`returns ${expected} for ${kind}`, () => {
      expect(isRetryableKind(kind)).toBe(expected)
    })
  }
})

describe('isPermanentKind', () => {
  const cases: Array<[FailureKind, boolean]> = [
    ['permission-denied', true],
    ['business-rejected', true],
    ['validation', true],
    ['transient', false],
    ['retryable', false],
    ['auth-not-ready', false],
    ['unknown', false],
  ]
  for (const [kind, expected] of cases) {
    it(`returns ${expected} for ${kind}`, () => {
      expect(isPermanentKind(kind)).toBe(expected)
    })
  }
})
