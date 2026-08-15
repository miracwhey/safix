# Canonical Conversations Schema

**Purpose:** This document defines the authoritative schema for the `conversations` table and the runtime payload contract to prevent schema drift.

## Schema Source of Truth

**Authoritative Migration:** `supabase/migrations/20260317000007_conversations_messages_schema.sql`

## Canonical Field Contract

The conversations table contains **22 fields** organized into the following categories:

### 1. Identity Fields (Required)
- `id` (text, PRIMARY KEY) - Conversation UUID, format: `thread_{customerUserId}_{craftsmanUserId}_{timestamp}`

### 2. Customer Display Metadata (Required for Reload)
- `customer_name` (text, NOT NULL DEFAULT '') - Display name of customer
- `customer_avatar_url` (text, NOT NULL DEFAULT '') - Customer's avatar URL
- `customer_user_id` (text, NULL) - **Canonical customer owner** (Supabase auth.uid())
  - Used for RLS policies
  - Required for conversation INSERT (RLS enforces `customer_user_id = auth.uid()`)

### 3. Craftsman Display Metadata (Required for Reload)
- `craftsman_name` (text, NOT NULL DEFAULT '') - Display name of craftsman/provider
- `craftsman_handle` (text, NOT NULL DEFAULT '') - Unique provider identifier
- `craftsman_avatar_url` (text, NOT NULL DEFAULT '') - Craftsman's avatar URL
- `craftsman_user_id` (text, NULL) - Supabase auth.uid() of craftsman

### 4. Project Context (Denormalized for Reload Safety)
- `project_title` (text, NOT NULL DEFAULT '') - Denormalized project title
- `project_subtitle` (text, NOT NULL DEFAULT '') - Denormalized project subtitle
- `project_location` (text, NULL) - Denormalized location
- `project_cost_range` (text, NULL) - Denormalized budget/cost
- `project_duration` (text, NULL) - Denormalized timing
- `project_status_label` (text, NULL) - UI status display

### 5. UI State
- `time_label` (text, NULL) - Last activity time display
- `unread_count` (integer, NULL) - Unread message badge count

### 6. Inquiry Metadata
- `inquiry_origin` (text, NULL) - Inquiry source: `'reel' | 'profile' | 'project' | 'category'`
- `source_project_id` (text, NULL) - **Single canonical persisted project reference**
  - Stores the `projectId` value (synthetic inquiry tracking ID) from the domain model
  - Format varies by inquiry type:
    - Reel: `project_explore_{craftsmanId}_{threadId}`
    - Profile: `project_profile_{craftsmanId}_{threadId}`
    - Category: `project_category_{craftsmanId}_{threadId}`
    - Project: `project_inquiry_{craftsmanId}_{threadId}`
  - **Purpose:** Used for reload-safe project identity and `getConversationByProjectId()` lookups
  - **Note:** `project_id` is NOT a persisted column — removed to fix PGRST204 live runtime error

### 7. Lifecycle Timestamps
- `reviewed_at` (bigint, NULL) - Unix ms when craftsman first opened thread
- `declined_at` (bigint, NULL) - Unix ms when craftsman explicitly declined
- `created_at` (bigint, NOT NULL DEFAULT 0) - **Sort key** - Unix ms when conversation created

### 8. Inquiry Context (Optional, Migration 20260317000011)
- `project_description` (text, NULL) - Free-text description from category/project inquiries
- `inquiry_criteria` (jsonb, NULL) - Structured search criteria from reel inquiries

## Canonical Project Reference: `source_project_id`

`source_project_id` is the **single canonical persisted project reference** in the conversations table. The `project_id` column has been removed from both the schema and the runtime payload to prevent PGRST204 errors.

In the domain model, `conversation.projectId` maps to/from `source_project_id` in the database:
- **Write:** `source_project_id = conversation.projectId`
- **Read:** `conversation.projectId = row.source_project_id ?? ''`

The domain field `conversation.sourceProjectId` remains available as an in-memory field (set at conversation creation time for builder-origin inquiries) but is not separately persisted.

## Runtime Payload Contract

**Authoritative Payload Builder:** `src/lib/messages/repository/SupabaseMessageRepository.ts:conversationToDbPayload()`

The runtime payload includes all canonical fields. `project_id` is NOT included.

