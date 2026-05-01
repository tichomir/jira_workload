# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Multi-stage, multi-arch Dockerfile for jira_workload backend.
# Supports linux/amd64 (Intel/AMD) and linux/arm64 (Apple Silicon, ARM servers).
# ─────────────────────────────────────────────────────────────────────────────

FROM node:20-alpine AS base

# dumb-init: PID-1 signal handler so Ctrl-C and docker stop work cleanly
RUN apk add --no-cache dumb-init wget

WORKDIR /app

# ─── Dependencies ────────────────────────────────────────────────────────────
COPY package*.json ./
RUN npm ci --only=production

# ─── Application source ──────────────────────────────────────────────────────
COPY src/    ./src/
COPY config/ ./config/

# Copy shared-types package if present (best-effort — may not exist in all setups)
COPY packages/ ./packages/

# Ensure data directories exist inside the image (volumes will overlay these)
RUN mkdir -p data/backups data/sdi-tmp data/exports

# ─── Security: run as non-root ────────────────────────────────────────────────
RUN addgroup -g 1001 -S nodejs \
 && adduser  -S nodeapp -u 1001 -G nodejs \
 && chown -R nodeapp:nodejs /app

USER nodeapp

# ─── Runtime ─────────────────────────────────────────────────────────────────
EXPOSE 4000

# wget is available in this image; used by the built-in HEALTHCHECK and healthcheck.sh
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT:-4000}/health" || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
