---
description: "Docker Compose deployment for the tenant platform: one platform container (BFF + orchestrator + built dsh), a TLS gateway, persistent data volume, and an optional bwrap isolation wrapper per tenant child."
kind: "package-deploy"
---

# Tenant Platform Deployment (Docker Compose)

English | [中文](README.zh.md)

## Summary

Two containers on an internal network: `platform` (the BFF, orchestrator, portal, and the built dsh tree in one image — by design, see the architecture notes in `packages/platform/`) and `gateway` (Caddy with an internal-CA TLS certificate). Tenant homes, the SQLite transcript, and the audit table persist in the `platform-data` volume. Each tenant ACP child can run behind a bwrap isolation wrapper (`PLATFORM_ISOLATION`) for a private user/PID namespace with read-only system trees.

## Use this deployment

```sh
cd deploy
cp .env.example .env        # set PLATFORM_TOKENS and DEEPSEEK_API_KEY
docker compose up -d --build
# portal: https://<host>:8443/  (trust Caddy's CA from the caddy-data volume, or bring your own cert)
```

Rotate tokens by editing `.env` and re-running `docker compose up -d`. Upgrade the platform by rebuilding the image — `PLATFORM_DSH_VERSION` re-locks tenant manifests deliberately (re-provisioning rejects version drift without `force`; bump the stamp consciously).

## Understand the pieces

- `Dockerfile` — multi-stage: the builder compiles the workspace (official Node image carries the dev headers; `gcc` covers the native addon), then a slim runtime carries the built tree plus production dependencies and `bwrap`.
- `server.mjs` — the container entrypoint: environment-driven `startPlatformServer` + `composeTenantRuntimeFactory`.
- `docker-compose.yml` — services, the data volume, and the internal network; the gateway owns TLS, and with it rate limiting and body limits.
- `Caddyfile` — TLS termination and reverse proxy (WebSocket upgrades pass through).
- The child environment is a fixed minimal set (`PATH`, `HOME`, `DSH_HOME`, telemetry-off, the model key) — BFF secrets never reach tenant children; the wrapper e2e locks this.

## Known Limitations and Deferred Work

- Single-host by design; scale-out needs tenant-affinity routing first (the `TenantRuntime` seam is ready).
- The example bwrap line maps a private `/tmp` and read-only `/app`/`/usr`; review mounts before enabling extra tools that need wider filesystem access.
- Caddy's internal CA is a convenience for intranets; production PKI should replace it.