### Always Written (Required)
```typescript
{
  id: conversation.id,
  customer_name: conversation.customerName,
  customer_avatar_url: conversation.customerAvatarUrl,
  craftsman_name: conversation.craftsmanName,
  craftsman_handle: conversation.craftsmanHandle,
  craftsman_avatar_url: conversation.craftsmanAvatarUrl,
  project_title: conversation.projectTitle,
  project_subtitle: conversation.projectSubtitle,
  created_at: conversation.createdAt ?? 0,
}
```

### Optional (Written as `?? null`)
```typescript
{
  customer_user_id: conversation.customerUserId ?? null,
  craftsman_user_id: conversation.craftsmanUserId ?? null,
  project_location: conversation.projectLocation ?? null,
  project_cost_range: conversation.projectCostRange ?? null,
  project_duration: conversation.projectDuration ?? null,
  project_status_label: conversation.projectStatusLabel ?? null,
  time_label: conversation.timeLabel ?? null,
  unread_count: conversation.unreadCount ?? null,
  inquiry_origin: conversation.inquiryOrigin ?? null,
  source_project_id: conversation.projectId ?? null,
  reviewed_at: conversation.reviewedAt ?? null,
  declined_at: conversation.declinedAt ?? null,
}
```

### Conditionally Written (Newer Fields)
```typescript
{
  ...(conversation.projectDescription != null && {
    project_description: conversation.projectDescription
  }),
  ...(conversation.inquiryCriteria != null && {
    inquiry_criteria: conversation.inquiryCriteria
  }),
}
```

**Rationale for Conditional Spread:**
- Prevents PGRST204 "unknown column" errors during staggered deployments
- Allows code to be deployed before migration runs on all instances
- Fields are still persisted when present

## RLS Policies

### INSERT Policy (`conversations_insert_own`)
```sql
WITH CHECK (customer_user_id = auth.uid()::text)
```
- **Only the customer** can create conversations
- **Requires** `customer_user_id` to be set and match session UID

### SELECT Policy (`conversations_select_own`)
```sql
USING (craftsman_user_id = auth.uid()::text OR customer_user_id = auth.uid()::text)
```
- **Either party** (customer or craftsman) can read

### UPDATE Policy (`conversations_update_own`)
```sql
USING (craftsman_user_id = auth.uid()::text OR customer_user_id = auth.uid()::text)
```
- **Either party** can update (mark reviewed/declined, clear unread count)

## Indexes

Performance-critical indexes:
```sql
CREATE INDEX idx_conversations_craftsman_user_id ON conversations (craftsman_user_id)
  WHERE craftsman_user_id IS NOT NULL;

CREATE INDEX idx_conversations_customer_user_id ON conversations (customer_user_id)
  WHERE customer_user_id IS NOT NULL;

CREATE INDEX idx_conversations_created_at ON conversations (created_at);
```

## Preventing Future Drift

### 1. Migration Discipline
- **All schema changes** must update migration `20260317000007` or create new migration
- Use `IF NOT EXISTS` / `IF EXISTS` guards for idempotent migrations
- Test migrations on local Supabase before deploying

### 2. Code Discipline
- **All new fields** must be added to:
  1. Migration SQL
  2. TypeScript `Conversation` type (`src/lib/messages/types.ts`)
  3. `conversationToDbPayload()` function
  4. `rowToConversation()` hydration function
- Use conditional spread for new optional fields during rollout

### 3. Test Coverage
- Maintain comprehensive tests in `tests/messages/messagePersistenceAndDisplay.test.ts`
- Add tests for new fields to verify round-trip persistence
- Test reload scenarios to catch missing display metadata

### 4. Documentation
- This document is the **single source of truth** for the conversations schema
- Update this document whenever the schema changes
- Link to this document in code comments when adding new fields

## Common Pitfalls

1. **Adding a field to TypeScript but not the DB** → Runtime INSERT fails (PGRST204)
2. **Adding a field to DB but not TypeScript** → Field is never written, silently dropped
3. **Forgetting display metadata** → Thread shows "undefined" on reload
4. **Writing `project_id` to the DB** → PGRST204 error (column does not exist)
5. **Not using conditional spread for new fields** → Fails on instances without migration

## Change History

- **2026-03-17** - Initial canonical schema definition (migration 20260317000007)
- **2026-03-17** - Added `project_description` and `inquiry_criteria` (migration 20260317000011)
- **2026-03-21** - Backfilled display columns on production instances (migration 20260321000000)
- **2026-03-21** - Removed `project_id` from schema and runtime payload; `source_project_id` is now the single canonical persisted project reference
