# SaFix Canonical State Model — Customer ↔ Craftsman Workflow

**Last Updated**: 2026-03-21
**Purpose**: Define the single source of truth for all workflow states across customer and craftsman surfaces.

---

## 1. CANONICAL STATE PRECEDENCE

All surfaces (customer thread, customer project detail, craftsman thread, craftsman job detail, dashboard summaries) must derive their operational state from these canonical stages in strict precedence order:

```
STAGE 1: INQUIRY
├─ Entity: Conversation (conversation.inquiryOrigin set, no job linked)
├─ Customer State: "Anfrage läuft" — waiting for craftsman response
├─ Craftsman State: "Neue Anfrage" — appears in inbox, convert or decline
└─ Key Signals: conversation.reviewedAt (craftsman opened), messages.length

STAGE 2: OFFER PENDING
├─ Entity: Offer (offer.status = 'pending')
├─ Customer State: "Angebot erhalten" — can accept or decline
├─ Craftsman State: "Angebot gesendet" — waiting for customer decision
└─ Key Signals: offer.createdAt, offer.conversationId

STAGE 3: OFFER ACCEPTED → DEPOSIT REQUIRED
├─ Entities: Offer (status='accepted'), Job (sourceConversationId set, proposalAcceptedAt set), Payment (state='deposit_required')
├─ Customer State: "Anzahlung erforderlich" — must pay deposit before work starts
├─ Craftsman State: "Wartet auf Anzahlung" — cannot start until deposit received
└─ Key Signals: offer.acceptedAt, job.proposalAcceptedAt, payment.state = 'deposit_required'

STAGE 4: DEPOSIT PAID → AWAITING SCHEDULE
├─ Entities: Payment (state='deposit_paid'), Job (status='new' or 'scheduled'), Schedule (may not exist yet)
├─ Customer State: "Anzahlung bezahlt" — waiting for craftsman to schedule
├─ Craftsman State: "Termin planen" — must create schedule before execution
└─ Key Signals: payment.state = 'deposit_paid', schedule exists or not

STAGE 5: SCHEDULED
├─ Entities: Schedule (schedulingStatus='scheduled'), Job (status='scheduled')
├─ Customer State: "Termin festgelegt" — showing scheduled date/time
├─ Craftsman State: "Geplant" — ready to start on schedule
└─ Key Signals: schedule.scheduledStart, schedule.scheduledEnd

STAGE 6: EXECUTION IN PROGRESS
├─ Entities: Job (status='in_progress'), Schedule (schedulingStatus='execution_started'), Payment (state='work_in_progress')
├─ Customer State: "Auftrag läuft" — work is being done
├─ Craftsman State: "Ausführung aktiv" — documenting progress
└─ Key Signals: job.status = 'in_progress', schedule.schedulingStatus = 'execution_started'

STAGE 7: WORK COMPLETED → RELEASE PENDING
├─ Entities: Job (status='waiting_payment', workCompletedAt set), Payment (state='release_pending'), Invoice (status='issued')
├─ Customer State: "Freigabe erforderlich" — must review and release payment
├─ Craftsman State: "Wartet auf Freigabe" — cannot receive payout until customer releases
└─ Key Signals: job.workCompletedAt, payment.state = 'release_pending', invoice.status

STAGE 8: COMPLETED
├─ Entities: Job (status='completed', paymentReleasedAt set), Payment (state='released')
├─ Customer State: "Abgeschlossen" — job done, payment released
├─ Craftsman State: "Abgeschlossen" — payout received
└─ Key Signals: job.status = 'completed', payment.state = 'released', job.paymentReleasedAt

EXCEPTION: DISPUTED
├─ Entities: Dispute (status='open' or 'under_review'), Payment (state='disputed')
├─ Customer State: "Konflikt aktiv" — payment frozen, can submit evidence
├─ Craftsman State: "Konflikt aktiv" — payment frozen, can submit evidence
└─ Key Signals: dispute.status, payment.state = 'disputed'
```

---

## 2. CANONICAL ENTITY LINKAGE

### The Entity Graph

```
Conversation ──┐
               │
               ├──> Job.sourceConversationId (CANONICAL, always set on new jobs)
               │
               └──> Job.projectId === Conversation.projectId (LEGACY fallback only)

Job ──────────┐
              │
              ├──> Project.sourceJobId (one-way reference)
              │
              ├──> Payment.jobId
              │
              ├──> Dispute.jobId
              │
              ├──> Schedule.jobId
              │
              └──> Invoice.jobId

Offer ────────> Offer.conversationId
              └─> Offer.createdJobId (set on acceptance)

Conversation ─> Conversation.sourceProjectId (when inquiry from builder project)
              └─> Project.id (customer builder-created project)
```

### Resolution Priority Rules

**To find a Job from a Conversation**:
1. **Primary (NEW)**: Match `job.sourceConversationId === conversation.id` (O(1) if indexed)
2. **Fallback (LEGACY)**: Match `job.projectId === conversation.projectId` (for old jobs)

