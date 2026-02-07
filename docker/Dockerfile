# PostgreSQL Transactional Outbox - Production Image
#
# Multi-stage build for minimal production footprint

# ============================================
# Stage 1: Builder
# ============================================
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ============================================
# Stage 2: Production
# ============================================
FROM node:20-alpine AS production

# Security: non-root user
RUN addgroup -g 1001 -S outbox && \
    adduser -S outbox -u 1001 -G outbox

WORKDIR /app

# Copy built artifacts
COPY --from=builder --chown=outbox:outbox /app/dist ./dist
COPY --from=builder --chown=outbox:outbox /app/node_modules ./node_modules
COPY --from=builder --chown=outbox:outbox /app/package.json ./

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Switch to non-root user
USER outbox

# Environment
ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/main/index.js"]
