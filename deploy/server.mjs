// Platform entrypoint for containerized deployment. Reads the PLATFORM_*
// environment documented in README.md and starts the BFF with the deployment
// runtime factory. Plain ESM against the built package output — no workspace
// resolution needed inside the image.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { composeTenantRuntimeFactory, composeWebRuntimeFactory } from '../packages/platform/bff/lib/index.js'
import { devTokenAuthenticator } from '../packages/platform/bff/lib/index.js'
import { startPlatformServer } from '../packages/platform/bff/lib/index.js'

const dbPath = process.env.PLATFORM_DB ?? '/data/platform.sqlite'
const tenantsRoot = process.env.PLATFORM_TENANTS_ROOT ?? '/data/tenants'
mkdirSync(dirname(dbPath), { recursive: true })
mkdirSync(tenantsRoot, { recursive: true })

/** First-boot secret: persist under the data volume so restarts reuse it. */
function bootstrapSecret(fileName, label) {
  const path = join(dirname(dbPath), fileName)
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (existing !== '') return existing
  } catch { /* first boot */ }
  const value = randomBytes(32).toString('hex')
  writeFileSync(path, `${value}\n`, { mode: 0o600 })
  console.log(`platform: generated ${label} and stored it at ${path}`)
  return value
}

const tokens = JSON.parse(process.env.PLATFORM_TOKENS ?? '[]')
if (!Array.isArray(tokens) || tokens.length === 0) {
  console.error('platform: PLATFORM_TOKENS must be a JSON array of [token, deptId, userId, role] tuples')
  process.exit(2)
}
const ROLES = new Set(['member', 'dept-admin', 'platform-admin'])
// A deptId/userId becomes directory-name components under the tenants root
// and read-write bind targets inside its sandbox: each must stay a single
// safe path segment (a leading underscore is reserved for the platform).
const safeSegment = (value) =>
  typeof value === 'string' && !value.includes('/') && !value.includes('\\') && !value.includes('..') && !value.includes('\u0000') && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(value)
for (const [token, deptId, userId, role] of tokens) {
  if (typeof token !== 'string' || token === '') {
    console.error('platform: PLATFORM_TOKENS entries must start with a non-empty token string')
    process.exit(2)
  }
  if (!safeSegment(deptId) || !safeSegment(userId)) {
    console.error(`platform: dept/user ids must be single safe path segments, received ${JSON.stringify(`${deptId}/${userId}`)}`)
    process.exit(2)
  }
  if (role !== undefined && !ROLES.has(role)) {
    console.error(`platform: unknown role ${JSON.stringify(String(role))} (member | dept-admin | platform-admin)`)
    process.exit(2)
  }
}
const adminTokens = JSON.parse(process.env.PLATFORM_ADMIN_TOKENS ?? '[]')
if (!Array.isArray(adminTokens) || !adminTokens.every(v => typeof v === 'string' && v !== '')) {
  console.error('platform: PLATFORM_ADMIN_TOKENS must be a JSON array of non-empty token strings')
  process.exit(2)
}
let bootstrappedAdminToken = ''
if (adminTokens.length === 0) {
  // First boot without a configured platform admin: mint one, persist it
  // under the data volume, and announce it once in the logs.
  bootstrappedAdminToken = bootstrapSecret('platform-admin-token', 'a platform admin token (PLATFORM_ADMIN_TOKENS)')
  console.log(`platform: bootstrap platform admin token: ${bootstrappedAdminToken}`)
  adminTokens.push(bootstrappedAdminToken)
}
// Platform admins get a synthesized identity in the reserved `_platform`
// department; they hold no sandbox of their own.
const identities = new Map(tokens.map(([token, deptId, userId, role]) =>
  [token, { deptId, userId, role: role ?? 'member' }]))
