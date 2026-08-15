import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MessageSquare, Phone, Globe, Calendar, Bookmark, Star } from 'lucide-react'
import type { ExploreCraftsmanProfile } from '../../lib/explore/exploreProfileService'
import { startProfileInquiryWorkflow } from '../../lib/workflow'
import { inquiryErrorMessage } from '../../lib/explore/inquiryErrorMessage'
import { formatResponseLatencyLabel } from '../../lib/messages/responseLatencySelector'
import { logError } from '../../lib/observability'
import { useSavedProvider } from '../../lib/savedProviders/useSavedProvider'
import { formatStatNumber } from '../profile/instaStatFormat'
import Spinner from '../system/Spinner'

type Props = {
  profile: ExploreCraftsmanProfile
  /** Average rating (computed at screen level from trust projection). */
  averageRating: number
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

/**
 * Customer-facing Handwerker-Reels-Profilkopf (Insta×TikTok×Handwerk).
 *
 * Layout (siehe Design „Handwerker Reels Profil"):
 *   Avatar (Conic-Accent-Ring) links · Name+Verified+Status-Pille / 3 Stats rechts
 *   → Kategorie-Zeile → Bio → (Antwortzeit/Trust) → Anfragen+Merken → Kontakt-Infos
 *
 * Anders als die geteilte `InstaProfileHeader` (Owner-Sicht in
 * `CraftsmanProfile`): hier sitzt der Name neben dem Avatar und der Handle
 * lebt im Screen-Topbar. Bewusst eigenständig gehalten, damit der Owner-
 * Header unverändert bleibt.
 *
 * Stats-Quellen (alle real):
 *   Aufträge = trust.completedJobsCount · Bewertung = averageRating + Reviews
 *   aus ratingDistribution · Likes = aggregierte Portfolio-Likes.
 *
 * Status-Pille: „Aktiv" spiegelt, dass das Profil Discovery-sichtbar geladen
 * wurde. Es gibt (noch) kein „Ausgebucht"-Signal in der DB — ein
 * Verfügbarkeits-Feld wäre die Voraussetzung dafür.
 */
export default function ExploreProfileHeaderCard({ profile, averageRating }: Props) {
  const navigate = useNavigate()
  const [inquiryPending, setInquiryPending] = useState(false)
  const [inquiryError, setInquiryError] = useState<string | null>(null)
  const savedProvider = useSavedProvider(profile.craftsmanId)

  const handleInquiry = useCallback(async () => {
    if (inquiryPending) return
    setInquiryPending(true)
    setInquiryError(null)
    try {
      const threadId = await startProfileInquiryWorkflow(profile)
      navigate(`/messages/${threadId}`)
    } catch (err) {
      logError('ui.profile_inquiry_failed', err, { craftsmanId: profile.craftsmanId })
      // Gate the user-facing message: allowlisted user-friendly errors (e.g. the
      // daily-cap reason) pass through; RbacError / Supabase / Postgrest / generic
      // technical errors collapse to a clean fallback so nothing internal leaks.
      setInquiryError(inquiryErrorMessage(err))
    } finally {
      setInquiryPending(false)
    }
  }, [inquiryPending, navigate, profile])

  const hasAvatar = Boolean(profile.craftsmanAvatarUrl)
  const responseLatencyLabel = formatResponseLatencyLabel(profile.responseLatencyLabel)
  const trustBadges = profile.trust.badges

  // Reviews = Anzahl Bewertungen (Distribution-Summe), nicht Stern-Aggregat.
  const reviewsCount = profile.ratingDistribution.reduce((sum, b) => sum + b.count, 0)
  const ratingValue = averageRating > 0 ? averageRating.toFixed(1).replace('.', ',') : '–'

  // Kategorie-Zeile: bis zu zwei distinct Gewerke + Stadt, Fallback Primärgewerk.
  const categoryParts = [...new Set(profile.tradeCategories.filter(Boolean))].slice(0, 2)
  if (profile.location) categoryParts.push(profile.location)
  const categoryLine = categoryParts.join(' · ') || profile.primaryCategory || 'Handwerker'

  const hasContactInfo = Boolean(profile.phone || profile.website || profile.yearsInBusiness)

  return (
    <div className="px-[18px] pb-3.5 pt-5">
      {/* Identity: Avatar (Accent-Ring) + Name/Status + Stats */}
      <div className="flex items-center gap-4">
        <div
          className="h-[72px] w-[72px] shrink-0 rounded-full p-[2.5px]"
          style={{ background: 'conic-gradient(from 140deg, #60A5FA, #2563EB, #60A5FA)' }}
        >
          <div className="h-full w-full rounded-full bg-white p-[2px]">
            {hasAvatar ? (
              <img
                src={profile.craftsmanAvatarUrl}
                alt={profile.craftsmanName}
                className="h-full w-full rounded-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center rounded-full bg-slate-100">
                <span className="text-[20px] font-semibold text-slate-500">
                  {getInitials(profile.craftsmanName)}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* Name + Verified + Status-Pille */}
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-[20px] font-bold leading-tight tracking-tight text-ink">
                {profile.craftsmanName}
              </span>
              {profile.verified ? (
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 24 24"
                  className="shrink-0 text-brand"
                  role="img"
                  aria-label="Verifizierter Handwerker"
                >
                  <circle cx="12" cy="12" r="10" fill="currentColor" />
                  <path
                    d="m8 12 2.6 2.6L16 9"
                    fill="none"
                    stroke="#fff"
                    strokeWidth="2.1"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : null}
            </div>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-[3px] text-[11px] font-semibold text-emerald-700 ring-1 ring-emerald-100">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
              Aktiv
            </span>
          </div>

          {/* Stats: Aufträge · Bewertung · Likes */}
          <div className="flex">
            <StatTile
              value={formatStatNumber(profile.stats.completedJobs)}
              label="Aufträge"
              accent
            />
            <StatTile
              value={ratingValue}
              valueIcon={
                <Star size={13} className="text-amber-500" aria-hidden fill="currentColor" />
              }
              label={`${reviewsCount} Bew.`}
            />
            <StatTile value={formatStatNumber(profile.likesTotal)} label="Likes" />
          </div>
        </div>
      </div>

      {/* Kategorie */}
      <p className="mt-3 text-[13px] leading-snug text-ink-muted">{categoryLine}</p>

      {/* Bio */}
      {profile.bio ? (
        <p className="mt-2 line-clamp-3 text-[13px] leading-relaxed text-ink-sub">{profile.bio}</p>
      ) : null}

      {/* Antwortzeit + Trust-Signale (real, additiv zum Design) */}
      {responseLatencyLabel || trustBadges.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-ink-muted">
          {responseLatencyLabel ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2 py-[2px] font-medium text-ink-sub ring-1 ring-edge/60">
              {responseLatencyLabel}
            </span>
          ) : null}
          {trustBadges.map((badge) => (
            <span key={badge.kind} className="inline-flex items-center gap-1">
              <span className="text-[13px] leading-none">{badge.icon}</span>
              <span>{badge.label}</span>
            </span>
          ))}
        </div>
      ) : null}

      {/* Aktionen: Anfragen (primär, full) + Merken (sekundär, Toggle) */}
      <div className="mt-4 flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => void handleInquiry()}
          disabled={inquiryPending}
          aria-busy={inquiryPending}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-card bg-brand py-[11px] text-center text-[14px] font-semibold text-white transition active:scale-[0.97] disabled:opacity-60"
        >
          {inquiryPending ? (
            <Spinner size="sm" tone="onDark" inButton />
          ) : (
            <MessageSquare size={18} aria-hidden />
          )}
          {inquiryPending ? 'Wird gesendet …' : 'Anfragen'}
        </button>
        <button
          type="button"
          onClick={() => void savedProvider.toggle()}
          disabled={savedProvider.toggling}
          aria-pressed={savedProvider.saved}
          aria-label={savedProvider.saved ? 'Gespeichert' : 'Merken'}
          className="flex items-center justify-center gap-1.5 rounded-card bg-canvas px-4 py-[11px] text-center text-[14px] font-semibold text-ink ring-1 ring-edge transition active:scale-[0.97] disabled:opacity-60"
        >
          <Bookmark
            size={18}
            aria-hidden
            className={savedProvider.saved ? 'text-brand' : undefined}
            fill={savedProvider.saved ? 'currentColor' : 'none'}
          />
          {savedProvider.saved ? 'Gemerkt' : 'Merken'}
        </button>
      </div>

      {inquiryError ? (
        <div
          role="alert"
          className="mt-2 rounded-card bg-rose-50 px-3 py-2 text-[12px] font-medium text-rose-700 ring-1 ring-rose-200"
        >
          {inquiryError}
        </div>
      ) : null}

      {/* Kontakt-Infos (real, additiv) */}
      {hasContactInfo ? (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {profile.phone ? (
            <a
              href={`tel:${profile.phone.replace(/\s/g, '')}`}
              className="flex items-center gap-1.5 text-[13px] font-medium text-ink-sub transition active:opacity-60"
            >
              <Phone size={13} className="shrink-0 text-ink-muted" aria-hidden />
              {profile.phone}
            </a>
          ) : null}
          {profile.website ? (
            <a
              href={profile.website.startsWith('http') ? profile.website : `https://${profile.website}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-[13px] font-medium text-brand transition active:opacity-60"
            >
              <Globe size={13} className="shrink-0" aria-hidden />
              {profile.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
            </a>
          ) : null}
          {profile.yearsInBusiness != null && profile.yearsInBusiness > 0 ? (
            <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink-sub">
              <Calendar size={13} className="shrink-0 text-ink-muted" aria-hidden />
              {profile.yearsInBusiness} {profile.yearsInBusiness === 1 ? 'Jahr' : 'Jahre'} Erfahrung
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function StatTile({
  value,
  label,
  accent,
  valueIcon,
}: {
  value: string
  label: string
  accent?: boolean
  valueIcon?: React.ReactNode
}) {
  return (
    <div className="flex flex-1 flex-col items-center gap-[3px]">
      <span
        className={`flex items-center gap-1 text-[18px] font-bold leading-none tracking-tight tabular-nums ${
          accent ? 'text-brand' : 'text-ink'
        }`}
      >
        {valueIcon}
        {value}
      </span>
      <span className="max-w-full truncate text-[11px] font-medium text-ink-muted">{label}</span>
    </div>
  )
}
