# ─────────────────────────────────────────────────────────
#  Astra Local Agent — Dockerfile
#  Runs the Astra agent + SQLite in an isolated container.
#  The host Mac Mini only exposes data/ and knowledge/ dirs.
# ─────────────────────────────────────────────────────────

FROM node:22-slim AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3 (native module)
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy package files first (layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts=false

# Copy source and build
COPY tsconfig.json ./
COPY tools/ ./tools/
RUN npx tsc

# ─────────────────────────────────────────────────────────
#  Production Stage
# ─────────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Runtime dependency for better-sqlite3
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy built artifacts and production deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts=false

COPY --from=builder /app/dist/ ./dist/

# Copy non-TS files that are needed at runtime
COPY openclaw.json ./
COPY .env* ./
COPY skills/ ./skills/

# Directories that will be mounted as volumes from the host:
#   - /app/data       → SQLite DB + service_account.json
#   - /app/knowledge  → Markdown RAG files
# Create them so they exist even without mounts (graceful fallback)
RUN mkdir -p /app/data /app/knowledge

# Health check: verify the SQLite DB is accessible
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD node -e "require('better-sqlite3')('/app/data/memory.db').pragma('journal_mode')" || exit 1

# OpenClaw default port (if applicable)
EXPOSE 3000

# Default command — will be overridden by docker-compose
CMD ["node", "dist/registry/index.js"]
