# Cloud Run convert worker — Blender 4.x + Node 20 + gltf-transform.
#
# Base image: linuxserver/blender ships Blender 4.x headless out of the box
# (~600 MB). We add Node + npm so the HTTP front-end + the gltf-transform
# CLI live in the same image and Cloud Run can boot a single container.
#
# Cold start budget ~30s (Cloud Run pulls + boots; Blender init is lazy).
# Configure Cloud Run with `--min-instances=1` in prod to keep latency low
# when scans are infrequent.

FROM linuxserver/blender:4.2.0

# Drop the s6 init system — Cloud Run wants a single foreground process.
ENV S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    DEBIAN_FRONTEND=noninteractive

# Node 22 directly from the official tarball — the linuxserver/blender:4.2.0
# base image ships a stale `node_18.x jammy` NodeSource entry in
# /etc/apt/sources.list.d/ that returns 404 and aborts `apt-get update`.
# We delete that entry first, then install Node from the official tarball
# (repo-free, reproducible, single layer).
#
# Node 22 is required by @supabase/supabase-js v2.98 — its realtime client
# expects native WebSocket support (added to Node in 22), otherwise it
# throws "Node.js 20 detected without native WebSocket support" at module
# import time even when realtime is never actually used.
ARG NODE_VERSION=22.11.0
RUN rm -f /etc/apt/sources.list.d/nodesource.list \
           /etc/apt/sources.list.d/nodesource*.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates xz-utils jq \
 && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
      -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
 && rm /tmp/node.tar.xz \
 && rm -rf /var/lib/apt/lists/*
# `jq` is needed by scripts/validate-mesh.sh (V1.5 Hotfix R3-P3) to parse
# the gltf-transform validate + inspect JSON output.

WORKDIR /app

# Install Node deps first so layer cache hits on most rebuilds.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Install gltf-transform CLI globally — runs as a post-processing step.
RUN npm install -g @gltf-transform/cli@^3

COPY src ./src
COPY scripts ./scripts
RUN chmod +x scripts/*.sh

ENV PORT=8080
ENV NODE_ENV=production
EXPOSE 8080

# No tini — the linuxserver/blender base image runs an s6 init under
# /init by default, which is not present in our distroless launch model.
# Cloud Run sends SIGTERM directly to PID 1; Node 20's HTTP server
# closes on signal and exits cleanly, no init wrapper required.
ENTRYPOINT []
CMD ["node", "src/server.js"]
