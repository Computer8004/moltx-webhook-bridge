# syntax=docker/dockerfile:1
FROM oven/bun:1-slim

WORKDIR /app

# Copy workspace files
COPY package.json bun.lock ./
COPY packages/types/package.json packages/types/
COPY packages/server/package.json packages/server/

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY packages/types packages/types
COPY packages/server packages/server

# Build packages
RUN bun run build

# Production stage
WORKDIR /app/packages/server

ENV NODE_ENV=production

EXPOSE 8080

CMD ["bun", "run", "dist/index.js"]
