# ─── Build stage ──────────────────────────────────────────────────────────────
FROM node:25-slim AS builder

WORKDIR /app

# Install build tools needed for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy package.json only — let npm generate a fresh lock file for Node 25
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# ─── Runtime stage ────────────────────────────────────────────────────────────
FROM node:25-slim AS runtime

WORKDIR /app

ARG USER_ID=2222
ARG GROUP_ID=2222

RUN groupadd -r -g ${GROUP_ID} appgroup && \
    useradd -r -u ${USER_ID} -g appgroup -s /bin/false appuser

# Copy built node_modules from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source
COPY app.js ./
COPY middleware/ ./middleware/
COPY models/ ./models/
COPY public/ ./public/
COPY routes/ ./routes/
COPY views/ ./views/

# Create data directory for SQLite databases and uploads
RUN mkdir -p data public/uploads \
    && chown -R appuser:appgroup /app

# Switch to non-root user
USER appuser

# Expose the app port (set in .env, default 3085)
EXPOSE 3085

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3085) + '/robots.txt', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "app.js"]