**To find a Conversation from a Job**:
1. **Primary (NEW)**: `getConversationById(job.sourceConversationId)` (O(1))
2. **Fallback (LEGACY)**: `getConversationByProjectId(job.projectId)` (for old jobs)

**To determine if a Conversation is still an "incoming request"**:
1. Has `conversation.inquiryOrigin` set (reel, profile, project, category)
2. Has NOT been converted to a job yet:
   - No job where `job.sourceConversationId === conversation.id` (check first)
   - AND no job where `job.projectId === conversation.projectId` (legacy fallback)
3. Has NOT been explicitly declined: `conversation.declinedAt` is null

---

## 3. STATE DERIVATION RULES

### Customer Thread (MessageThreadScreen, role='customer')

**Action Precedence** (only ONE shown at a time):
1. **Job exists** → Show `ThreadJobContextBar` with "Projekt öffnen →" CTA
2. **Active offer (pending/accepted)** → Show `ThreadOfferCard` with accept/decline actions
3. **Customer inquiry pending** → Show `CustomerInquiryPendingBar` (encouragement)
4. **Default** → Show basic project strip

**Job Context Lookup**:
```typescript
const jobContext = getJobContextForThread(threadId)
// Returns null if no job linked, or full ThreadJobContext with:
// - jobId, status, statusLabel
// - paymentState, paymentStateLabel (from Payment entity)
// - customerProjectId (for "Projekt öffnen →" navigation)
```

### Customer Project Detail (CustomerProjectDetailScreen)

**State Sources**:
- Primary: `project = getProjectById(projectId)`
- Job linkage: `job = getJobById(project.sourceJobId)`
- Payment: `payment = getPaymentForJob(job.id)`
- Dispute: `dispute = getDisputeByJobId(job.id)`
- Message count: `getProjectConversationMessageCount(job?.projectId ?? project.id, project.messageCount)`

**Stuck State Detection** (customer-specific):
- Proposal stuck: `job.status === 'new' && !job.proposalSentAt && job.intakeContext != null`
- Scheduling stuck: `proposal accepted but >72h with no progress`
- Execution silent: `job.status === 'in_progress' but >72h since last signal`
- Payment release pending: `payment.state === 'release_pending'`

### Craftsman Thread (MessageThreadScreen, role='craftsman')

**Action Precedence** (only ONE shown at a time):
1. **Job exists** → Show `ThreadJobContextBar` with "Zum Auftrag →" CTA
2. **Incoming request** → Show `CraftsmanRequestActionCard` with convert/decline actions
3. **Active offer (pending/accepted)** → Show `ThreadOfferCard`
4. **Craftsman inquiry (no job, no request, no offer)** → Show `CraftsmanOfferForm`
5. **Default** → Show basic project strip

**Incoming Request Detection**:
```typescript
const incomingRequest = getIncomingRequestForThread(threadId)
// Returns null for customer role
// Returns IncomingRequestItem if:
//   - conversation.inquiryOrigin is set
//   - No job linked (checked via sourceConversationId AND projectId)
//   - conversation.declinedAt is null
```

### Craftsman Job Detail (CraftsmanJobDetailScreen)

**State Sources**:
- Primary: `job = getJobById(jobId)`
- Conversation: `getConversationMessagesForJob(jobId)` (via sourceConversationId priority)
- Schedule: `schedule = getScheduleForJob(jobId)`
- Payment: `payment = getPaymentForJob(jobId)`
- Dispute: `dispute = getDisputeByJobId(jobId)`
- Invoice: `invoice = getInvoiceByJobId(jobId)`

**Operational Summary**:
```typescript
const summary = deriveJobOperationalSummary({
  jobId, jobStatus, paymentState, disputeStatus,
  schedulingStatus, schedule, artifactCount, timelineSignals,
  proposalSentAt, proposalAcceptedAt
})
// Returns: phase, phaseLabel, blocker, nextAction, scheduleReadiness, etc.
```

### Craftsman Dashboard (CraftsmanDashboardScreen)

**Summary Counts** (must align with detail screens):
- Active jobs: `jobs.filter(j => ['new', 'scheduled', 'in_progress', 'waiting_payment'].includes(j.status)).length`
- Jobs in progress: `jobs.filter(j => j.status === 'in_progress').length`
- Waiting payment: `jobs.filter(j => j.status === 'waiting_payment').length`
- Incoming requests: `getIncomingRequestCounts().total` (uses BOTH sourceConversationId AND projectId checks)
- Open chats: `conversations.filter(c => !c.declinedAt && hasMessages).length`

---

## 4. REQUIRED INVARIANTS

### Cross-Surface Consistency Rules

**Invariant 1: Job-Conversation Linkage**
- If `job.sourceConversationId` is set, `getConversationById(job.sourceConversationId)` must return the conversation
- Every job created via offer acceptance MUST have `sourceConversationId` set

**Invariant 2: Incoming Request Exclusivity**
- A conversation CANNOT be both "incoming request" (on dashboard) AND linked to a job (on job detail)
- Incoming request detection MUST check both sourceConversationId AND projectId

