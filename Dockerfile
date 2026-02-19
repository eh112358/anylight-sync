# Build stage: compile TypeScript to JavaScript
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Runtime stage: only include what's needed to run
FROM node:20-alpine AS runtime
WORKDIR /app

# Run as a non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package*.json ./
# Only install production dependencies (no TypeScript compiler, no dev tools)
RUN npm install --only=production

COPY --from=builder /app/dist ./dist

# The SQLite database lives here — mount a persistent volume at this path in k8s
RUN mkdir -p /data && chown appuser:appgroup /data

USER appuser

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
