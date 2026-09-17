// Platform entrypoint for containerized deployment. Reads the PLATFORM_*
// environment documented in README.md and starts the BFF with the deployment
// runtime factory. Plain ESM against the built package output — no workspace
// resolution needed inside the image.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { composeTenantRuntimeFactory } from '../packages/platform/bff/lib/index.js'
import { devTokenAuthenticator } from '../packages/platform/bff/lib/index.js'
import { startPlatformServer } from '../packages/platform/bff/lib/index.js'

const tokens = JSON.parse(process.env.PLATFORM_TOKENS ?? '[]')
if (!Array.isArray(tokens) || tokens.length === 0) {
  console.error('platform: PLATFORM_TOKENS must be a JSON array of [token, tenantId] pairs')
  process.exit(2)
}
// A tenantId becomes a directory name under the tenants root and a read-write
// bind target inside its sandbox: it must stay a single safe path segment.
for (const [, tenantId] of tokens) {
  if (typeof tenantId !== 'string' || tenantId.includes('/') || tenantId.includes('\\') || tenantId.includes('..') || tenantId.includes('\u0000') || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tenantId)) {
    console.error('platform: tenant ids must be single safe path segments (letters, digits, dot, dash, underscore)')
    process.exit(2)
  }
}

const isolationRaw = process.env.PLATFORM_ISOLATION
let isolation
if (isolationRaw !== undefined && isolationRaw !== '') {
  try {
    isolation = JSON.parse(isolationRaw)
  } catch {
    isolation = undefined
  }
  if (!Array.isArray(isolation) || isolation.length === 0 || !isolation.every(v => typeof v === 'string')) {
    console.error('platform: PLATFORM_ISOLATION must be a JSON array of strings (e.g. ["bwrap", "--ro-bind", ...])')
    process.exit(2)
  }
}

const dbPath = process.env.PLATFORM_DB ?? '/data/platform.sqlite'
const tenantsRoot = process.env.PLATFORM_TENANTS_ROOT ?? '/data/tenants'
mkdirSync(dirname(dbPath), { recursive: true })
mkdirSync(tenantsRoot, { recursive: true })

if (process.env.PLATFORM_MODEL_GATEWAY === '1' && (process.env.PLATFORM_MODEL_GATEWAY_SECRET ?? '') === '') {
  console.error('platform: PLATFORM_MODEL_GATEWAY=1 requires PLATFORM_MODEL_GATEWAY_SECRET')
  process.exit(2)
}
if (process.env.PLATFORM_MODEL_GATEWAY === '1' && (process.env.DEEPSEEK_API_KEY ?? '') === '') {
  console.error('platform: PLATFORM_MODEL_GATEWAY=1 requires DEEPSEEK_API_KEY (kept server-side only)')
  process.exit(2)
}
const modelGatewayCompose = process.env.PLATFORM_MODEL_GATEWAY === '1'
  ? { endpoint: `http://127.0.0.1:${process.env.PLATFORM_PORT ?? '8080'}/internal/model/v1`, secret: process.env.PLATFORM_MODEL_GATEWAY_SECRET ?? '' }
  : {}

const platform = await startPlatformServer({
  authenticator: devTokenAuthenticator(new Map(tokens)),
  createRuntime: composeTenantRuntimeFactory({
    tenantsRoot,
    dshBin: process.env.PLATFORM_DSH_BIN ?? '/app/apps/cli/lib/bin.js',
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    dshVersion: process.env.PLATFORM_DSH_VERSION ?? 'unpinned',
    ...(process.env.DEEPSEEK_BASE_URL === undefined || modelGatewayCompose.endpoint !== '' ? {} : { baseUrl: process.env.DEEPSEEK_BASE_URL }),
    ...(process.env.PLATFORM_SETTINGS_YAML === undefined || process.env.PLATFORM_SETTINGS_YAML === '' ? {} : { settingsYaml: process.env.PLATFORM_SETTINGS_YAML }),
    ...(modelGatewayCompose.endpoint === '' ? {} : { modelGateway: modelGatewayCompose }),
    ...(process.env.PLATFORM_FORCE_REPROVISION === 'true' ? { forceReprovision: true } : {}),
    ...(isolation === undefined ? {} : { isolationCommand: isolation }),
  }),
  dbPath,
  host: process.env.PLATFORM_HOST ?? '0.0.0.0',
  port: Number(process.env.PLATFORM_PORT ?? 8080),
  ...(() => {
    if (process.env.PLATFORM_MAX_CONCURRENT === undefined) return {}
    const parsed = Number(process.env.PLATFORM_MAX_CONCURRENT)
    if (!Number.isInteger(parsed) || parsed < 1) {
      console.error('platform: PLATFORM_MAX_CONCURRENT must be a positive integer')
      process.exit(2)
    }
    return { maxConcurrent: parsed }
  })(),
})

console.log(`platform listening on ${platform.port} (portal at /, api at /api/)`)
