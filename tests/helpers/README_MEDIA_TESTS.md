# Media Upload Test Utilities

## Problem

Media upload tests can fail with duplicate primary key violations if `crypto.randomUUID()` is mocked with a fixed value. This can happen when:

1. Someone adds a global UUID mock for snapshot testing
2. Test setup inadvertently creates deterministic UUIDs
3. Tests run with mocked crypto implementations

The `media_uploads` table uses UUID as the primary key (`id` column), and multiple uploads in the same test with the same ID will cause constraint violations.

## Solution

The `uniqueId.ts` utility provides guaranteed unique IDs for test scenarios:

```typescript
import { uniqueTestId, resetUniqueIdCounter } from './uniqueId'

beforeEach(() => {
  resetUniqueIdCounter()
})

// Instead of crypto.randomUUID():
const id = uniqueTestId()
```

## How It Works

- `uniqueTestId()` generates a UUID and appends an incrementing counter
- Each call returns a unique value, even if `crypto.randomUUID()` is mocked
- Counter resets in `beforeEach` for test isolation
- Output is still a valid UUID format

## When to Use

**Use `uniqueTestId()` when:**
- Creating test fixtures with UUID primary keys
- Building test data that will be inserted into repositories
- Writing test helpers that create multiple entities

**Don't use `uniqueTestId()` when:**
- Testing production code behavior (use real `crypto.randomUUID()`)
- Testing UUID generation itself
- Writing integration tests that should use real UUIDs

## Current Status

As of this fix:
- ✅ All media upload tests pass
- ✅ No duplicate key violations
- ✅ Production code unchanged
- ✅ `crypto.randomUUID()` not mocked in tests

## Future-Proofing

If you need to mock `crypto.randomUUID()` for other tests:

```typescript
// ❌ DON'T: Mock with fixed value
vi.spyOn(crypto, 'randomUUID').mockReturnValue('fixed-uuid')

// ✅ DO: Mock with unique values
let counter = 0
vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
  return `test-uuid-${counter++}`
})
```

Or use the `uniqueTestId()` utility which handles this automatically.
