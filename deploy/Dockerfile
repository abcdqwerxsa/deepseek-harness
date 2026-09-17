# Multi-stage image for the tenant platform: build the workspace (Node dev
# headers ship with the official image; `cc` covers the native addon), then
# carry the built tree plus production dependencies into a slim runtime with
# bubblewrap available for per-tenant isolation.
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:24-slim
FROM ${NODE_IMAGE} AS builder
# This deployment targets an internal CN network: the host's 127.0.0.1 proxy
# is unreachable from inside build containers, so builds go direct through
# intranet-reachable mirrors instead.
ENV http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= all_proxy=
ENV npm_config_registry=https://registry.npmmirror.com
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends gcc libc6-dev python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app
# The client build embeds the source commit; build.sh injects it so the
# 200MB+ .git tree stays out of the build context.
ARG DSH_CLIENT_COMMIT_HASH
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}
ENV CI=true
# Heavy layer keyed ONLY to the lockfile: pnpm fetch fills the store without
# any workspace manifests, so source edits never re-download dependencies.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
# Source layer: installs from the fetched store (postinstall scripts are in
# the tree by now) and builds.
COPY . .
RUN pnpm install --frozen-lockfile --offline \
  && pnpm run build

FROM ${NODE_IMAGE}
ENV http_proxy= https_proxy= HTTP_PROXY= HTTPS_PROXY= ALL_PROXY= all_proxy=
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app /app
ENV NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:8080/').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "deploy/server.mjs"]
