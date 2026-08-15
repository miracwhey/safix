import React, { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Zap, Droplets, Wrench, Layers, Hammer, Paintbrush, Flame, Home,
  MapPin, Calendar, Euro, ClipboardList, CheckCircle2, Search, MessageCircle,
  Scan, TriangleAlert, Pencil, X, Plus,
  type LucideIcon,
} from 'lucide-react'
import { useSmartBack } from '../hooks/useSmartBack'
import AppShell from '../components/AppShell'
import DiagnosticDebugBlock from '../components/DiagnosticDebugBlock'
import { createProjectFromBuilderWorkflow } from '../lib/workflow'
import { deriveProjectBuilderReadiness } from '../lib/projects'
import type { ProjectBuilderInput } from '../lib/projects'
import type { RuntimeDiagnostic } from '../lib/diagnostics'
import { submitBuilderProject } from './submitBuilderProject'
import { getTradeQuestions, type TradeQuestion, type TradeAnswer } from '../lib/projects/tradeQuestions'
import {
  RoomPlan,
  type RoomScanResult,
} from '@fixup/capacitor-roomplan'
import { captureScan } from '../lib/spatial'
import { promoteScanToScene } from '../lib/spatial/canonical/workflow/promoteScanToScene'
import { supabase } from '../lib/supabase'
import { logError } from '../lib/observability'
import { useToast } from '../hooks/useToast'

// ── Constants ────────────────────────────────────────────────────────────────

const SERVICE_CATEGORIES: { label: string; icon: LucideIcon }[] = [
  { label: 'Elektrik', icon: Zap },
  { label: 'Bad', icon: Droplets },
  { label: 'Sanitär', icon: Wrench },
  { label: 'Fliesen', icon: Layers },
  { label: 'Schreinerei', icon: Hammer },
  { label: 'Malerarbeiten', icon: Paintbrush },
  { label: 'Heizung', icon: Flame },
  { label: 'Renovierung', icon: Home },
]

const BUDGET_OPTIONS = [
  'unter 500 €',
  '500 – 1.500 €',
  '1.500 – 5.000 €',
  '5.000 – 15.000 €',
  'über 15.000 €',
]

const TIMING_OPTIONS = [
  'So schnell wie möglich',
  'Innerhalb 2 Wochen',
  'Innerhalb 4 Wochen',
  'Innerhalb 3 Monate',
  'Kein fester Zeitraum',
]

type Step = 'category' | 'description' | 'details' | 'trade_questions' | 'scan' | 'summary'
const STEPS: Step[] = ['category', 'description', 'details', 'trade_questions', 'scan', 'summary']

const STEP_LABELS: Record<Step, string> = {
  category: 'Kategorie',
  description: 'Beschreibung',
  details: 'Details',
  trade_questions: 'Spezifisch',
  scan: 'Raum scannen',
  summary: 'Zusammenfassung',
}

// ── Step indicator ───────────────────────────────────────────────────────────

