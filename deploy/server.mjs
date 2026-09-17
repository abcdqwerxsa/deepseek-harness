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

const isolation = process.env.PLATFORM_ISOLATION === undefined || process.env.PLATFORM_ISOLATION === ''
  ? undefined
  : JSON.parse(process.env.PLATFORM_ISOLATION)

const dbPath = process.env.PLATFORM_DB ?? '/data/platform.sqlite'
const tenantsRoot = process.env.PLATFORM_TENANTS_ROOT ?? '/data/tenants'
mkdirSync(dirname(dbPath), { recursive: true })
mkdirSync(tenantsRoot, { recursive: true })

const platform = await startPlatformServer({
  authenticator: devTokenAuthenticator(new Map(tokens)),
  createRuntime: composeTenantRuntimeFactory({
    tenantsRoot,
    dshBin: process.env.PLATFORM_DSH_BIN ?? '/app/apps/cli/lib/bin.js',
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    dshVersion: process.env.PLATFORM_DSH_VERSION ?? 'unpinned',
    ...(process.env.DEEPSEEK_BASE_URL === undefined ? {} : { baseUrl: process.env.DEEPSEEK_BASE_URL }),
    ...(process.env.PLATFORM_SETTINGS_YAML === undefined || process.env.PLATFORM_SETTINGS_YAML === '' ? {} : { settingsYaml: process.env.PLATFORM_SETTINGS_YAML }),
    ...(isolation === undefined ? {} : { isolationCommand: isolation }),
  }),
  dbPath,
  host: process.env.PLATFORM_HOST ?? '0.0.0.0',
  port: Number(process.env.PLATFORM_PORT ?? 8080),
  ...(process.env.PLATFORM_MAX_CONCURRENT === undefined ? {} : { maxConcurrent: Number(process.env.PLATFORM_MAX_CONCURRENT) }),
})

console.log(`platform listening on ${platform.port} (portal at /, api at /api/)`)
