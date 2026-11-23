# syntax=docker/dockerfile:1
#
# Production image for the Dub web app (Next.js standalone output).
# Build from the repository root:
#   docker build -f selfhost/web/Dockerfile .
#
# The "builder" target contains the full toolchain; the compose stack uses
# it for the one-shot "migrate" service (prisma db push + seed).

FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# --------------------------------------------------------------- builder
FROM base AS builder
RUN apt-get update -qq && apt-get install -qqy openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN pnpm config set registry "$NPM_REGISTRY" && pnpm install --frozen-lockfile

# Build-time (inlined) envs
ARG NEXT_PUBLIC_SELFHOST_DOMAINS=""
ARG NEXT_PUBLIC_PLAUSIBLE_DOMAIN=""
ENV NEXT_PUBLIC_SELFHOST_DOMAINS=$NEXT_PUBLIC_SELFHOST_DOMAINS \
    NEXT_PUBLIC_PLAUSIBLE_DOMAIN=$NEXT_PUBLIC_PLAUSIBLE_DOMAIN \
    NEXT_OUTPUT_STANDALONE=1 \
    NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=4096

# prisma generate does not need a reachable database
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
# placeholder credentials for optional services whose clients are
# instantiated at module load during the build (AI embeddings route)
ENV UPSTASH_VECTOR_REST_URL="http://build-placeholder:8080" \
    UPSTASH_VECTOR_REST_TOKEN="build-placeholder" \
    QSTASH_TOKEN="build-placeholder" \
    QSTASH_CURRENT_SIGNING_KEY="build-placeholder" \
    QSTASH_NEXT_SIGNING_KEY="build-placeholder" \
    UPSTASH_REDIS_REST_URL="http://build-placeholder:8079" \
    UPSTASH_REDIS_REST_TOKEN="build-placeholder" \
    TINYBIRD_API_KEY="build-placeholder" \
    TINYBIRD_API_URL="http://build-placeholder:7181" \
    RESEND_API_KEY="build-placeholder"

WORKDIR /repo
RUN pnpm --filter "./packages/**" -r build && ls /repo/packages/ui/dist
WORKDIR /repo/apps/web
RUN pnpm prisma:generate && pnpm build
# stage the generated prisma client (engines + schema) for the runner
RUN mkdir -p /prisma-dist     && cp -rL "$(dirname "$(find /repo/node_modules/.pnpm -maxdepth 4 -type d -path '*/node_modules/.prisma' | head -1)")" /prisma-dist/prisma-client     || true

# --------------------------------------------------------------- runner
FROM base AS runner
RUN apt-get update -qq && apt-get install -qqy openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production     PORT=3000     HOSTNAME=0.0.0.0
WORKDIR /app

COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public
# generated prisma client (query engine + schema) on top of the traced copy
COPY --from=builder /prisma-dist/prisma-client/.prisma ./node_modules/.prisma

EXPOSE 3000
CMD ["node", "apps/web/server.js"]
