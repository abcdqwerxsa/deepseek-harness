---
description: "Thin BFF for the multi-tenant platform: bearer-token tenant auth, ACP REST passthrough through the orchestrator, WebSocket session-update fan-out with browser-forwarded permission approval, and a SQLite transcript store."
kind: "package-library"
---

# @deepseek-ai/dsh-platform-bff

English | [中文](README.zh.md)

## Summary

Use `@deepseek-ai/dsh-platform-bff` as the serving layer between the tenant portal and the per-tenant ACP runtimes. `startPlatformServer` wires an `Authenticator`, a tenant runtime factory (provisioned home + spawned child, as built by `@deepseek-ai/dsh-tenant-profile` and `@deepseek-ai/dsh-orchestrator`), and a SQLite transcript into one `node:http` + `ws` service. REST calls acquire the tenant's runtime through the orchestrator (queued behind the concurrency cap); session updates fan out to the tenant's WebSockets and append to the transcript, because ACP `session/resume` never replays history. `session/request_permission` prompts are forwarded to the tenant's sockets and fail closed (`cancelled`) when nobody answers within the timeout.

## Use this package

- Import as a library and call `startPlatformServer(options)`; it listens on 127.0.0.1 with an OS-assigned port by default — an internal deployment puts its own TLS gateway in front.
- Auth is the shipped `devTokenAuthenticator` (static token→tenant map) or any `Authenticator` implementation; HTTP uses `Authorization: Bearer`, WebSocket upgrades use `?token=`.
- REST: `GET /api/sessions`, `POST /api/session/new {cwd}`, `POST /api/session/:id/prompt {text}` (blocks until the turn ends), `POST /api/session/:id/close`, `POST /api/session/:id/resume {cwd}`, `GET /api/session/:id/transcript`.
- WebSocket `/ws?token=` receives `{type:'session-update'}` and `{type:'permission-request'}`; send `{type:'permission-response', id, response}` to answer.
- OIDC against an upstream IdP is deliberately not implemented yet: implement `Authenticator` against your IdP's token verification when the deployment has one.

## Understand the implementation

Every spawned runtime is wrapped once by the BFF: its update stream feeds both the transcript table and the tenant's sockets, and its permission answerer routes to the tenant's live sockets with a per-request timeout. The service is intentionally framework-free (`node:http`, `ws`, `node:sqlite`) and single-process; scale-out across hosts is future work behind the same interface.

## Known Limitations and Deferred Work

- Listing sessions spawns the tenant runtime on demand (`session/list` reads the profile persistence root through a live process); a direct persistence reader would avoid the cold start.
- No CORS, rate limiting, or request body size caps yet — the internal gateway in front owns those.
- A spawned-process `request_permission` e2e is still deferred (needs per-call tool arguments in the mock LLM server); BFF forwarding logic is locked by fake-runtime tests.
