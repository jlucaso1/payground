# syntax=docker/dockerfile:1

# --- build: bundle the CLI and the dashboard assets -------------------------
FROM oven/bun:1.4 AS build
WORKDIR /app

# Workspace manifests first, so the dependency layer is cached across source edits.
COPY package.json bun.lock bunfig.toml ./
COPY packages/cli/package.json ./packages/cli/
COPY packages/core/package.json ./packages/core/
COPY packages/dashboard/package.json ./packages/dashboard/
COPY packages/mercadopago/package.json ./packages/mercadopago/
COPY packages/server/package.json ./packages/server/
COPY packages/storage/package.json ./packages/storage/
COPY tools/spec-sync/package.json ./tools/spec-sync/
COPY e2e/package.json ./e2e/
RUN bun install --frozen-lockfile

COPY tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN bun run build

# --- runtime ----------------------------------------------------------------
FROM oven/bun:1.4-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PAYGROUND_HOST=0.0.0.0 \
    PAYGROUND_PORT=8080 \
    PAYGROUND_DB=/data/payground.sqlite

COPY --from=build /app/dist ./dist
COPY --chown=bun:bun LICENSE README.md ./

# The named volume inherits this ownership, so the non-root user can write the database.
RUN mkdir -p /data && chown bun:bun /data
VOLUME ["/data"]

USER bun
EXPOSE 8080

# Exec form: a shell would expand ${...} and backticks inside the script before bun sees it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "const p = process.env.PAYGROUND_PORT ?? '8080'; const r = await fetch('http://127.0.0.1:' + p + '/_payground/health').catch(() => null); process.exit(r !== null && r.ok ? 0 : 1)"]

ENTRYPOINT ["bun", "/app/dist/payground.js"]
CMD ["start"]
