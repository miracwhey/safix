# Spatial Convert — Cloud Run Worker

Converts RoomPlan USDZ → Meshopt+KTX2 glb for the FixUp Spatial web viewer.

## Architecture

```
edge function spatial-enqueue-convert
    │
    │  POST /convert
    │  Authorization: X-Spatial-Convert-Signature (HMAC-SHA256)
    │  body { scanId, usdzPath, idempotencyKey }
    ▼
Cloud Run container (this service)
    │
    ├─ supabase.storage.download(usdzPath)
    ├─ blender --background --python scripts/convert.py
    ├─ gltf-transform optimize --compress meshopt --texture-compress ktx2
    ├─ supabase.storage.upload({user}/{scan}/gltf/<sha>.glb)
    ├─ supabase.from('scan_assets').insert({kind: 'gltf', converted_from})
    └─ supabase.rpc('record_scan_event', {action: 'asset_converted'})
```

## Local build

```bash
cd services/spatial-convert
docker build -t spatial-convert .
docker run --rm -p 8080:8080 \
  -e SPATIAL_CONVERT_TOKEN=dev-token \
  -e SPATIAL_CONVERT_SUPABASE_URL=https://<project>.supabase.co \
  -e SPATIAL_CONVERT_SERVICE_ROLE_KEY=<service-role-jwt> \
  spatial-convert
```

Smoke-test:

```bash
PAYLOAD='{"scanId":"...","usdzPath":"...","idempotencyKey":"..."}'
SIG=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac dev-token -hex | awk '{print $2}')
curl -X POST http://localhost:8080/convert \
  -H "Content-Type: application/json" \
  -H "X-Spatial-Convert-Signature: $SIG" \
  -d "$PAYLOAD"
```

## Production deploy

```bash
# Pick the same region as the Supabase project (eu-west-1 → europe-west1).
gcloud config set run/region europe-west1

# Build + push to Artifact Registry.
gcloud builds submit . \
  --tag europe-west1-docker.pkg.dev/<gcp-project>/spatial/spatial-convert:latest

# Deploy. min-instances=1 keeps cold-starts off the critical path.
gcloud run deploy spatial-convert \
  --image europe-west1-docker.pkg.dev/<gcp-project>/spatial/spatial-convert:latest \
  --platform managed \
  --concurrency 4 \
  --cpu 2 --memory 4Gi \
  --timeout 300 \
  --min-instances 1 \
  --max-instances 10 \
  --no-allow-unauthenticated \
  --set-env-vars SPATIAL_CONVERT_TOKEN=<shared-secret>,SPATIAL_CONVERT_SUPABASE_URL=https://<project>.supabase.co \
  --set-secrets SPATIAL_CONVERT_SERVICE_ROLE_KEY=spatial-convert-service-role:latest

# Grab the resolved URL and store it in Vercel + Supabase env.
gcloud run services describe spatial-convert --format='value(status.url)'
```

## Env vars

| Name | Source | Notes |
|------|--------|-------|
| `SPATIAL_CONVERT_TOKEN` | Cloud Run env | HMAC shared secret with the edge function |
| `SPATIAL_CONVERT_SUPABASE_URL` | Cloud Run env | `https://<project>.supabase.co` |
| `SPATIAL_CONVERT_SERVICE_ROLE_KEY` | Secret Manager | Service-role JWT, kept in `gcloud secrets` |
| `PORT` | Cloud Run | Auto-injected by the platform (defaults to 8080) |

## Operational notes

- Cold-start is ~30s thanks to the 600 MB Blender base. `min-instances=1`
  keeps a warm container around.
- `--concurrency 4` lets a single CPU-2 instance serve four small scans in
  parallel. Tune up if memory headroom allows.
- The in-memory idempotency window dedupes only within a single instance —
  the durable guard is `UNIQUE(scan_id, kind)` on `public.scan_assets`.
- Failures surface as 5xx so the edge function can re-enqueue with backoff.
