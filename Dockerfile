# ==============================================================================
# Multi-stage Production Dockerfile for Hydraulic Hose Repair ERP
# ==============================================================================

# Stage 1: Build Modern React SPA
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /build/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# Stage 2: Production Runtime
FROM node:20-bookworm-slim AS runner

# Install system utilities & Chromium rendering dependencies for PDF export
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    sqlite3 \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    PORT=9999 \
    TRUST_PROXY=1 \
    BILLING_AUTH=on

# Install backend dependencies
COPY dashboard/package*.json ./dashboard/
WORKDIR /app/dashboard
RUN npm ci --omit=dev

WORKDIR /app

# Copy backend application source
COPY dashboard/ ./dashboard/

# Copy compiled frontend from Stage 1 into dashboard/public_dist
COPY --from=frontend-builder /build/dashboard/public_dist ./dashboard/public_dist/

# Ensure runtime directories exist
RUN mkdir -p /app/dashboard/logs /app/dashboard/backups /app/backups

EXPOSE 9999

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:9999/api/health || exit 1

WORKDIR /app/dashboard
CMD ["node", "server.js"]
