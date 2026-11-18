# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# base — pnpm via corepack, pinned to the version in packageManager
# ---------------------------------------------------------------------------
FROM node:22-alpine AS base
WORKDIR /app
# Fetched here, at build time, so pnpm is part of the image. Before this, each
# stage and each cli container asked npm for pnpm when it started. With no pin
# it asked for the newest release, and a cli run failed whenever npm did.
COPY package.json ./
RUN corepack enable && corepack install

# ---------------------------------------------------------------------------
# deps — full dependency tree, cached on the lockfile alone
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store && \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# builder — produce the standalone server
# ---------------------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

# ---------------------------------------------------------------------------
# tools — devDependencies + sources, for migrations and the ingest CLI.
# Kept separate from the runner so the serving image stays small and has no
# build tooling or scraper code in it.
# ---------------------------------------------------------------------------
FROM base AS tools
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# pnpm is already in the image (see base). Corepack is kept off the network so
# a cli run never depends on npm being up: if the pinned pnpm went missing, the
# run fails at once and says so, instead of hanging on a download.
ENV NEXT_TELEMETRY_DISABLED=1 \
    COREPACK_ENABLE_NETWORK=0
ENTRYPOINT ["pnpm"]
CMD ["db:migrate"]

# ---------------------------------------------------------------------------
# runner — minimal production image
# ---------------------------------------------------------------------------
FROM base AS runner
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup -g 1001 -S nodejs && adduser -u 1001 -S nextjs -G nodejs

# Traces and pictures that are expensive to make and cheap to keep. The
# compose file mounts a named volume here so they outlive the container; the
# directory has to exist in the image, owned by the app user, for the volume
# to inherit that ownership on first mount.
ENV PT_CACHE_DIR=/app/.cache
RUN mkdir -p /app/.cache && chown nextjs:nodejs /app/.cache

# `standalone` already contains the traced node_modules and server.js; static
# assets and public/ are not traced and have to be copied alongside it.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# No shell form: keeps node as PID 1 so Docker's stop signal reaches it.
CMD ["node", "server.js"]
