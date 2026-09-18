---
description: "Thin BFF for the multi-tenant platform: department/user bearer-token auth with three roles, ACP REST passthrough through the orchestrator, per-user original-UI subpath proxying over on-demand sandboxed dsh web runtimes, a role-aware admin console, and a SQLite transcript store."
kind: "package-library"
---

# @deepseek-ai/dsh-platform-bff

English | [中文](README.zh.md)

## Summary

Use `@deepseek-ai/dsh-platform-bff` as the serving layer between departments' users and their sandboxed runtimes. `startPlatformServer` wires an `Authenticator` (identities are `(deptId, userId, role)` tuples; the composite `deptId/userId` key owns every home, transcript row, and audit line), a tenant runtime factory (provisioned home + spawned child, as built by `@deepseek-ai/dsh-tenant-profile` and `@deepseek-ai/dsh-orchestrator`), an optional per-user web-runtime manager behind `/u/<dept>/<user>/`, and a SQLite transcript into one `node:http` + `ws` service. REST calls acquire the user's runtime through the orchestrator (queued behind the concurrency cap); session updates fan out to the user's WebSockets and append to the transcript, because ACP `session/resume` never replays history. `session/request_permission` prompts are forwarded to the user's sockets and fail closed (`cancelled`) when nobody answers within the timeout.

## Use this package

- Import as a library and call `startPlatformServer(options)`; it listens on 127.0.0.1 with an OS-assigned port by default — an internal deployment puts its own TLS gateway in front.
- Auth is the shipped `devTokenAuthenticator` (static token→`(deptId, userId, role)` map) or any `Authenticator` implementation; HTTP uses `Authorization: Bearer`, WebSocket upgrades use `?token=`. Roles: `member` (own sandbox and original UI only), `dept-admin` (own department's directory, usage, audit), `platform-admin` (instance overview plus any department).
- REST: `GET /api/whoami`, `GET /api/sessions`, `POST /api/session/new {cwd}`, `POST /api/session/:id/prompt {text}` (blocks until the turn ends), `POST /api/session/:id/close`, `POST /api/session/:id/resume {cwd}`, `GET /api/session/:id/transcript`, `GET /api/usage` (update-stream aggregates), `GET /api/audit` (this user's trail); governance: `GET /api/dept/{members,usage,audit}?dept=` (dept-admin: own department, `?dept=` ignored; platform-admin: any safe-segment department) and `GET /api/admin/overview` (platform-admin).
- Original UI: with `webRuntimes` set, `/u/<dept>/<user>/` proxies to that user's on-demand sandboxed `dsh web` (platform session cookie minted once from `?ptoken=`; the child's launch-token cookie dance, `<base href>` rewrite, and WebSocket tunnels are handled by the proxy).
- WebSocket `/ws?token=` receives `{type:'session-update'}` and `{type:'permission-request'}`; send `{type:'permission-response', id, response}` to answer.
- OIDC against an upstream IdP is deliberately not implemented yet: implement `Authenticator` against your IdP's token verification when the deployment has one.

## The build-free admin console

`startPlatformServer` also serves the admin console at `/` and `/portal.js`: a deliberate no-toolchain page (`portal/`) that renders by role after a token connect — members get their original-UI link (`/u/<dept>/<user>/?ptoken=`), dept admins get the department directory, usage report, and audit stream, platform admins get the instance overview (departments, ACP/web runtime watermarks) with per-department drill-down. Host it on the same origin, or behind a gateway that proxies `/api`, `/ws`, and `/u/`; the surfaces it consumes are the stable contract.

Every spawned runtime is wrapped once by the BFF: its update stream feeds both the transcript table and the tenant's sockets, and its permission answerer routes to the tenant's live sockets with a per-request timeout. The service is intentionally framework-free (`node:http`, `ws`, `node:sqlite`) and single-process; scale-out across hosts is future work behind the same interface.

## Deployment (internal single host)

Compose the runtime factory, tokens, and server in one small entry script:

```js
import { composeTenantRuntimeFactory, composeWebRuntimeFactory, devTokenAuthenticator, startPlatformServer } from '@deepseek-ai/dsh-platform-bff'

const identities = new Map(JSON.parse(process.env.PLATFORM_TOKENS ?? '[]').map(
  ([token, deptId, userId, role]) => [token, { deptId, userId, role: role ?? 'member' }],
))
// Required when PLATFORM_WEB=1: fail loudly instead of spawning a child
// whose /api fence trusts the literal "undefined".
const publicAuthority = process.env.PLATFORM_PUBLIC_AUTHORITY
if (process.env.PLATFORM_WEB === '1' && publicAuthority === undefined) {
  throw new Error('PLATFORM_PUBLIC_AUTHORITY is required when PLATFORM_WEB=1')
}
const platform = await startPlatformServer({
  authenticator: devTokenAuthenticator(identities),
  createRuntime: composeTenantRuntimeFactory({
    tenantsRoot: process.env.PLATFORM_TENANTS_ROOT ?? '/srv/platform/tenants',
    dshBin: process.env.PLATFORM_DSH_BIN ?? '/srv/platform/dsh/apps/cli/lib/bin.js',
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    dshVersion: process.env.PLATFORM_DSH_VERSION ?? 'unpinned',
    baseUrl: process.env.DEEPSEEK_BASE_URL,
  }),
  ...(process.env.PLATFORM_WEB === '1' ? {
    webRuntimes: {
      factory: composeWebRuntimeFactory({
        tenantsRoot: process.env.PLATFORM_TENANTS_ROOT ?? '/srv/platform/tenants',
        dshBin: process.env.PLATFORM_DSH_BIN ?? '/srv/platform/dsh/apps/cli/lib/bin.js',
        apiKey: process.env.DEEPSEEK_API_KEY ?? '',
        dshVersion: process.env.PLATFORM_DSH_VERSION ?? 'unpinned',
        baseUrl: process.env.DEEPSEEK_BASE_URL,
        trustedAuthority: publicAuthority,
      }),
    },
  } : {}),
  dbPath: process.env.PLATFORM_DB ?? '/srv/platform/platform.sqlite',
  port: Number(process.env.PLATFORM_PORT ?? 8080),
})
console.log(`platform listening on ${platform.port}`)
```

`PLATFORM_TOKENS` is a JSON array of `[token, deptId, userId, role]` tuples
(each id a single safe path segment; the platform reserves a leading
underscore, e.g. the `_platform` department for synthesized admins). The
server binds 127.0.0.1 by default — put the internal TLS gateway in front.
The audit table lives in the same SQLite file; operational access is direct
SQL. `deploy/server.mjs` is the complete production entrypoint, including
first-boot secret generation.

## Known Limitations and Deferred Work

- No CORS, rate limiting, or request body size caps yet — the internal gateway in front owns those.
- A spawned-process `request_permission` e2e is still deferred (needs per-call tool arguments in the mock LLM server); BFF forwarding logic is locked by fake-runtime tests.
- The console renders usage aggregates and audit lines as plain tables; charts and CSV export are later polish.
- Model-gateway tokens are signed once per spawn with a fixed 24 h TTL; a runtime kept continuously active past it gets 401s from the gateway until idle reaping respawns it.