function StepIndicator({ steps, current }: { steps: Step[]; current: Step }) {
  const currentIdx = steps.indexOf(current)
  return (
    <div className="flex items-center gap-0">
      {steps.map((step, idx) => {
        const done = idx < currentIdx
        const active = idx === currentIdx
        return (
          <div key={step} className="flex items-center">
            <div
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold transition-colors ${
                done
                  ? 'bg-emerald-500 text-white'
                  : active
                    ? 'bg-brand text-white'
                    : 'bg-slate-100 text-slate-400'
              }`}
            >
              {done ? '✓' : idx + 1}
            </div>
            {idx < steps.length - 1 && (
              <div
                className={`mx-1 h-[2px] w-8 rounded-full transition-colors ${
                  done ? 'bg-emerald-400' : 'bg-slate-200'
                }`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Completeness bar ─────────────────────────────────────────────────────────

function CompletenessBar({ score }: { score: number }) {
  const color =
    score >= 90 ? 'bg-emerald-500' : score >= 55 ? 'bg-blue-500' : 'bg-amber-400'
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] text-slate-500">Vollständigkeit</span>
        <span className="text-[12px] font-semibold text-slate-700">{score} %</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  )
}

// ── Scan step helpers ────────────────────────────────────────────────────────

function fmt(meters: number): string {
  return meters.toFixed(2).replace('.', ',') + ' m'
}

function fmtArea(m2: number): string {
  return m2.toFixed(1).replace('.', ',') + ' m²'
}

// ── Draft persistence ─────────────────────────────────────────────────────────

const DRAFT_KEY = 'fixup_pb_draft'

type DraftState = {
  step: Step
  category: string
  description: string
  location: string
  requestedBudget: string
  requestedTiming: string
  tradeAnswers: Record<string, TradeAnswer>
  /**
   * Phase 1: persist scan metadata across reloads / iOS JS-context kills so
   * a finished scan isn't lost when the user switches apps or the device
   * runs out of memory mid-builder-flow. The USDZ file itself stays on the
   * iOS temp filesystem at `usdzPath` and is re-read by Filesystem.readFile
   * on resume. If the temp file got purged by iOS (rare, low-storage), the
   * post-create upload silently skips and the user can re-scan from JobDetail.
   */
  scanResult?: RoomScanResult | null
}

function loadDraft(): DraftState | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    return raw ? (JSON.parse(raw) as DraftState) : null
  } catch {
    return null
  }
}

function saveDraft(state: DraftState): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(state))
  } catch {
    // storage quota exceeded — silently skip
  }
}

function clearDraft(): void {
  localStorage.removeItem(DRAFT_KEY)
}

// ── Scan validation ───────────────────────────────────────────────────────────

function validateScanResult(r: RoomScanResult): string | null {
  if (r.walls.length === 0) return 'Keine Wände erkannt — Scan unvollständig. Bitte erneut scannen oder Maße manuell eintragen.'
  if (r.walls.length < 3) return `Nur ${r.walls.length} Wand${r.walls.length === 1 ? '' : 'wände'} erkannt — Scan wirkt unvollständig. Bitte prüfen oder Maße korrigieren.`
  if (r.floorAreaM2 < 1) return `Bodenfläche (${r.floorAreaM2.toFixed(1)} m²) zu klein — Scan unvollständig. Bitte korrigieren.`
  if (r.floorAreaM2 > 300) return `Bodenfläche (${r.floorAreaM2.toFixed(1)} m²) sehr groß — bitte prüfen.`
  if (r.ceilingHeightM < 1.5 || r.ceilingHeightM > 6) return `Deckenhöhe (${r.ceilingHeightM.toFixed(2)} m) wirkt unrealistisch — bitte prüfen.`
  return null
}

// ── Main screen ──────────────────────────────────────────────────────────────

export default function ProjectBuilderScreen() {
  const navigate = useNavigate()
  const smartBack = useSmartBack('/projects')

  const [step, setStep] = useState<Step>(() => loadDraft()?.step ?? 'category')
  const [category, setCategory] = useState(() => loadDraft()?.category ?? '')
  const [description, setDescription] = useState(() => loadDraft()?.description ?? '')
  const [location, setLocation] = useState(() => loadDraft()?.location ?? '')
  const [requestedBudget, setRequestedBudget] = useState(() => loadDraft()?.requestedBudget ?? '')
  const [requestedTiming, setRequestedTiming] = useState(() => loadDraft()?.requestedTiming ?? '')
  const [tradeAnswers, setTradeAnswers] = useState<Record<string, TradeAnswer>>(() => loadDraft()?.tradeAnswers ?? {})
  const [hasDraft, setHasDraft] = useState(() => {
    const d = loadDraft()
    return d != null && (d.category !== '' || d.description !== '' || d.step !== 'category')
  })
  const [descriptionError, setDescriptionError] = useState<string | null>(null)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submitDebug, setSubmitDebug] = useState<RuntimeDiagnostic | null>(null)

  // Scan state — kept in builder, uploaded post-creation
  const [lidarAvailable, setLidarAvailable] = useState<boolean | null>(null)
  const [scanStatus, setScanStatus] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle')
  const [scanResult, setScanResult] = useState<RoomScanResult | null>(() => loadDraft()?.scanResult ?? null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scanWarning, setScanWarning] = useState<string | null>(null)
  const toast = useToast()
  const tradeQuestions = getTradeQuestions(category)

  const partialInput: Partial<ProjectBuilderInput> = {
    category,
    description,
    location,
    requestedBudget: requestedBudget || undefined,
    requestedTiming: requestedTiming || undefined,
  }

  const readiness = deriveProjectBuilderReadiness(partialInput)

  // Persist draft to localStorage on every form-state change
  useEffect(() => {
    saveDraft({ step, category, description, location, requestedBudget, requestedTiming, tradeAnswers, scanResult })
  }, [step, category, description, location, requestedBudget, requestedTiming, tradeAnswers, scanResult])

  // Check LiDAR availability once when scan step becomes active
  useEffect(() => {
    if (step !== 'scan' || lidarAvailable !== null) return
    RoomPlan.checkAvailability()
      .then(({ available }) => setLidarAvailable(available))
      .catch(() => setLidarAvailable(false))
  }, [step, lidarAvailable])

  // Phase 1 hotfix (post-review H3): roomScanTelemetry listener moved to
  // src/lib/native/bootstrap.ts so every scan-flow consumer shares the
  // SAME listener instance. Previous per-screen attachment double-logged
  // events when both ProjectBuilderScreen + useStartRoomScan-driven
  // screens were navigated through in the same session.

  // ── Scan handler ─────────────────────────────────────────────────────────

  const handleScan = useCallback(async () => {
    // Re-check LiDAR right before starting — surfacing "kein LiDAR" here
    // means a user who tapped the (mistakenly enabled) button gets a clear
    // explanation instead of a generic SCAN_FAILED. Without this guard a
    // non-LiDAR device falls through to the native ROOMPLAN_V2_UNAVAILABLE reject.
    if (lidarAvailable === false) {
      toast.info('Dein Gerät hat keinen LiDAR-Sensor. Du kannst die Maße manuell eintragen.')
      return
    }
    setScanStatus('scanning')
    setScanError(null)
    setScanWarning(null)
    try {
      const result = await RoomPlan.startScan()
      setScanResult(result)
      setScanStatus('done')
      const warning = validateScanResult(result)
      setScanWarning(warning)
      if (warning) {
        // The scan IS saved — warning toast clarifies the orange banner the
        // user is about to see and prevents the "ist es jetzt drin?" doubt.
        toast.info('Scan gespeichert — Maße bitte prüfen.')
      } else {
        toast.success('Scan erfasst ✓')
      }
    } catch (err) {
      const code = err instanceof Error ? (err as Error & { code?: string }).code ?? '' : ''
      // Phase 1: Capacitor reject() passes the error code as `code` on the
      // thrown Error; some older Capacitor versions prefix the message —
      // fall back to message-includes() so behaviour stays stable across
      // bridge updates.
      const msg = err instanceof Error ? err.message : String(err)
      const matches = (token: string) => code === token || msg.includes(token)

      if (matches('SCAN_CANCELLED')) {
        setScanStatus('idle')
        // No toast — user pressed Abbrechen, that's a deliberate action.
        return
      }
      if (matches('SCAN_BACKGROUNDED')) {
        setScanStatus('idle')
        toast.info('Scan unterbrochen — App war im Hintergrund. Bitte erneut starten.')
        return
      }
      if (matches('SCAN_PROCESSING_TIMEOUT')) {
        setScanError('Scan-Verarbeitung dauert zu lange. Bitte erneut versuchen.')
        setScanStatus('error')
        toast.error('Scan-Verarbeitung dauert zu lange. Bitte erneut versuchen.')
        logError('roomScan.processing_timeout', err)
        return
      }
      if (matches('SCAN_INSUFFICIENT_DATA')) {
        setScanError('Zu wenig Raumdaten erfasst. Bitte mehr Wände scannen.')
        setScanStatus('error')
        toast.error('Zu wenig Raumdaten. Bitte mehr Wände scannen.')
        return
      }
      if (matches('ROOMPLAN_V2_UNAVAILABLE')) {
        setScanStatus('idle')
        setLidarAvailable(false)
        toast.info('Dein Gerät hat keinen LiDAR-Sensor.')
        return
      }
      if (matches('CAMERA_PERMISSION_DENIED')) {
        setScanStatus('idle')
        toast.error('Kamera-Zugriff verweigert. Bitte in den iOS-Einstellungen aktivieren.')
        // iOS WebView routes `app-settings:` to UIApplication.openSettingsURLString.
        try { window.open('app-settings:') } catch { /* ignore */ }
        return
      }
      setScanError('Scan fehlgeschlagen. Bitte erneut versuchen.')
      setScanStatus('error')
      toast.error('Scan fehlgeschlagen. Bitte erneut versuchen.')
      logError('roomScan.start_failed', err, { code, msg })
    }
  }, [lidarAvailable, toast])

  const handleUpdateScan = useCallback((updated: RoomScanResult) => {
    setScanResult(updated)
    setScanWarning(validateScanResult(updated))
  }, [])

  const handleRemoveScan = useCallback(() => {
    setScanResult(null)
    setScanStatus('idle')
    setScanError(null)
  }, [])

  function handleDiscardDraft() {
    clearDraft()
    setHasDraft(false)
    setStep('category')
    setCategory('')
    setDescription('')
    setLocation('')
    setRequestedBudget('')
    setRequestedTiming('')
    setTradeAnswers({})
    setScanResult(null)
    setScanStatus('idle')
    setScanError(null)
  }

  // ── Navigation helpers ───────────────────────────────────────────────────

  const skipTradeQuestions = tradeQuestions.length === 0

  function goNext() {
    let idx = STEPS.indexOf(step)
    if (STEPS[idx + 1] === 'trade_questions' && skipTradeQuestions) idx += 1
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1])
  }

  function goBack() {
    let idx = STEPS.indexOf(step)
    if (idx > 0 && STEPS[idx - 1] === 'trade_questions' && skipTradeQuestions) idx -= 1
    if (idx > 0) {
      setStep(STEPS[idx - 1])
    } else {
      smartBack()
    }
  }

  function canAdvanceFromStep(): boolean {
    if (step === 'category') return category.trim().length > 0
    if (step === 'description') return description.trim().length > 0
    if (step === 'details') return location.trim().length > 0
    if (step === 'trade_questions') return true
    if (step === 'scan') return scanStatus !== 'scanning'
    return readiness.isReady
  }

  function handleNext() {
    if (step === 'description' && !description.trim()) {
      setDescriptionError('Bitte beschreibe kurz, was du benötigst.')
      return
    }
    if (step === 'details' && !location.trim()) {
      setLocationError('Bitte gib einen Ort an.')
      return
    }
    setDescriptionError(null)
    setLocationError(null)
    goNext()
  }

  function handleTradeAnswer(question: TradeQuestion, value: string) {
    setTradeAnswers((prev) => ({
      ...prev,
      [question.key]: { key: question.key, label: question.label, value },
    }))
  }

  async function handleCreate() {
    if (!readiness.isReady || submitting) return

    setSubmitDebug(null)
    const answersArray = Object.values(tradeAnswers).filter((a) => a.value.trim())
    const input: ProjectBuilderInput = {
      category,
      description: description.trim(),
      location: location.trim(),
      requestedBudget: requestedBudget.trim() || undefined,
      requestedTiming: requestedTiming.trim() || undefined,
      tradeSpecificAnswers: answersArray.length > 0 ? answersArray : undefined,
    }

    const projectId = await submitBuilderProject(input, {
      createProject: createProjectFromBuilderWorkflow,
      navigate,
      setSubmitting,
      setSubmitError,
      setDebugInfo: setSubmitDebug,
    })

    // Clear draft on successful project creation
    if (projectId) clearDraft()

    // Phase 1: scan upload becomes user-visible. Navigation already happened
    // (submitBuilderProject pushes /projects/:id), so we surface progress via
    // toasts on the next screen. Awaited so we know if it succeeded — the
    // previous fire-and-forget would silently drop scans on session expiry,
    // Filesystem read errors, or RLS denies.
    if (projectId && scanResult) {
      // ToastAPI is fire-and-forget (auto-dismiss by duration). Long duration
      // on the progress toast so it stays visible during the upload; the
      // success/failure toast that follows simply supersedes it visually.
      toast.info('Scan wird hochgeladen…', 30000)
      try {
        await uploadScanAfterCreate(projectId, scanResult)
        toast.success('Scan gespeichert ✓')
      } catch (err) {
        toast.error('Scan-Upload fehlgeschlagen — du kannst ihn im Projekt erneut hochladen.')
        logError('roomScan.post_create_upload_failed', err, { projectId })
      }
    }
  }

  // ── Render helpers ───────────────────────────────────────────────────────

  const stepIdx = STEPS.indexOf(step)
  const isLastStep = step === 'summary'

  return (
    <AppShell active="home">
      <section className="px-4 py-6">
        <div className="mx-auto w-full max-w-[420px] space-y-4">
          {/* Header */}
          <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Projekt erstellen
                </div>
                <div className="mt-0.5 text-[18px] font-semibold text-slate-900">
                  {STEP_LABELS[step]}
                </div>
              </div>
              <StepIndicator steps={STEPS} current={step} />
            </div>
            {hasDraft && (
              <div className="mt-3 flex items-center justify-between rounded-card bg-amber-50 px-3 py-2 ring-1 ring-amber-200/60">
                <span className="text-[12px] text-amber-700">Entwurf wiederhergestellt</span>
                <button
                  type="button"
                  onClick={handleDiscardDraft}
                  className="text-[12px] font-semibold text-amber-600 underline underline-offset-2"
                >
                  Neu starten
                </button>
              </div>
            )}
          </div>

          {/* ── Step 1: Category ─────────────────────────────────────────── */}
          {step === 'category' && (
            <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
              <p className="text-[14px] text-slate-600">
                Wähle die Art der Arbeit, die du benötigst.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-2.5">
                {SERVICE_CATEGORIES.map((cat) => (
                  <button
                    key={cat.label}
                    type="button"
                    onClick={() => setCategory(cat.label)}
                    className={`flex items-center gap-2.5 rounded-card px-4 py-3.5 text-left transition active:scale-[0.97] ${
                      category === cat.label
                        ? 'bg-brand text-white shadow-elevated'
                        : 'bg-canvas text-ink-sub ring-1 ring-edge'
                    }`}
                  >
                    <cat.icon size={20} aria-hidden />
                    <span className="text-[14px] font-semibold">{cat.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Step 2: Description ──────────────────────────────────────── */}
          {step === 'description' && (
            <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
              <p className="text-[14px] text-slate-600">
                Beschreibe kurz, was du für{' '}
                <span className="font-semibold text-slate-900">{category}</span> benötigst.
              </p>
              <div className="mt-4">
                <textarea
                  rows={5}
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value)
                    if (descriptionError) setDescriptionError(null)
                  }}
                  placeholder={`z. B. Sicherungskasten modernisieren, ca. 60 m² Fliesen legen, Badezimmer komplett renovieren…`}
                  className="w-full resize-none rounded-card bg-canvas px-4 py-3 text-[15px] text-ink ring-1 ring-edge placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
                />
                {descriptionError && (
                  <p className="mt-1.5 text-[12px] text-red-500">{descriptionError}</p>
                )}
              </div>
            </div>
          )}

          {/* ── Step 3: Details (location, timing, budget) ───────────────── */}
          {step === 'details' && (
            <div className="space-y-3">
              {/* Location (required) */}
              <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
                <label className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink-sub">
                  <MapPin size={13} aria-hidden />
                  Wo soll die Arbeit stattfinden?
                </label>
                <input
                  type="text"
                  value={location}
                  onChange={(e) => {
                    setLocation(e.target.value)
                    if (locationError) setLocationError(null)
                  }}
                  placeholder="z. B. Hannover, Berlin-Mitte"
                  className="w-full rounded-card bg-canvas px-4 py-3 text-[15px] text-ink ring-1 ring-edge placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
                />
                {locationError && (
                  <p className="mt-1.5 text-[12px] text-red-500">{locationError}</p>
                )}
              </div>

              {/* Timing (optional) */}
              <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
                <label className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink-sub">
                  <Calendar size={13} aria-hidden />
                  Gewünschter Zeitraum{' '}
                  <span className="font-normal text-ink-muted">(optional)</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {TIMING_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setRequestedTiming(requestedTiming === opt ? '' : opt)}
                      className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition active:scale-[0.96] ${
                        requestedTiming === opt
                          ? 'bg-brand text-white'
                          : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200/60'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              {/* Budget (optional) */}
              <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
                <label className="mb-2 flex items-center gap-1.5 text-[13px] font-semibold text-ink-sub">
                  <Euro size={13} aria-hidden />
                  Budgetrahmen{' '}
                  <span className="font-normal text-ink-muted">(optional)</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {BUDGET_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => setRequestedBudget(requestedBudget === opt ? '' : opt)}
                      className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition active:scale-[0.96] ${
                        requestedBudget === opt
                          ? 'bg-brand text-white'
                          : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200/60'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Step 4: Trade-specific questions ──────────────────────────── */}
          {step === 'trade_questions' && tradeQuestions.length > 0 && (
            <div className="space-y-3">
              <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
                <p className="text-[14px] text-slate-600">
                  Hilf dem Handwerker, deine{' '}
                  <span className="font-semibold text-slate-900">{category}</span>-Anfrage besser einzuschätzen.
                </p>
                <p className="mt-1 text-[12px] text-slate-400">
                  Alle Angaben sind optional — je mehr du angibst, desto genauer das Angebot.
                </p>
              </div>

              {tradeQuestions.map((question) => (
                <div
                  key={question.key}
                  className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated"
                  data-testid={`trade-question-${question.key}`}
                >
                  <label className="mb-2 block text-[13px] font-semibold text-slate-700">
                    {question.label}{' '}
                    <span className="font-normal text-slate-400">(optional)</span>
                  </label>

                  {question.type === 'text' && (
                    <input
                      type="text"
                      value={tradeAnswers[question.key]?.value ?? ''}
                      onChange={(e) => handleTradeAnswer(question, e.target.value)}
                      placeholder={question.placeholder ?? ''}
                      className="w-full rounded-card bg-canvas px-4 py-3 text-[15px] text-ink ring-1 ring-edge placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-brand/40"
                    />
                  )}

                  {question.type === 'single' && question.options && (
                    <div className="flex flex-wrap gap-2">
                      {question.options.map((opt) => {
                        const isSelected = tradeAnswers[question.key]?.value === opt
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => handleTradeAnswer(question, isSelected ? '' : opt)}
                            className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition active:scale-[0.96] ${
                              isSelected
                                ? 'bg-brand text-white'
                                : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200/60'
                            }`}
                          >
                            {opt}
                          </button>
                        )
                      })}
                    </div>
                  )}

                  {question.type === 'multi' && question.options && (
                    <div className="flex flex-wrap gap-2">
                      {question.options.map((opt) => {
                        const current = tradeAnswers[question.key]?.value ?? ''
                        const selected = current.split(', ').filter(Boolean)
                        const isSelected = selected.includes(opt)
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => {
                              const next = isSelected
                                ? selected.filter((s) => s !== opt)
                                : [...selected, opt]
                              handleTradeAnswer(question, next.join(', '))
                            }}
                            className={`rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition active:scale-[0.96] ${
                              isSelected
                                ? 'bg-brand text-white'
                                : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200/60'
                            }`}
                          >
                            {opt}
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* ── Step 5: Room scan ─────────────────────────────────────────── */}
          {step === 'scan' && (
            <div className="space-y-3">
              {scanStatus !== 'done' ? (
                <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
                  {/* Header */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Scan size={18} className="text-brand" aria-hidden />
                      <span className="text-[15px] font-semibold text-ink">Raum scannen</span>
                    </div>
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-[12px] font-semibold text-slate-500">
                      optional
                    </span>
                  </div>

                  {/* Benefits */}
                  <div className="mt-4 space-y-2">
                    {[
                      'Handwerker sehen exakte Maße — ohne Vororttermin',
                      'Präzisere Angebote, weniger Rückfragen',
                      'Scan wird automatisch bei jeder Anfrage mitgeschickt',
                    ].map((text) => (
                      <div key={text} className="flex items-start gap-2">
                        <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-500" aria-hidden />
                        <span className="text-[13px] text-ink-sub">{text}</span>
                      </div>
                    ))}
                  </div>

                  {/* Scan button */}
                  <div className="mt-5">
                    {lidarAvailable === false ? (
                      <div className="flex items-center gap-2 rounded-card bg-slate-50 px-4 py-3 ring-1 ring-slate-200/60">
                        <TriangleAlert size={15} className="shrink-0 text-slate-400" aria-hidden />
                        <span className="text-[13px] text-slate-500">
                          Auf diesem Gerät nicht verfügbar — LiDAR-Sensor wird benötigt
                        </span>
                      </div>
                    ) : (
                      <>
                        {lidarAvailable === true && (
                          <div className="mb-4 rounded-card bg-blue-50/80 px-3.5 py-3.5 ring-1 ring-blue-100">
                            <p className="mb-2 text-[12px] font-semibold text-blue-800">Für beste Ergebnisse:</p>
                            <div className="space-y-1.5">
                              {[
                                'Langsam und gleichmäßig durch den Raum bewegen',
                                'Alle Ecken und Wände vollständig abfahren',
                                'Ca. 1–2 m Abstand zu den Wänden halten',
                                'Gute Beleuchtung sicherstellen',
                                'Spiegel und Glasflächen wenn möglich meiden',
                              ].map((tip) => (
                                <div key={tip} className="flex items-start gap-2">
                                  <div className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
                                  <span className="text-[12px] text-blue-700">{tip}</span>
                                </div>
                              ))}
                            </div>
                            <p className="mt-2.5 text-[11px] text-blue-500">
                              Tippe unten auf «Fertig», sobald der Raum komplett erfasst ist.
                            </p>
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={handleScan}
                          disabled={scanStatus === 'scanning' || lidarAvailable === null}
                          className="flex w-full items-center justify-center gap-2 rounded-card bg-brand py-3.5 text-[15px] font-semibold text-white shadow-elevated transition active:scale-[0.99] disabled:opacity-60"
                        >
                          <Scan size={18} aria-hidden />
                          {scanStatus === 'scanning' ? 'Scan läuft…' : 'Raum scannen'}
                        </button>
                      </>
                    )}

                    {scanError && (
                      <p className="mt-2 text-[12px] text-red-500">{scanError}</p>
                    )}
                  </div>
                </div>
              ) : (
                scanResult && (
                  <EditableScanCard
                    result={scanResult}
                    warning={scanWarning}
                    onRescan={handleScan}
                    onRemove={handleRemoveScan}
                    onUpdate={handleUpdateScan}
                  />
                )
              )}
            </div>
          )}

          {/* ── Step 6: Summary ──────────────────────────────────────────── */}
          {step === 'summary' && (
            <div className="space-y-3">
              {/* Project preview card */}
              <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    Projektvorschau
                  </div>
                  <span className="inline-flex items-center rounded-full bg-blue-50 px-3 py-1 text-[12px] font-semibold text-brand ring-1 ring-blue-200/60">
                    {category}
                  </span>
                </div>

                <h2 className="mt-3 text-[17px] font-semibold text-slate-900">
                  {category}-Projekt{location ? ` in ${location}` : ''}
                </h2>

                <p className="mt-2 text-[14px] leading-relaxed text-slate-600">
                  {description}
                </p>

                <div className="mt-4 divide-y divide-slate-100">
                  {location && <SummaryRow icon={<MapPin size={15} aria-hidden />} label="Ort" value={location} />}
                  {requestedBudget && (
                    <SummaryRow icon={<Euro size={15} aria-hidden />} label="Budget" value={requestedBudget} />
                  )}
                  {requestedTiming && (
                    <SummaryRow icon={<Calendar size={15} aria-hidden />} label="Zeitraum" value={requestedTiming} />
                  )}
                  {Object.values(tradeAnswers)
                    .filter((a) => a.value.trim())
                    .map((a) => (
                      <SummaryRow key={a.key} icon={<ClipboardList size={15} aria-hidden />} label={a.label} value={a.value} />
                    ))}
                  {scanResult && (
                    <SummaryRow
                      icon={<Scan size={15} aria-hidden />}
                      label="Raumscan"
                      value={fmtArea(scanResult.floorAreaM2)}
                    />
                  )}
                </div>

                <div className="mt-4">
                  <CompletenessBar score={readiness.completionScore} />
                </div>
              </div>

              {/* What happens next info */}
              <div className="rounded-container bg-canvas p-5 ring-1 ring-edge">
                <div className="text-[12px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                  Was passiert als nächstes?
                </div>
                <div className="mt-3 space-y-2.5">
                  {[
                    {
                      icon: <CheckCircle2 size={15} className="text-emerald-500 shrink-0 mt-0.5" aria-hidden />,
                      text: 'Dein Projekt wird als strukturierte Anfrage gespeichert.',
                    },
                    {
                      icon: <Search size={15} className="text-ink-muted shrink-0 mt-0.5" aria-hidden />,
                      text: 'Du kannst passende Handwerker in der Umgebung anfragen.',
                    },
                    {
                      icon: <MessageCircle size={15} className="text-ink-muted shrink-0 mt-0.5" aria-hidden />,
                      text: 'Nach einer Antwort entsteht ein Projekt mit Angebot und Termin.',
                    },
                  ].map((item) => (
                    <div key={item.text} className="flex items-start gap-2.5">
                      {item.icon}
                      <span className="text-[13px] text-ink-sub">{item.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── Navigation buttons ───────────────────────────────────────── */}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={goBack}
              className="flex-1 rounded-card bg-canvas py-3.5 text-[15px] font-semibold text-ink-sub ring-1 ring-edge transition active:scale-[0.99]"
            >
              {stepIdx === 0 ? 'Abbrechen' : '← Zurück'}
            </button>

            {isLastStep ? (
              <button
                type="button"
                onClick={handleCreate}
                disabled={!readiness.isReady || submitting}
                className="flex-[2] rounded-card bg-brand py-3.5 text-[15px] font-semibold text-white shadow-elevated transition active:scale-[0.99] disabled:opacity-60"
              >
                {submitting ? 'Wird erstellt…' : 'Projekt erstellen ✓'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleNext}
                disabled={!canAdvanceFromStep()}
                className="flex-[2] rounded-card bg-brand py-3.5 text-[15px] font-semibold text-white shadow-elevated transition active:scale-[0.99] disabled:opacity-60"
              >
                Weiter →
              </button>
            )}
          </div>

          {submitError && (
            <div className="rounded-card bg-rose-50 px-4 py-3 text-[13px] text-rose-700 ring-1 ring-rose-200/70">
              {submitError}
            </div>
          )}
          <DiagnosticDebugBlock diagnostic={submitDebug} />
        </div>
      </section>
    </AppShell>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

function SummaryRow({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="flex items-center gap-2.5">
        <span className="text-ink-muted">{icon}</span>
        <span className="text-[14px] text-ink-muted">{label}</span>
      </div>
      <span className="text-[14px] font-semibold text-ink">{value}</span>
    </div>
  )
}

function ScanDataRow({
  label,
  value,
  detail,
}: {
  label: string
  value: string
  detail?: string
}) {
  return (
    <div className="py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-ink-muted">{label}</span>
        <span className="text-[14px] font-semibold text-ink">{value}</span>
      </div>
      {detail && (
        <p className="mt-0.5 text-right text-[12px] text-slate-400">{detail}</p>
      )}
    </div>
  )
}

// ── Editable scan card ───────────────────────────────────────────────────────

type EditItem = { widthM: number; heightM: number }

type EditData = {
  floorAreaM2: number
  ceilingHeightM: number
  walls: EditItem[]
  doors: EditItem[]
  windows: EditItem[]
}

function resultToEditData(r: RoomScanResult): EditData {
  return {
    floorAreaM2: r.floorAreaM2,
    ceilingHeightM: r.ceilingHeightM,
    walls: r.walls.map((w) => ({ widthM: w.widthM, heightM: w.heightM })),
    doors: r.doors.map((d) => ({ widthM: d.widthM, heightM: d.heightM })),
    windows: r.windows.map((w) => ({ widthM: w.widthM, heightM: w.heightM })),
  }
}

function EditableScanCard({
  result,
  warning,
  onRescan,
  onRemove,
  onUpdate,
}: {
  result: RoomScanResult
  warning: string | null
  onRescan: () => void
  onRemove: () => void
  onUpdate: (r: RoomScanResult) => void
}) {
  const [editing, setEditing] = useState(false)
  const [editData, setEditData] = useState<EditData>(() => resultToEditData(result))

  function enterEdit() {
    setEditData(resultToEditData(result))
    setEditing(true)
  }

  function saveEdit() {
    onUpdate({ ...result, ...editData })
    setEditing(false)
  }

  function updateItem(section: keyof Pick<EditData, 'walls' | 'doors' | 'windows'>, idx: number, patch: Partial<EditItem>) {
    setEditData((prev) => ({
      ...prev,
      [section]: prev[section].map((item, i) => (i === idx ? { ...item, ...patch } : item)),
    }))
  }

  function removeItem(section: keyof Pick<EditData, 'walls' | 'doors' | 'windows'>, idx: number) {
    setEditData((prev) => ({ ...prev, [section]: prev[section].filter((_, i) => i !== idx) }))
  }

  function addItem(section: keyof Pick<EditData, 'walls' | 'doors' | 'windows'>) {
    const defaults = { walls: { widthM: 2.5, heightM: 2.5 }, doors: { widthM: 0.9, heightM: 2.05 }, windows: { widthM: 1.0, heightM: 1.0 } }
    setEditData((prev) => ({ ...prev, [section]: [...prev[section], defaults[section]] }))
  }

  if (editing) {
    return (
      <div className="rounded-container bg-surface ring-1 ring-edge shadow-elevated overflow-hidden">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <span className="text-[15px] font-semibold text-ink">Maße anpassen</span>
          <div className="flex gap-4">
            <button type="button" onClick={() => setEditing(false)} className="text-[13px] text-slate-500">
              Abbrechen
            </button>
            <button type="button" onClick={saveEdit} className="text-[13px] font-semibold text-brand">
              Übernehmen
            </button>
          </div>
        </div>
        <div className="space-y-5 px-5 py-4">
          {/* Floor + ceiling scalars */}
          <div className="space-y-3">
            <EditMetricRow label="Bodenfläche" value={editData.floorAreaM2} unit="m²"
              onChange={(v) => setEditData((p) => ({ ...p, floorAreaM2: v }))} />
            <EditMetricRow label="Deckenhöhe" value={editData.ceilingHeightM} unit="m"
              onChange={(v) => setEditData((p) => ({ ...p, ceilingHeightM: v }))} />
          </div>
          <EditSection label="Wände" items={editData.walls} itemPrefix="Wand" addLabel="Wand hinzufügen"
            onUpdate={(i, p) => updateItem('walls', i, p)} onRemove={(i) => removeItem('walls', i)} onAdd={() => addItem('walls')} />
          <EditSection label="Türen" items={editData.doors} itemPrefix="Tür" addLabel="Tür hinzufügen"
            onUpdate={(i, p) => updateItem('doors', i, p)} onRemove={(i) => removeItem('doors', i)} onAdd={() => addItem('doors')} />
          <EditSection label="Fenster" items={editData.windows} itemPrefix="Fenster" addLabel="Fenster hinzufügen"
            onUpdate={(i, p) => updateItem('windows', i, p)} onRemove={(i) => removeItem('windows', i)} onAdd={() => addItem('windows')} />
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-container bg-surface p-5 ring-1 ring-edge shadow-elevated">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500">
            <CheckCircle2 size={14} className="text-white" aria-hidden />
          </div>
          <span className="text-[15px] font-semibold text-ink">Scan bereit</span>
        </div>
        <button type="button" onClick={enterEdit}
          className="flex items-center gap-1 text-[12px] font-semibold text-brand">
          <Pencil size={12} aria-hidden />
          Bearbeiten
        </button>
      </div>

      {warning && (
        <div className="mt-3 flex items-start gap-2 rounded-card bg-amber-50 px-3 py-2.5 ring-1 ring-amber-200/60">
          <TriangleAlert size={14} className="mt-0.5 shrink-0 text-amber-500" aria-hidden />
          <div>
            <p className="text-[12px] leading-relaxed text-amber-700">{warning}</p>
            <button type="button" onClick={enterEdit}
              className="mt-1 text-[12px] font-semibold text-amber-600 underline underline-offset-2">
              Maße manuell korrigieren →
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 divide-y divide-slate-100">
        <ScanDataRow label="Bodenfläche" value={fmtArea(result.floorAreaM2)} />
        <ScanDataRow label="Deckenhöhe" value={fmt(result.ceilingHeightM)} />
        <ScanDataRow label="Wände" value={`${result.walls.length}`}
          detail={result.walls.slice(0, 2).map((w) => `${fmt(w.widthM)} × ${fmt(w.heightM)}`).join(', ')} />
        {result.doors.length > 0 && (
          <ScanDataRow label="Türen" value={`${result.doors.length}`}
            detail={result.doors.map((d) => `${fmt(d.widthM)} × ${fmt(d.heightM)}`).join(', ')} />
        )}
        {result.windows.length > 0 && (
          <ScanDataRow label="Fenster" value={`${result.windows.length}`}
            detail={result.windows.map((w) => `${fmt(w.widthM)} × ${fmt(w.heightM)}`).join(', ')} />
        )}
        {result.furnitureCount > 0 && (
          <ScanDataRow label="Objekte erkannt" value={`${result.furnitureCount}`} />
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <button type="button" onClick={onRescan}
          className="flex-1 rounded-card bg-slate-100 py-2.5 text-[13px] font-semibold text-ink-sub transition active:scale-[0.98]">
          Neu scannen
        </button>
        <button type="button" onClick={onRemove}
          className="rounded-card bg-slate-100 px-4 py-2.5 text-[13px] font-semibold text-slate-500 transition active:scale-[0.98]">
          Entfernen
        </button>
      </div>
    </div>
  )
}

function EditMetricRow({ label, value, unit, onChange }: {
  label: string; value: number; unit: string; onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[13px] text-ink-muted">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="number" min="0.01" step="0.01"
          value={value > 0 ? value : ''}
          onChange={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n) && n > 0) onChange(n) }}
          className="w-20 rounded-md bg-canvas px-2 py-1.5 text-right text-[13px] font-semibold text-ink ring-1 ring-edge focus:outline-none focus:ring-2 focus:ring-brand/40"
        />
        <span className="text-[12px] text-slate-400">{unit}</span>
      </div>
    </div>
  )
}

function EditSection({ label, items, itemPrefix, addLabel, onUpdate, onRemove, onAdd }: {
  label: string
  items: EditItem[]
  itemPrefix: string
  addLabel: string
  onUpdate: (idx: number, patch: Partial<EditItem>) => void
  onRemove: (idx: number) => void
  onAdd: () => void
}) {
  return (
    <div>
      <p className="mb-2 text-[12px] font-semibold uppercase tracking-[0.12em] text-slate-400">
        {label} ({items.length})
      </p>
      <div className="space-y-2">
        {items.map((item, idx) => (
          <div key={idx} className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[12px] text-ink-muted">{itemPrefix} {idx + 1}</span>
            <input type="number" min="0.01" step="0.01" value={item.widthM > 0 ? item.widthM : ''}
              onChange={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n) && n > 0) onUpdate(idx, { widthM: n }) }}
              className="w-[68px] rounded-md bg-canvas px-2 py-1.5 text-right text-[13px] font-semibold text-ink ring-1 ring-edge focus:outline-none focus:ring-2 focus:ring-brand/40"
            />
            <span className="text-[12px] text-slate-400">×</span>
            <input type="number" min="0.01" step="0.01" value={item.heightM > 0 ? item.heightM : ''}
              onChange={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n) && n > 0) onUpdate(idx, { heightM: n }) }}
              className="w-[68px] rounded-md bg-canvas px-2 py-1.5 text-right text-[13px] font-semibold text-ink ring-1 ring-edge focus:outline-none focus:ring-2 focus:ring-brand/40"
            />
            <span className="text-[12px] text-slate-400 shrink-0">m</span>
            <button type="button" onClick={() => onRemove(idx)}
              className="ml-auto shrink-0 text-slate-300 transition hover:text-red-400 active:scale-90">
              <X size={15} aria-hidden />
            </button>
          </div>
        ))}
      </div>
      <button type="button" onClick={onAdd}
        className="mt-2 flex items-center gap-1 text-[12px] font-semibold text-brand">
        <Plus size={13} aria-hidden />
        {addLabel}
      </button>
    </div>
  )
}

// ── Post-creation scan upload ────────────────────────────────────────────────
// Fire-and-forget after project creation. Scan is optional — failure is silent
// to avoid confusing the user after successful project creation. Writes to the
// Spatial domain (Block B): creates a scan row, walks draft→capturing→captured,
// uploads the USDZ to {user}/{scan}/usdz/<sha>.usdz with content-addressed dedup.

/**
 * Phase 1: now throws on failure so the caller can surface a toast.
 * Previous fire-and-forget swallow caused silent data loss when:
 *   - session expired between submit + upload (auth.getUser() returned null)
 *   - Filesystem.readFile failed (path invalid, permission, file purged)
 *   - captureScan() hit RLS / FSM / network errors
 *
 * Auth-loss is now an explicit Error instead of a silent `return`. Caller
 * decides whether to retry (queued) or warn the user.
 */
async function uploadScanAfterCreate(
  projectId: string,
  result: RoomScanResult,
): Promise<void> {
  const { Filesystem } = await import('@capacitor/filesystem')
  const absolutePath = result.usdzPath.replace(/^file:\/\//, '')
  const { data } = await Filesystem.readFile({ path: absolutePath })
  const base64 = typeof data === 'string' ? data : await blobToBase64(data as Blob)
  const usdzBlob = base64ToBlob(base64, 'model/vnd.usdz+zip')

  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    throw new Error('roomScan.upload: no authenticated user — session expired between submit and upload')
  }

  // Block B.1: plugin payload now includes a device-meta snapshot
  // (deviceModel / osVersion / hasLidar / arkitVersion / fpsSample / thermalState).
  // Fall back to a minimal stub when the host plugin predates B.1.
  const pluginMeta = result.deviceMeta ?? {}
  const captureResult = await captureScan({
    projectId,
    userId: user.id,
    usdzBlob,
    deviceMeta: {
      ...pluginMeta,
      appVersion:
        pluginMeta.appVersion ?? (import.meta.env.VITE_APP_VERSION as string | undefined),
    },
    fpsSample: pluginMeta.fpsSample,
    thermalState: pluginMeta.thermalState,
    durationSec: pluginMeta.durationSec,
    // Phase 2 · forward the hybrid-mesh aggregate when the plugin emitted
    // one. Undefined on non-LiDAR / iOS<17 / SPATIAL_HYBRID_MESH_ENABLED=NO.
    meshClassification: result.meshClassification,
    // Phase 2 · auto-run Quality Engine so R6 + R7 evaluate against the
    // live mesh data instead of staying in Plan B. Without this, the
    // meshClassification we just harvested is silently discarded.
    autoQuality: true,
  })

  // Szenen-Produktion (B5) — promote the captured scan to a canonical 3D scene
  // so the provider sees a renderable model. Best-effort: the scan + USDZ are
  // already persisted, so a promotion failure is logged (not surfaced to the
  // builder customer) and stays idempotently re-promotable via the scan.
  const promotion = await promoteScanToScene({
    scanId: captureResult.scan.id,
    uploaderUserId: user.id,
    projectId,
  })
  if (!promotion.ok) {
    logError('roomScan.promote_failed', new Error(promotion.message), {
      reason: promotion.reason,
      scanId: captureResult.scan.id,
      projectId,
    })
  }
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mimeType })
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
