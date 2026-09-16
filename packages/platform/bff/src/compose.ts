import { join } from 'node:path'
import { spawnAcpStdioRuntime, type TenantRuntimeFactory } from '@deepseek-ai/dsh-orchestrator'
import { provisionTenantHome } from '@deepseek-ai/dsh-tenant-profile'

/**
 * Deployment glue: compose the tenant runtime factory an internal single-host
 * deployment needs — provisioned home under a tenants root, spawned built
 * `dsh --profile acp` child, platform-held model key injected at spawn time
 * only (never written into the home).
 * @module
 */

export interface ComposeTenantRuntimeOptions {
  /** Root directory; each tenant gets `<root>/<tenantId>/{home,workspace}`. */
  readonly tenantsRoot: string
  /** Absolute path to the built dsh CLI entry (`apps/cli/lib/bin.js`). */
  readonly dshBin: string
  /** Platform-held model key, injected through the spawn environment. */
  readonly apiKey: string
  /** Optional provider base URL override (tests point at a mock). */
  readonly baseUrl?: string
  /** Version-lock stamp recorded in each tenant manifest. */
  readonly dshVersion: string
}

export function composeTenantRuntimeFactory(options: ComposeTenantRuntimeOptions): TenantRuntimeFactory {
  return async (tenantId) => {
    const { homeDir, workspaceDir } = provisionTenantHome({
      homeDir: join(options.tenantsRoot, tenantId, 'home'),
      workspaceDir: join(options.tenantsRoot, tenantId, 'workspace'),
      dshVersion: options.dshVersion,
    })
    return spawnAcpStdioRuntime(tenantId, {
      command: process.execPath,
      args: [options.dshBin, '--profile', 'acp'],
      cwd: workspaceDir,
      env: {
        ...process.env,
        DSH_HOME: homeDir,
        DSH_TELEMETRY_DISABLED: '1',
        DEEPSEEK_API_KEY: options.apiKey,
        ...(options.baseUrl === undefined ? {} : { DEEPSEEK_BASE_URL: options.baseUrl }),
      },
    })
  }
}
