---
description: "Tenant runtime manager for the multi-tenant platform: on-demand ACP child spawn with same-tenant dedup, idle reaping with eager eviction under queue pressure, and a process-wide concurrency cap."
kind: "package-library"
---

# @deepseek-ai/dsh-orchestrator

English | [中文](README.zh.md)

## Summary

Use `@deepseek-ai/dsh-orchestrator` to own the process side of the multi-tenant platform: one spawned `dsh --profile acp` child per user, created on first use, kept while referenced, reaped when idle. `TenantRuntimeManager.withTenant(tenantId, work)` acquires the user's runtime (queued behind `maxConcurrent` live processes), runs `work`, and releases the reference. `spawnAcpStdioRuntime` wires one real child over ndJson stdio into the `TenantRuntime` interface: request passthrough, `session/update` fan-out, and at most one `session/request_permission` answerer with a fail-closed `cancelled` default. For the user-side original UI, `WebRuntimeManager` + `spawnWebRuntime` manage one sandboxed `dsh web` child per user on a port from a fixed pool: readiness is the child's post-Loader `dsh web: <url>` stdout line (routes are mounted before the first forwarded request), the line's launch token is captured for the proxy's cookie mint, spawn failures carry the child's stderr tail, and the child is reaped after an idle window with no open requests or tunnels.

## Use this package

- Import as a library; it cannot be mounted from `cordis.yml`.
- Supply a `createRuntime` factory; the shipped stdio adapter takes a full child spec (`command`, `args`, `cwd`, complete `env`) so model-key injection stays in the composition layer.
- Concurrent `withTenant` calls for one user share a single spawn (per-key in-flight dedup); capacity slots are reserved synchronously so queued wake-ups never overshoot the cap.
- Under queue pressure, idle-but-live processes are evicted eagerly instead of making a waiter sit through the whole idle window; the idle cache only matters when nobody is queued.
- `WebRuntimeManager.acquire/release` hold one reference per in-flight request or open WebSocket tunnel; `webRuntimes` sizing (port pool bounds, idle window) is passed by the platform.
- Real-spawn coverage lives in `tests/orchestrator.e2e.ts` (two tenants, cap queueing, idle reaping); the web manager and its real-child spawn shape are covered by `tests/web-runtime.spec.ts` plus the BFF's real-`dsh web` e2e.

## Understand the implementation

Disposal is stdin-EOF first (dsh's primary quiesce path), escalating to SIGTERM then SIGKILL within the grace budget. Runtime identity outlives process death only through dsh's own session persistence: a reaped tenant respawns on next use and resumes sessions against the same `$DSH_HOME`. The manager is single-process by design; cross-host pooling is out of scope.

## Known Limitations and Deferred Work

- No user-namespace isolation wrapper yet: the child spec accepts any `command`, so a `bwrap`-style wrapper composes without code changes, but nothing here enforces it.
- No crash auto-restart: a runtime that dies while referenced surfaces the failure to `work`; reacquiring after failure spawns fresh.
- Permission forwarding assumes the BFF registers its answerer promptly; an unanswered request fails closed.
