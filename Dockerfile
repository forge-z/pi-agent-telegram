FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --chmod=0644 package*.json ./
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY scripts/write-build-info.mjs ./scripts/
# No commit build args: the platform injects the SHA at deploy time and src/app-info.ts
# reads it at runtime (SOURCE_COMMIT / COOLIFY_COMMIT / git).
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production DATA_DIR=/app/data
WORKDIR /app
COPY --chmod=0644 package*.json ./
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/diagnose-tg-runtime.mjs scripts/diagnose-tg-deploy.sh scripts/setup-model.mjs ./scripts/
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node vendor ./vendor
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "dist/src/healthcheck.js"]
CMD ["node", "dist/src/main.js"]
