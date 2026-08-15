#!/usr/bin/env bash
#
# Stripe-Webhook-Forward für die lokale Funding-Strecke.
#
# Leitet Stripe-Test-Events an den lokalen vercel-dev (:3211) weiter, sodass
# api/stripe-webhook.ts dieselben Events bekommt wie in Prod
# (payment_intent.succeeded/canceled/payment_failed, charge.dispute.*, payout.*).
#
# NICHT erforderlich für die Happy-Path-Funding-Journey (funding-flow.spec):
# der Browser-confirm-funding-Pfad transitioniert den Escrow-Plan synchron auf
# funded_in_escrow. Dieser Forward ist für manuelle Verifikation des
# idempotenten Webhook-Zweitpfads (Tab-Close mid-flow) + der SCA/Dispute/Payout-
# Strecken.
#
# Voraussetzung: `stripe login` (einmalig, braucht echtes TTY — nicht über die
# !-Shell, das ist kein TTY; siehe Pairing-Poll). Danach gibt `stripe listen`
# ein whsec_… aus → als STRIPE_WEBHOOK_SECRET ins vercel-dev-Env (.env.local),
# damit die Signaturprüfung in api/stripe-webhook.ts greift.
#
# Nutzung:
#   stripe login              # einmalig, im echten Terminal
#   ./scripts/stripe-listen.sh
#
set -euo pipefail

FORWARD_TARGET="${STRIPE_FORWARD_TARGET:-localhost:3211/api/stripe-webhook}"

if ! command -v stripe >/dev/null 2>&1; then
  echo "stripe CLI nicht gefunden. Install: brew install stripe/stripe-cli/stripe" >&2
  exit 1
fi

echo "→ Forwarde Stripe-Test-Events an ${FORWARD_TARGET}"
echo "  (Das ausgegebene whsec_… als STRIPE_WEBHOOK_SECRET in .env.local setzen,"
echo "   falls die Webhook-Signaturprüfung lokal getestet werden soll.)"
exec stripe listen --forward-to "${FORWARD_TARGET}"