for (const [index, token] of adminTokens.entries()) {
  if (identities.has(token)) {
    console.error('platform: a token cannot be both a member token and a PLATFORM_ADMIN_TOKENS entry')
    process.exit(2)
  }
  identities.set(token, { deptId: '_platform', userId: `admin-${String(index + 1)}`, role: 'platform-admin' })
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

// User-side original UI: sandboxed `dsh web` per user behind /u/<dept>/<user>/.
// Requires the public authority browsers use (the child's /api fence and
// cookie signatures bind to the preserved Host header).
const webUiEnabled = process.env.PLATFORM_WEB === '1'
const publicAuthority = process.env.PLATFORM_PUBLIC_AUTHORITY ?? ''
if (webUiEnabled && publicAuthority === '') {
  console.error('platform: PLATFORM_WEB=1 requires PLATFORM_PUBLIC_AUTHORITY (the host[:port] browsers use, e.g. deploy.internal:8443)')
  process.exit(2)
}

if (process.env.PLATFORM_MODEL_GATEWAY === '1' && (process.env.DEEPSEEK_API_KEY ?? '') === '') {
  console.error('platform: PLATFORM_MODEL_GATEWAY=1 requires DEEPSEEK_API_KEY (kept server-side only)')
  process.exit(2)
}

const modelGatewaySecret = process.env.PLATFORM_MODEL_GATEWAY === '1'
  ? (process.env.PLATFORM_MODEL_GATEWAY_SECRET && process.env.PLATFORM_MODEL_GATEWAY_SECRET !== '' ? process.env.PLATFORM_MODEL_GATEWAY_SECRET : bootstrapSecret('platform-gateway-secret', 'PLATFORM_MODEL_GATEWAY_SECRET'))
  : ''
const modelGatewayConfig = process.env.PLATFORM_MODEL_GATEWAY === '1'
  ? { endpoint: `http://127.0.0.1:${process.env.PLATFORM_PORT ?? '8080'}/internal/model/v1`, secret: modelGatewaySecret }
  : undefined

const platform = await startPlatformServer({
  authenticator: devTokenAuthenticator(identities),
  tenantsRoot,
  createRuntime: composeTenantRuntimeFactory({
    tenantsRoot,
    dshBin: process.env.PLATFORM_DSH_BIN ?? '/app/apps/cli/lib/bin.js',
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    dshVersion: process.env.PLATFORM_DSH_VERSION ?? 'unpinned',
    ...(modelGatewayConfig === undefined && process.env.DEEPSEEK_BASE_URL !== undefined ? { baseUrl: process.env.DEEPSEEK_BASE_URL } : {}),
    ...(process.env.PLATFORM_SETTINGS_YAML === undefined || process.env.PLATFORM_SETTINGS_YAML === '' ? {} : { settingsYaml: process.env.PLATFORM_SETTINGS_YAML }),
    ...(modelGatewayConfig !== undefined ? { modelGateway: modelGatewayConfig } : {}),
    ...(process.env.PLATFORM_FORCE_REPROVISION === 'true' ? { forceReprovision: true } : {}),
    ...(isolation === undefined ? {} : { isolationCommand: isolation }),
  }),
  dbPath,
  host: process.env.PLATFORM_HOST ?? '0.0.0.0',
  port: Number(process.env.PLATFORM_PORT ?? 8080),
  ...(webUiEnabled ? {
    webRuntimes: {
      factory: composeWebRuntimeFactory({
        tenantsRoot,
        dshBin: process.env.PLATFORM_DSH_BIN ?? '/app/apps/cli/lib/bin.js',
        apiKey: process.env.DEEPSEEK_API_KEY ?? '',
        dshVersion: process.env.PLATFORM_DSH_VERSION ?? 'unpinned',
        ...(modelGatewayConfig === undefined && process.env.DEEPSEEK_BASE_URL !== undefined ? { baseUrl: process.env.DEEPSEEK_BASE_URL } : {}),
        ...(process.env.PLATFORM_SETTINGS_YAML === undefined || process.env.PLATFORM_SETTINGS_YAML === '' ? {} : { settingsYaml: process.env.PLATFORM_SETTINGS_YAML }),
        ...(modelGatewayConfig !== undefined ? { modelGateway: modelGatewayConfig } : {}),
        ...(process.env.PLATFORM_FORCE_REPROVISION === 'true' ? { forceReprovision: true } : {}),
        ...(isolation === undefined ? {} : { isolationCommand: isolation }),
        trustedAuthority: publicAuthority,
      }),
      ...(process.env.PLATFORM_WEB_PORT_MIN === undefined ? {} : { portMin: Number(process.env.PLATFORM_WEB_PORT_MIN) }),
      ...(process.env.PLATFORM_WEB_PORT_MAX === undefined ? {} : { portMax: Number(process.env.PLATFORM_WEB_PORT_MAX) }),
      ...(process.env.PLATFORM_WEB_IDLE_MS === undefined ? {} : { idleTimeoutMs: Number(process.env.PLATFORM_WEB_IDLE_MS) }),
    },
  } : {}),
  ...(modelGatewayConfig !== undefined ? {
    modelGateway: {
      secret: modelGatewaySecret,
      upstreamBaseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
      upstreamApiKey: process.env.DEEPSEEK_API_KEY ?? '',
    },
  } : {}),
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