**Invariant 3: Payment State Authority**
- Payment.state is the ONLY canonical source for payment state
- Project.paymentState is denormalized and must be synced via workflows
- All surfaces must read from Payment.state, not Project.paymentState

**Invariant 4: Message Count Freshness**
- `getProjectConversationMessageCount()` must prioritize live conversation lookup
- Only use `project.messageCount` as fallback when conversation lookup fails

**Invariant 5: Thread vs Detail Role Separation**
- Thread surfaces show compact handoff cards (ThreadJobContextBar, ThreadOfferCard)
- Thread surfaces have ONE primary action CTA ("Projekt öffnen →", "Zum Auftrag →")
- Detail surfaces hold full operational workflow (deposit, scheduling, execution, completion)

**Invariant 6: Dashboard-Detail Alignment**
- Dashboard "3 incoming requests" must match the actual count of threads in "incoming" state
- Dashboard "5 active jobs" must match the actual jobs visible in job list with active statuses
- Dashboard "waiting payment: 2" must match actual jobs with status='waiting_payment'

---

## 5. WORKFLOW TRANSITION GUARANTEES

### Offer Acceptance Workflow (`acceptOfferWorkflow`)

**Atomicity Contract**:
1. Offer status → 'accepted', acceptedAt timestamp set
2. Job created with:
   - `sourceConversationId = offer.conversationId` (MANDATORY)
   - `projectId = conversation.sourceProjectId ?? conversation.projectId` (fallback)
   - `proposalAcceptedAt = now` (marks acceptance)
   - `status = 'new'`
3. Project ensured/updated with:
   - `sourceJobId = job.id`
   - `paymentState = 'deposit_required'`
4. Payment created with:
   - `jobId = job.id`
   - `state = 'deposit_required'`
   - `offerId = offer.id`
5. Job-Project linkage: `linkJobToProject(job.id, project.id)`

**Post-Acceptance Guarantee**:
- Customer thread shows ThreadJobContextBar (job context exists)
- Craftsman thread shows ThreadJobContextBar (job context exists)
- Conversation no longer appears in "incoming requests" (job linked via sourceConversationId)
- Project detail shows "Anzahlung erforderlich" state
- Job detail shows "new" status with payment state "deposit_required"

### Inquiry Conversion Workflow (`convertInquiryToProjectWorkflow`)

**Atomicity Contract**:
1. Job created from conversation intake context
2. `job.sourceConversationId = conversationId` (MANDATORY)
3. Conversation marked as converted (no longer incoming)
4. Craftsman redirected to job detail page

**Post-Conversion Guarantee**:
- Conversation no longer in incoming request list
- Thread shows job context bar
- Job detail is accessible

---

## 6. TESTING MATRIX

### Required Cross-Surface Consistency Tests

| **Scenario** | **Customer Thread** | **Customer Detail** | **Craftsman Thread** | **Craftsman Detail** | **Dashboard** |
|---|---|---|---|---|---|
| **Inquiry (no job)** | Shows inquiry pending bar | N/A (builder project) | Shows convert/decline card | N/A | Counts as "incoming request" |
| **Offer sent** | Shows offer card | N/A or shows offer in timeline | Shows offer card (waiting) | Shows proposal sent | No change in counts |
| **Offer accepted** | Shows job context bar | Shows deposit required | Shows job context bar | Shows deposit_required state | Incoming count -1, active jobs +1 |
| **Deposit paid** | Job bar → "Anzahlung bezahlt" | Shows deposit paid, waiting schedule | Job bar → "Anzahlung bezahlt" | Shows deposit_paid, schedule needed | Active jobs count unchanged |
| **Scheduled** | Job bar → "Termin: [date]" | Shows scheduled date/time | Job bar → "Geplant" | Shows schedule details | Scheduled jobs +1 |
| **In progress** | Job bar → "Auftrag läuft" | Shows execution progress | Job bar → "Ausführung aktiv" | Shows execution started | In progress count +1 |
| **Waiting payment** | Job bar → "Freigabe erforderlich" | Shows release pending card | Job bar → "Wartet auf Freigabe" | Shows release pending | Waiting payment count +1 |
| **Completed** | Job bar → "Abgeschlossen" | Shows completed state | Job bar → "Abgeschlossen" | Shows completed state | Active jobs -1, waiting payment -1 |
| **Disputed** | Job bar → "Konflikt aktiv" | Shows dispute status | Job bar → "Konflikt aktiv" | Shows dispute card | Active disputes +1 |

---

## 7. IMPLEMENTATION CHECKLIST

- [ ] Ensure all job creation workflows set `sourceConversationId`
- [ ] Update `getIncomingRequestForThread()` to check sourceConversationId first
- [ ] Update `getIncomingProjectRequests()` to check sourceConversationId first
- [ ] Update `getThreadConversionState()` to check sourceConversationId first
- [ ] Ensure `getJobContextForThread()` prioritizes sourceConversationId (already done)
- [ ] Ensure `getConversationMessagesForJob()` prioritizes sourceConversationId (already done)
- [ ] Add tests verifying cross-surface consistency for all 9 stages
- [ ] Document manual test plan for full customer ↔ craftsman flow
