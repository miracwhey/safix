# FixUp

FixUp is a craftsman-marketplace platform built with React, TypeScript, Vite, and Supabase.

## Local development

```bash
npm install
cp .env.example .env   # fill in values as needed
npm run dev
```

By default the app runs entirely in-memory (no network calls, no credentials required).

## Environment variables

All client-side variables are prefixed with `VITE_`. See [`.env.example`](.env.example)
for the full reference, including inline documentation for every variable.

### Switching to Supabase

Set the following three variables (locally in `.env` or in Vercel project settings):

| Variable | Value |
|---|---|
| `VITE_DATA_SOURCE` | `supabase` |
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | `<anon-public-key>` |

Then apply the database migrations:

```bash
supabase db push   # or run supabase/migrations/*.sql in the SQL Editor
```

If `VITE_DATA_SOURCE=supabase` is set but either Supabase variable is missing the
app surfaces a clear error at startup instead of failing silently later.

### Vercel deployment

Minimum variables for a production deployment backed by Supabase:

```
VITE_DATA_SOURCE=supabase
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-public-key>
```

Add the following if you also want live Stripe payments:

```
VITE_PAYMENT_PROVIDER=stripe
VITE_STRIPE_PUBLISHABLE_KEY=pk_live_...
VITE_STRIPE_BACKEND_URL=https://<your-app>.vercel.app
STRIPE_SECRET_KEY=sk_live_...         # server-side only — set in Vercel, not in .env
STRIPE_WEBHOOK_SECRET=whsec_...       # server-side only — set in Vercel, not in .env
```

`STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are **server-side only** — they are
read by the Vercel serverless functions in `api/` and must never be placed in a
`VITE_*` variable.

## Project structure

```
src/
  lib/          # Domain logic, stores, repositories, workflows
  components/   # Reusable UI components
  screens/      # Page-level screen components
  App.tsx       # Router and top-level layout
api/            # Vercel serverless functions (Stripe integration)
supabase/       # Supabase migrations
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start the Vite dev server |
| `npm run build` | Production build |
| `npm run lint` | Run ESLint |
| `npm test` | Run Vitest unit tests |

