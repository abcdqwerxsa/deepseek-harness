---
description: "Docker Compose deployment for the multi-tenant platform: one platform container (BFF + orchestrator + built dsh), a TLS gateway, persistent data volume, and an optional bwrap isolation wrapper per tenant child."
kind: "package-deploy"
---

# Tenant Platform Deployment (Docker Compose)

English | [中文](README.zh.md)

## Summary

Two containers on an internal network: `platform` (the BFF, orchestrator, admin console, and the built dsh tree in one image — by design, see the architecture notes in `packages/platform/`) and `gateway` (Caddy with an internal-CA TLS certificate). The organization is departments of users (`PLATFORM_TOKENS` maps tokens to `[deptId, userId, role]`); each user's home, workspace, SQLite transcript rows, and audit entries persist under the `platform-data` volume at `/data/tenants/<deptId>/<userId>`. Each user-side ACP runtime can run behind a bwrap isolation wrapper (`PLATFORM_ISOLATION`) for a private user/PID namespace with read-only system trees.

## Use this deployment

```sh
cd deploy
cp .env.example .env        # set PLATFORM_TOKENS and DEEPSEEK_API_KEY
docker compose up -d --build
# console: https://<host>:8443/  (trust Caddy's CA from the caddy-data volume, or bring your own cert)
```

`deploy/.env` never enters the image (`.dockerignore` excludes `.env` files).
Rotate tokens by editing `.env` and re-running `docker compose up -d`.

First-boot secrets are generated when left unset and persisted under the
data volume: `PLATFORM_MODEL_GATEWAY_SECRET` (at `/data/platform-gateway-secret`)
and the initial platform admin token (at `/data/platform-admin-token`, also
printed once in the container logs — sign in to the console with it, then
declare real tokens in `.env`).

Upgrading the platform by bumping `PLATFORM_DSH_VERSION` re-locks tenant
manifests: re-provisioning rejects version drift by default. Either keep the
stamp stable across compatible upgrades, or set `PLATFORM_FORCE_REPROVISION=true`
for one deployment (the alternative is deleting a `<deptId>/<userId>` data tree).

The example bwrap wrapper converges cross-user isolation: the
`{tenantDir}` placeholder resolves per user, `--dir` creates the parents
inside the sandbox, and each child binds ONLY its own tree — sibling users,
other departments, and the platform SQLite are invisible. Remaining shared
surfaces: one network namespace and the platform-held model key (see
SECURITY-NOTES gap 1).

## Understand the pieces

- `Dockerfile` — multi-stage: the builder compiles the workspace (official Node image carries the dev headers; `gcc` covers the native addon), then a slim runtime carries the built tree plus production dependencies and `bwrap`.
- `server.mjs` — the container entrypoint: environment-driven `startPlatformServer` + `composeTenantRuntimeFactory` and first-boot secret generation.
- `docker-compose.yml` — services, the data volume, and the internal network; the gateway owns TLS and the body limit (rate limiting needs a Caddy plugin build).
- `Caddyfile` — TLS termination, reverse proxy (WebSocket upgrades pass through), and the 8 MB request-body cap.
- The child environment is a fixed minimal set (`PATH`, `HOME`, `DSH_HOME`, telemetry-off, the model key) — BFF secrets never reach tenant children; the wrapper e2e locks this.

## Known Limitations and Deferred Work

- Single-host by design; scale-out needs tenant-affinity routing first (the `TenantRuntime` seam is ready).
- The example bwrap line maps a private `/tmp`, read-only `/app`/`/usr`/`/etc`, and a per-tenant bind via the `{tenantDir}` placeholder; review mounts before enabling extra tools that need wider filesystem access.
- Inside the sandbox `/proc` is absent: `ps`/`top`/`free` and process substitution `<(cmd)` do not work, and tenant tool confinement relies on the Landlock launcher (kernel ≥ 5.13; without Landlock, tenant tools fail closed). Drop the two `security_opt` lines when not enabling `PLATFORM_ISOLATION` to keep Docker's default seccomp filtering for the BFF itself.
- Caddy's internal CA is a convenience for intranets; production PKI should replace it.
