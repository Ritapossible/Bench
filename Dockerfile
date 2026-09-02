# syntax=docker/dockerfile:1

# The worker image.
#
# A Dockerfile rather than Nixpacks because the worker needs a binary Nixpacks'
# Node image does not carry. Auditions fork a chain with anvil, and the audit
# that found this had the deploy reporting `archive ok` and then failing at the
# first fork - hourly, forever - because Foundry was installed in CI and nowhere
# else. The build that runs in production now installs the same tool CI does.
FROM node:22-bookworm-slim AS base

# curl for the Foundry installer; git because foundryup reads it; ca-certificates
# so both can talk TLS. Removed from the layer they are installed in.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# FOUNDRY_DIR puts the binaries in /usr/local/bin, which is already on PATH, so
# nothing downstream depends on a shell profile being sourced. `foundryup`
# resolving from a login shell is exactly the kind of assumption that works in a
# terminal and not in a container's ENTRYPOINT.
ENV FOUNDRY_DIR=/usr/local
# Pinned, not latest. An audition's whole claim is that a window is replayable,
# and the EVM implementation replaying it is part of that: a silently-upgraded
# anvil changes what a fork does between two runs the catalog presents as
# comparable. `anvil --version` runs here so a broken install fails the build
# rather than the first audition, an hour after the deploy reported success.
ARG FOUNDRY_VERSION=v1.5.1
RUN curl -sSL https://foundry.paradigm.xyz | bash \
 && /usr/local/bin/foundryup --install "${FOUNDRY_VERSION}" \
 && anvil --version

WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them. The
# workspace package manifests are all that npm ci needs.
COPY package.json package-lock.json ./
COPY packages/core/package.json        packages/core/
COPY packages/config/package.json      packages/config/
COPY packages/adapters/package.json    packages/adapters/
COPY packages/services/package.json    packages/services/
COPY packages/db/package.json          packages/db/
COPY apps/web/package.json             apps/web/
COPY apps/worker/package.json          apps/worker/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build:worker

ENV NODE_ENV=production
# dns.lookup runs getaddrinfo on the libuv threadpool, four threads by default.
# The prober resolves hundreds of hosts a tick and those four threads were the
# queue that exhausted every probe's timeout.
ENV UV_THREADPOOL_SIZE=32

CMD ["node", "apps/worker/dist/index.js"]
