import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnAcpStdioRuntime, type TenantRuntimeFactory } from '@deepseek-ai/dsh-orchestrator'
import { signModelToken } from './model-token.ts'
import { provisionTenantHome } from '@deepseek-ai/dsh-tenant-profile'

/**
 * Deployment glue: compose the tenant runtime factory an internal single-host
 * deployment needs — provisioned home under a tenants root, spawned built
 * `dsh --profile acp` child with a minimal environment (the platform key is
 * injected at spawn time only, never written into the home, and nothing else
 * from the BFF's own environment leaks in), optionally wrapped in an
 * isolation argv prefix such as `bwrap`.
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
  /** Optional settings.yaml content written into each home (tests point the adapter at a mock). */
  readonly settingsYaml?: string
  /**
   * Optional argv prefix wrapping each tenant child (`bwrap`, a container
   * runtime, ...): the child runs as `<prefix...> node <dshBin> --profile acp`.
   * The `{tenantDir}` placeholder is replaced per tenant with that tenant's
   * `<tenantsRoot>/<tenantId>` directory, so one configured wrapper can bind
   * each child only its own tree (see deploy/.env.example for the converged
   * bwrap line: `--dir` the parent, `--bind {tenantDir} {tenantDir}`, and
   * sibling tenants stay invisible).
   */
  readonly isolationCommand?: readonly string[]
  /**
   * Re-provision over a version-locked manifest (platform upgrades): the
   * alternative is deleting `<tenantsRoot>/<tenantId>` and its workspace data.
   */
  readonly forceReprovision?: boolean
  /**
   * Model gateway: children call this BFF-internal OpenAI-compatible endpoint
   * with a per-tenant signed token instead of the provider key. Requires a
   * fixed platform port (the endpoint URL is baked into child env) and a
   * chat-completions settingsYaml.
   */
  readonly modelGateway?: {
    /** Internal endpoint base, e.g. http://127.0.0.1:8080/internal/model/v1 */
    readonly endpoint: string
    /** Shared secret; the BFF verifies tokens signed with it. */
    readonly secret: string
  }
}

export function composeTenantRuntimeFactory(options: ComposeTenantRuntimeOptions): TenantRuntimeFactory {
  return async (tenantId) => {
    const { homeDir, workspaceDir } = provisionTenantHome({
      homeDir: join(options.tenantsRoot, tenantId, 'home'),
      workspaceDir: join(options.tenantsRoot, tenantId, 'workspace'),
      dshVersion: options.dshVersion,
      ...(options.forceReprovision === true ? { force: true } : {}),
    })
    if (options.settingsYaml !== undefined) {
      writeFileSync(join(homeDir, 'settings.yaml'), options.settingsYaml)
    }
    const tenantDir = join(options.tenantsRoot, tenantId)
    const wrapper = (options.isolationCommand ?? []).map(part => part.replaceAll('{tenantDir}', tenantDir))
    // Deliberately minimal child environment: the tenant child never sees the
    // BFF's own variables (tokens, future secrets) — only what dsh needs.
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: homeDir,
      DSH_HOME: homeDir,
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: options.apiKey,
    }
    if (process.env.LANG !== undefined) env.LANG = process.env.LANG
    if (options.baseUrl !== undefined) env.DEEPSEEK_BASE_URL = options.baseUrl
    if (options.modelGateway !== undefined) {
      // The provider key never reaches the sandbox: children hold a
      // per-tenant, day-scoped token for the internal endpoint instead.
      env.DEEPSEEK_API_KEY = signModelToken(options.modelGateway.secret, tenantId)
      env.DEEPSEEK_BASE_URL = options.modelGateway.endpoint
    }
    return spawnAcpStdioRuntime(tenantId, {
      command: wrapper[0] ?? process.execPath,
      args: [
        ...wrapper.slice(1),
        ...(wrapper.length > 0 ? [process.execPath] : []),
        options.dshBin,
        '--profile',
        'acp',
      ],
      cwd: workspaceDir,
      env,
    })
  }
}
