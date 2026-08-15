/**
 * ThreadTruthTracePanel
 *
 * Temporary debug/diagnosis panel rendered inside the message thread screen.
 * Exposes the full truth trace for the current thread:
 * - auth user, conversation, project, offer, job, and payment state
 * - persistence confirmation status for project and offer artifacts
 * - last write results for project attach, offer create, offer accept
 *
 * Rendered unconditionally in the thread screen as a collapsible panel.
 * This is intentionally always visible during the diagnosis phase to surface
 * runtime truth. Can be gated behind an env var or removed once the root
 * cause is identified and fixed.
 */

import { useState } from 'react'
import type { TruthTraceSnapshot } from '../../lib/messages'

type Props = {
  snapshot: TruthTraceSnapshot
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    confirmed: 'bg-green-100 text-green-800 ring-green-300',
    unconfirmed: 'bg-amber-100 text-amber-800 ring-amber-300',
    missing: 'bg-red-100 text-red-800 ring-red-300',
  }
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-bold ring-1 ${
        colors[status] ?? 'bg-slate-100 text-slate-700 ring-slate-300'
      }`}
    >
      {status}
    </span>
  )
}

function WriteResultRow({ label, result }: { label: string; result: { success: boolean; error?: string; timestamp: number; detail?: Record<string, unknown> } | undefined }) {
  if (!result) {
    return (
      <div className="text-[10px] text-slate-400">
        <span className="font-semibold">{label}:</span> no write recorded
      </div>
    )
  }
  return (
    <div className="text-[10px]">
      <span className="font-semibold">{label}:</span>{' '}
      <span className={result.success ? 'text-green-700' : 'text-red-700'}>
        {result.success ? '✓ success' : `✗ failed: ${result.error}`}
      </span>
      {result.detail && (
        <span className="ml-1 text-slate-400">
          {JSON.stringify(result.detail)}
        </span>
      )}
    </div>
  )
}

export default function ThreadTruthTracePanel({ snapshot }: Props) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="rounded-[12px] bg-slate-900 px-3 py-2 text-[11px] text-slate-200 ring-1 ring-slate-700 shadow-lg">
      <button
        type="button"
        className="flex w-full items-center justify-between text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <span className="font-bold text-amber-400">🔍 Truth Trace</span>
        <div className="flex items-center gap-1.5">
          <StatusBadge status={snapshot.projectArtifactPersistenceStatus} />
          <StatusBadge status={snapshot.offerArtifactPersistenceStatus} />
          <span className="text-slate-500">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="mt-2 space-y-1.5 border-t border-slate-700 pt-2">
          {/* Auth / Scope */}
          <div className="text-[10px]">
            <span className="font-semibold text-slate-400">authUserId:</span>{' '}
            {snapshot.authUserId ?? '(none)'}
          </div>

          {/* Conversation */}
          <div className="text-[10px]">
            <span className="font-semibold text-slate-400">conversationId:</span>{' '}
            {snapshot.conversationId}
          </div>
          <div className="text-[10px]">
            <span className="font-semibold text-slate-400">sourceProjectId:</span>{' '}
            {snapshot.conversationSourceProjectId ?? '(none)'}
            {' → '}
            {snapshot.sourceProjectIdResolvesToRealProject ? (
              <span className="text-green-400">resolves ✓</span>
            ) : (
              <span className="text-red-400">does not resolve ✗</span>
            )}
          </div>

          {/* Project Artifact */}
          <div className="text-[10px]">
            <span className="font-semibold text-slate-400">projectArtifact:</span>{' '}
            <StatusBadge status={snapshot.projectArtifactPersistenceStatus} />{' '}
            {snapshot.projectArtifactProjectId
              ? `(${snapshot.projectArtifactProjectId})`
              : '(none)'}
          </div>

          {/* Offers */}
          <div className="text-[10px]">
            <span className="font-semibold text-slate-400">offers:</span>{' '}
            {snapshot.offerCount} found{' '}
            <StatusBadge status={snapshot.offerArtifactPersistenceStatus} />
          </div>
          {snapshot.offers.map((o) => (
            <div key={o.id} className="pl-2 text-[9px] text-slate-400">
              {o.id} — {o.status} — job: {o.createdJobId ?? '(none)'}
            </div>
          ))}

          {/* Job / Payment */}
          <div className="text-[10px]">
            <span className="font-semibold text-slate-400">resolvedJobId:</span>{' '}
            {snapshot.resolvedJobId ?? '(none)'}
          </div>
          <div className="text-[10px]">
            <span className="font-semibold text-slate-400">resolvedPaymentState:</span>{' '}
            {snapshot.resolvedPaymentState ?? '(none)'}
          </div>

          {/* Write Results */}
          <div className="mt-1 border-t border-slate-700 pt-1">
            <div className="font-semibold text-slate-400 text-[10px] mb-0.5">Last Write Results:</div>
            <WriteResultRow label="projectAttach" result={snapshot.lastWriteResults.sendProjectAttachmentToThread} />
            <WriteResultRow label="createOffer" result={snapshot.lastWriteResults.createOfferWorkflow} />
            <WriteResultRow label="acceptOffer" result={snapshot.lastWriteResults.acceptOfferWorkflow} />
          </div>
        </div>
      )}
    </div>
  )
}
