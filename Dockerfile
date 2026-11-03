# The rsc-brain image (spec B7 «Modos de instalación»; plan §3.8): the server, its web and its migrations on Node 25,
# run by an unprivileged user. Built from the repository root: docker build -t rsc-brain .
# Two stages install from package-lock.json with npm's cache kept between builds (plan risk 6): one with
# everything to build, one with what runs. Only the built files, the migrations and the running dependencies reach
# the final image; never the tests, the local database, .env or the git history (.dockerignore).

FROM node:25.9.0-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:25.9.0-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src src
COPY web web
RUN npm run build

FROM node:25.9.0-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
ENV NODE_ENV=production \
    RSC_BRAIN_HOST=0.0.0.0 \
    RSC_BRAIN_PORT=8090 \
    RSC_BRAIN_BACKUPS=/backups
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/dist dist
COPY package.json LICENSE ./
COPY migrations migrations
# `rsc-brain <command>` on the PATH; the copies go to /backups (a volume), owned by the user that runs the service.
RUN chmod 0755 dist/cli/main.js \
 && ln -s /app/dist/cli/main.js /usr/local/bin/rsc-brain \
 && mkdir -p /backups && chown node:node /backups
USER node
VOLUME ["/backups"]
EXPOSE 8090
# Healthy when the service answers and its database does (GET /v1/health is 503 otherwise).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${RSC_BRAIN_PORT}/v1/health" || exit 1
CMD ["rsc-brain", "serve"]
