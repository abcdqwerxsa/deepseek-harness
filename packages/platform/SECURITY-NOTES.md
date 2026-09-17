# Platform Security Notes (internal)

Internal security review record for the multi-tenant platform packages
(`packages/platform/*`). Status: **internal-network v1**; see the gaps list
before any wider deployment.

## Reviewed surface and how

Three adversarial review rounds (read-only reviewer agents, run ids
61c8f9f9 / 79ef4ab4 / 1e901aeb / 84073593 / eff28921 / fdcd9de2 lineage)
plus per-package tests:

| Round | Package | Outcome |
|---|---|---|
| 1 | tenant-profile | P1 (manifest recovery) fixed and re-verified |
| 2 | orchestrator | BLOCK (P0 spawn-failure crash, P1 shutdown orphans / queue starvation / unbounded stdout) — all fixed and re-verified |
| 3 | bff | P1 unauthenticated Host-header crash + P1 websocket frame crash — fixed and re-verified; P2 hardening (400/json, generic 500, permission shape whitelist, pending replay) landed |

Trust-boundary tests lock the regressions: hostile Host header, unmasked
websocket frame, invalid JSON, malformed permission answers, version-drift
manifests, spawn-failure double-acquirer.

## Enforced properties

- Tenant isolation: every API/WS path derives `tenantId` from the server-side
  token map; transcript and audit queries are tenant-scoped SQL parameters.
- Fail-closed permissions: no socket, malformed answer, or answerer throw all
  resolve `cancelled`; the ACP server additionally rejects unknown options.
- Telemetry: both contributors unmounted at the profile layer (patch rows
  disabled), so no session record leaves the tenant runtime by construction.
- Model keys: platform-held, injected at spawn time through the environment,
  never written into the tenant home.

## Known gaps (pre-deployment requirements)

1. **Cross-tenant filesystem isolation converges through the shipped
   example; network and key surfaces stay shared.**
   `composeTenantRuntimeFactory` runs `PLATFORM_ISOLATION` as an argv prefix
   whose `{tenantDir}` placeholder resolves per tenant, and the documented
   bwrap line binds each child only its own tree (`--dir` parent, own bind,
   private user/PID namespace) — siblings and the platform SQLite are
   invisible, and BFF secrets never reach tenants (e2e-locked). Still shared:
   one network namespace for all tenants and the platform-held model key
   injected into each child.
2. **OIDC is an interface, not an implementation.** Dev tokens are static and
   long-lived; rotate them and front the BFF with the internal TLS gateway.
3. No CORS/rate-limit/body-size caps — the gateway in front owns these.
4. `session/list` spawns a runtime on demand (cold-start cost, not a security
   issue); a direct persistence reader would remove it.
5. Spawned-process `request_permission` e2e pending (mock-server per-call
   tool arguments); forwarding logic is otherwise test-locked end to end.
6. Multi-host scale-out is unimplemented (single-process manager by design).

## Deployment

`deploy/` ships the Docker Compose stack (platform container + Caddy TLS
gateway + persistent volume); the image was built and smoke-verified
end to end: portal serves, unauthenticated API returns 401, and a real
ACP session round trip with transcript and usage aggregation completes
inside the container against a host mock provider. `deploy/build.sh`
injects the source commit for the client build environment.

## Operational notes

- Version lock: `tenant.json` pins each home to the provisioning dsh version;
  platform upgrades re-provision with `force` deliberately.
- Audit: `audit` table (SQLite); auth failures under `unknown`.
- Backup the SQLite file; transcript is the only replay source after
  `session/resume` (ACP does not replay history).
