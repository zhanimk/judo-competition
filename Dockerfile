# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/engine/package.json ./packages/engine/package.json
RUN npm ci

FROM dependencies AS build
COPY . .
ARG API_INTERNAL_URL=http://api:4319
ARG NEXT_PUBLIC_LIVE_URL
ENV API_INTERNAL_URL=$API_INTERNAL_URL NEXT_PUBLIC_LIVE_URL=$NEXT_PUBLIC_LIVE_URL NEXT_TELEMETRY_DISABLED=1
# prisma generate does not connect; no deployment credentials enter image layers.
RUN DATABASE_URL=postgresql://build:build@database.invalid:5432/build npm run db:generate
RUN npm run build

FROM build AS production-dependencies
RUN npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS api
WORKDIR /app
ENV NODE_ENV=production API_HOST=0.0.0.0 PORT=4319 API_REPLICAS=1
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/packages/engine/package.json ./packages/engine/package.json
COPY --from=build --chown=node:node /app/packages/engine/dist ./packages/engine/dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/assets ./apps/api/assets
COPY --from=build --chown=node:node /app/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=node:node /app/scripts ./scripts
USER node
EXPOSE 4319
CMD ["node", "apps/api/dist/main.js"]

FROM node:24-bookworm-slim AS web
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=4318 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
USER node
EXPOSE 4318
CMD ["node", "apps/web/server.js"]

# Matching pg_dump/pg_restore 18 and Node/Prisma for restore verification.
FROM postgres:18.6-bookworm AS operations
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/engine/package.json ./packages/engine/package.json
COPY --from=build /app/packages/engine/dist ./packages/engine/dist
COPY --from=build /app/apps/api/prisma ./apps/api/prisma
COPY --from=build /app/scripts ./scripts
RUN mkdir -p tmp docs/reports /backups && chown -R postgres:postgres tmp docs/reports /backups
USER postgres
ENTRYPOINT ["node"]
CMD ["scripts/production-backup.mjs"]
