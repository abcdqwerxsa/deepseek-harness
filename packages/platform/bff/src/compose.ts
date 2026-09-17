import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  spawnAcpStdioRuntime,
  spawnWebRuntime,
  type TenantRuntimeFactory,
  type WebRuntime,
  type WebRuntimeFactory,
} from '@deepseek-ai/dsh-orchestrator'
import { signModelToken } from './model-token.ts'
import { provisionTenantHome } from '@deepseek-ai/dsh-tenant-profile'
import { parseTenantKey } from './auth.ts'

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
  /** Root directory; each user gets `<root>/<deptId>/<userId>/{home,workspace}`. */
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
   * The `{tenantDir}` placeholder is replaced per tenant with that user's
   * `<tenantsRoot>/<deptId>/<userId>` directory, so one configured wrapper can
   * bind each child only its own tree (see deploy/.env.example for the converged
   * bwrap line: `--dir` the parents, `--bind {tenantDir} {tenantDir}`, and
   * sibling users and departments stay invisible).
   */
  readonly isolationCommand?: readonly string[]
  /**
   * Re-provision over a version-locked manifest (platform upgrades): the
   * alternative is deleting `<tenantsRoot>/<deptId>/<userId>` and its workspace data.
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
    const sandbox = prepareTenantSandbox(options, tenantId)
    return spawnAcpStdioRuntime(tenantId, {
      command: sandbox.command,
      args: [...sandbox.args, options.dshBin, '--profile', 'acp'],
      cwd: sandbox.cwd,
      env: sandbox.env,
    })
  }
}

export interface ComposeWebRuntimeOptions extends ComposeTenantRuntimeOptions {
  /**
   * Public authority (host[:port]) the browsers use to reach the platform
   * gateway. Passed to `dsh web --trusted-host` so the child's /api fence
   * accepts the preserved Host header of proxied requests.
   */
  readonly trustedAuthority: string
}

/**
 * Deployment glue for the user-side original UI: one `dsh web` child per
 * user, provisioned into the same home/workspace the ACP runtime uses
 * (profile `web` beside `acp`), same minimal environment and model-gateway
 * token injection, and the same optional isolation wrapper.
 */
export function composeWebRuntimeFactory(options: ComposeWebRuntimeOptions): WebRuntimeFactory {
  return async (tenantId, port): Promise<WebRuntime> => {
    const sandbox = prepareTenantSandbox(options, tenantId, 'web')
    return spawnWebRuntime(tenantId, port, {
      command: sandbox.command,
      args: [
        ...sandbox.args,
        options.dshBin,
        'web',
        '--port',
        String(port),
        '--no-open',
        '--trusted-host',
        options.trustedAuthority,
      ],
      cwd: sandbox.cwd,
      env: sandbox.env,
    })
  }
}

/**
 * Provision one user's sandbox and derive the child spawn skeleton: home
 * plus workspace under the tenants root, optional settings.yaml, the
 * isolation wrapper with `{tenantDir}` resolved, and the minimal child
 * environment (model-gateway token instead of the provider key when
 * enabled). Shared by the ACP and web factories.
 */
function prepareTenantSandbox(
  options: ComposeTenantRuntimeOptions,
  tenantId: string,
  profileName: 'acp' | 'web' = 'acp',
): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
  // The composite key becomes two real directory levels; validating the
  // pair here keeps a hostile token map from provisioning outside the root.
  const parsed = parseTenantKey(tenantId)
  if (parsed === undefined) {
    throw new Error(`compose: tenant key must be a "<deptId>/<userId>" pair of safe segments, received ${JSON.stringify(tenantId)}`)
  }
  const { deptId, userId } = parsed
  const { homeDir, workspaceDir } = provisionTenantHome({
    homeDir: join(options.tenantsRoot, deptId, userId, 'home'),
    workspaceDir: join(options.tenantsRoot, deptId, userId, 'workspace'),
    dshVersion: options.dshVersion,
    profileName,
    ...(options.forceReprovision === true ? { force: true } : {}),
  })
  if (options.settingsYaml !== undefined) {
    writeFileSync(join(homeDir, 'settings.yaml'), options.settingsYaml)
  }
  const tenantDir = join(options.tenantsRoot, deptId, userId)
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
    // per-user, day-scoped token for the internal endpoint instead. The
    // payload carries the split identity so metering can attribute calls
    // to `deptId/userId`.
    env.DEEPSEEK_API_KEY = signModelToken(options.modelGateway.secret, deptId, userId)
    env.DEEPSEEK_BASE_URL = options.modelGateway.endpoint
  }
  return {
    command: wrapper[0] ?? process.execPath,
    // An isolation wrapper runs the node interpreter itself: prepend it so
    // the argv stays `<prefix...> node <dshBin> ...`.
    args: [...wrapper.slice(1), ...(wrapper.length > 0 ? [process.execPath] : [])],
    cwd: workspaceDir,
    env,
  }
}
