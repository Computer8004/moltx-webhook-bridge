# syntax=docker/dockerfile:1
FROM node:20-slim

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy workspace files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/types/package.json packages/types/
COPY packages/server/package.json packages/server/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/types packages/types
COPY packages/server packages/server

# Build packages
RUN pnpm -r build

# Production stage
WORKDIR /app/packages/server

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "dist/index.js"]
