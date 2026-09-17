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

`deploy/.env` never enters the image (`.dockerignore` excludes `.env` files).
Rotate tokens by editing `.env` and re-running `docker compose up -d`.

Upgrading the platform by bumping `PLATFORM_DSH_VERSION` re-locks tenant
manifests: re-provisioning rejects version drift by default. Either keep the
stamp stable across compatible upgrades, or set `PLATFORM_FORCE_REPROVISION=true`
for one deployment (the alternative is deleting `<tenant>` data volumes).

The example bwrap wrapper isolates the host from tenants, NOT tenants from
each other: it shares all of `/data` with every child at one UID. Cross-tenant
data isolation is not implemented (see SECURITY-NOTES gap 1).

## Understand the pieces

- `Dockerfile` — multi-stage: the builder compiles the workspace (official Node image carries the dev headers; `gcc` covers the native addon), then a slim runtime carries the built tree plus production dependencies and `bwrap`.
- `server.mjs` — the container entrypoint: environment-driven `startPlatformServer` + `composeTenantRuntimeFactory`.
- `docker-compose.yml` — services, the data volume, and the internal network; the gateway owns TLS and the body limit (rate limiting needs a Caddy plugin build).
- `Caddyfile` — TLS termination, reverse proxy (WebSocket upgrades pass through), and the 8 MB request-body cap.
- The child environment is a fixed minimal set (`PATH`, `HOME`, `DSH_HOME`, telemetry-off, the model key) — BFF secrets never reach tenant children; the wrapper e2e locks this.

## Known Limitations and Deferred Work

- Single-host by design; scale-out needs tenant-affinity routing first (the `TenantRuntime` seam is ready).
- The example bwrap line maps a private `/tmp` and read-only `/app`/`/usr`/`/etc`; review mounts before enabling extra tools that need wider filesystem access.
- Caddy's internal CA is a convenience for intranets; production PKI should replace it.
