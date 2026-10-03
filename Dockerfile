# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder

WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy package manifests
COPY package.json pnpm-lock.yaml* ./

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source and tsconfigs
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts

# Build TypeScript to dist/
RUN pnpm run build

# Prune devDependencies for production
RUN pnpm prune --prod

# ── Production Image ──────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Copy built code and production node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Non-root user for security
USER node

EXPOSE 4000

CMD ["node", "dist/server.js"]
