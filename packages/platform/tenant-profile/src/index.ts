import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

/** Per-profile user patch layer file name inside a Harness home (mirrors dsh app-boot). */
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** Directory under a Harness home that holds profiles (mirrors dsh app-boot). */
const PROFILES_DIR = 'profiles'

/** File name of the platform-owned tenant manifest at the home root. */
export const TENANT_MANIFEST_FILENAME = 'tenant.json'

/**
 * The platform-owned patch layer written into every tenant profile.
 *
 * Both telemetry contributors ship mounted in `dsh-base`: the DeepSeek
 * session-log contributor uploads by default, and the OTel session exporter
 * defaults to `FEEDBACK_ONLY`. Unmounting the rows is stronger than any mode
 * override: no capture code runs, so no session record can leave a tenant
 * runtime regardless of environment variables set by tenant workspace code.
 */
export const TENANT_PROFILE_PATCH = `# Platform-owned tenant patch layer, written at provisioning time.
# Unmounts both telemetry contributors shipped by dsh-base so no session
# record leaves the tenant runtime. The platform overwrites this file only on
# a forced re-provision; dsh itself never touches an existing patch file.
- id: session-log-deepseek
  disabled: true

- id: session-telemetry-otel
  disabled: true
`

/** Recorded at the home root; `dshVersion` drift is rejected without `force`. */
export interface TenantManifest {
  schema: 1
  profileName: string
  dshVersion: string
  workspaceDir: string
  createdAt: string
}

export interface ProvisionTenantHomeOptions {
  /** Absolute path of the tenant Harness home (`$DSH_HOME`). */
  homeDir: string
  /** Absolute path of the tenant workspace root. */
  workspaceDir: string
  /** dsh version the home is locked to. */
  dshVersion: string
  /** Profile the platform drives; defaults to `acp`. */
  profileName?: string
  /** Overwrite a foreign patch layer or a version-locked manifest. */
  force?: boolean
}

export interface ProvisionTenantHomeResult {
  homeDir: string
  workspaceDir: string
  profileDir: string
  patchPath: string
  manifestPath: string
  /** False when identical provisioning already existed and nothing was rewritten. */
  provisioned: boolean
}

function assertProfileName(name: string): void {
  // Mirrors the launcher's own validation in packages/boot/app-boot/src/profile.ts:
  // a profile name must stay a single safe path segment.
  if (
    name === '' || name.includes('/') || name.includes('\\')
    || name === '.' || name === '..' || name === 'node_modules'
  ) {
    throw new Error(`tenant-profile: invalid profile name ${JSON.stringify(name)}`)
  }
}

/**
 * Provision a tenant Harness home for the `acp` profile.
 *
 * Creates the home, workspace, and `profiles/<name>` directories, writes the
 * telemetry-off patch layer, and records the version-locked tenant manifest.
 * dsh's own profile initialization later fills in the profile manifest and
 * pnpm workspace without ever touching the pre-existing patch file.
 */
export function provisionTenantHome(options: ProvisionTenantHomeOptions): ProvisionTenantHomeResult {
  const { workspaceDir, dshVersion, force = false } = options
  const profileName = options.profileName ?? 'acp'
  if (!isAbsolute(options.homeDir)) {
    throw new Error(`tenant-profile: homeDir must be absolute, received ${JSON.stringify(options.homeDir)}`)
  }
  if (!isAbsolute(workspaceDir)) {
    throw new Error(`tenant-profile: workspaceDir must be absolute, received ${JSON.stringify(workspaceDir)}`)
  }
  assertProfileName(profileName)

  const homeDir = resolve(options.homeDir)
  const resolvedWorkspace = resolve(workspaceDir)
  const profileDir = join(homeDir, PROFILES_DIR, profileName)
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME)
  const manifestPath = join(homeDir, TENANT_MANIFEST_FILENAME)

  mkdirSync(homeDir, { recursive: true })
  mkdirSync(resolvedWorkspace, { recursive: true })
  mkdirSync(profileDir, { recursive: true })

  if (existsSync(patchPath)) {
    const existing = readFileSync(patchPath, 'utf8')
    if (existing === TENANT_PROFILE_PATCH) {
      // Identical layer already in place; never rewrite so idempotent runs
      // keep file timestamps stable.
    } else if (!force) {
      throw new Error(`tenant-profile: ${patchPath} exists with different content; pass force to overwrite`)
    } else {
      writeFileSync(patchPath, TENANT_PROFILE_PATCH)
    }
  } else {
    writeFileSync(patchPath, TENANT_PROFILE_PATCH)
  }

  let provisioned = true
  if (existsSync(manifestPath)) {
    let recorded: TenantManifest
    try {
      recorded = JSON.parse(readFileSync(manifestPath, 'utf8')) as TenantManifest
    } catch (error) {
      throw new Error(`tenant-profile: ${manifestPath} is not a readable tenant manifest`, { cause: error })
    }
    const conflicts: string[] = []
    if (recorded.schema !== 1) conflicts.push(`schema ${JSON.stringify(recorded.schema)}`)
    if (recorded.profileName !== profileName) {
      conflicts.push(`profileName ${JSON.stringify(recorded.profileName)}`)
    }
    if (resolve(recorded.workspaceDir) !== resolvedWorkspace) {
      conflicts.push(`workspaceDir ${JSON.stringify(recorded.workspaceDir)}`)
    }
    if (recorded.dshVersion !== dshVersion) {
      conflicts.push(`dshVersion ${JSON.stringify(recorded.dshVersion)} (locked)`)
    }
    if (conflicts.length > 0) {
      if (!force) {
        throw new Error(
          `tenant-profile: ${manifestPath} disagrees with this provisioning (`
          + `${conflicts.join(', ')}); pass force to overwrite`,
        )
      }
      writeFileSync(
        manifestPath,
        manifestJson({ schema: 1, profileName, dshVersion, workspaceDir: resolvedWorkspace, createdAt: new Date().toISOString() }),
      )
    } else {
      provisioned = false
    }
  } else {
    writeFileSync(
      manifestPath,
      manifestJson({ schema: 1, profileName, dshVersion, workspaceDir: resolvedWorkspace, createdAt: new Date().toISOString() }),
    )
  }

  return { homeDir, workspaceDir: resolvedWorkspace, profileDir, patchPath, manifestPath, provisioned }
}

function manifestJson(manifest: TenantManifest): string {
  return `${JSON.stringify(manifest, undefined, 2)}\n`
}
