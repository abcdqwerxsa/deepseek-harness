---
description: "Provision isolated per-tenant Harness homes for the multi-tenant platform: telemetry-off profile patch, workspace root, and a version-locked tenant manifest."
kind: "package-library"
---

# @deepseek-ai/dsh-tenant-profile

English | [中文](README.zh.md)

## Summary

Use `@deepseek-ai/dsh-tenant-profile` to provision the per-tenant Harness homes behind the multi-tenant platform. For each tenant it creates an isolated `$DSH_HOME` and workspace root, writes a platform-owned `cordis.patch.yml` that unmounts both telemetry contributors shipped by `dsh-base` (the DeepSeek session-log contributor and the OTel session exporter), and records a `tenant.json` manifest that locks the home to the dsh version that provisioned it. The platform orchestrator calls this library before spawning `dsh --profile acp` for a tenant.

## Use this package

- Import as a library; it cannot be mounted from `cordis.yml`.
- `provisionTenantHome({ homeDir, workspaceDir, dshVersion })` requires absolute paths and returns the created paths plus a `provisioned` flag.
- Re-running with identical inputs is a no-op (`provisioned: false`); a `dshVersion` drift or a foreign patch layer is rejected unless `force: true` is passed.
- The patch file is written before dsh ever initializes the profile: dsh's own `initProfile` never touches an existing `cordis.patch.yml`, so the platform layer survives first boot.

## Understand the implementation

The patch layer disables rows `session-log-deepseek` and `session-telemetry-otel` instead of overriding their config: unmounted rows run no capture code, so no session record can leave the tenant runtime even if tenant workspace code sets telemetry environment variables. The manifest lock keeps a tenant home pinned to one dsh build; upgrading the platform re-provisions with `force` deliberately.

## Known Limitations and Deferred Work

- No credential seeding: the platform injects model keys through the spawn environment (`launch-env`), never into the home.
- No workspace quotas or cleanup; reaping idle homes is the orchestrator's job.
