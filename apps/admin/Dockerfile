# syntax=docker/dockerfile:1
# rsc-brain admin console (SPEC-18) — Next.js 15 standalone build, non-root runtime.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
# The typed client (lib/api/schema.d.ts) is committed; the build never reaches the API.
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
# Next standalone bundle: server.js + minimal node_modules, plus the static assets.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
USER node
EXPOSE 3000
CMD ["node", "server.js"]
