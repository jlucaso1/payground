# syntax=docker/dockerfile:1

# --- build: bundle the CLI and the dashboard assets -------------------------
FROM oven/bun:1.4 AS build
WORKDIR /app

# Workspace manifests first, so the dependency layer is cached across source edits.
# bunfig.toml belongs here too: it sets `peer = false`, without which bun-plugin-tailwind
# drags in a 150 MB copy of the Bun runtime as a peer dependency.
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
# packages/server/src/parity reaches out to spec/ for the OpenAPI document and the overlay.
COPY spec ./spec
COPY packages ./packages
RUN bun run build

# --- runtime ----------------------------------------------------------------
FROM oven/bun:1.4-slim AS runtime
WORKDIR /app

# oven/bun already carries image.revision and image.version describing Bun itself. Once
# image.source points at this repo those inherited values name a commit that does not
# exist here, so they are overridden: a release build passes the real ones, and anything
# else gets an empty label rather than a wrong one.
ARG VERSION=""
ARG REVISION=""
LABEL org.opencontainers.image.title="payground" \
      org.opencontainers.image.description="A stateful, self-hosted sandbox that speaks the Mercado Pago API" \
      org.opencontainers.image.source="https://github.com/jlucaso1/payground" \
      org.opencontainers.image.url="https://github.com/jlucaso1/payground" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production \
    PAYGROUND_HOST=0.0.0.0 \
    PAYGROUND_PORT=8080 \
    PAYGROUND_DB=/data/payground.sqlite

COPY --from=build /app/packages/cli/dist ./dist
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
