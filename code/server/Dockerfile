# Build context is `code/` — the workspace root, so the server can resolve its
# workspace dependencies.
FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock* ./
COPY server/package.json server/
COPY collectors/core/package.json collectors/core/
COPY collectors/claude/package.json collectors/claude/
COPY collectors/codex/package.json collectors/codex/
COPY collectors/pi/package.json collectors/pi/
RUN bun install --frozen-lockfile || bun install

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY server ./server
COPY collectors ./collectors

# The sink writes only to the object store and its index; it needs no write
# access to the image.
RUN mkdir -p /var/lib/pensieve && chown -R bun:bun /var/lib/pensieve
USER bun
WORKDIR /app/server
EXPOSE 4319
CMD ["bun", "run", "src/index.ts"]
