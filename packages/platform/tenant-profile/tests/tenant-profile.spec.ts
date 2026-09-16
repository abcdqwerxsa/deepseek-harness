import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { provisionTenantHome, TENANT_MANIFEST_FILENAME, TENANT_PROFILE_PATCH, type TenantManifest } from '../src/index.ts'

// Each case gets its own mkdtemp directory (unique, outside the repo), so no
// state crosses tests and nothing here touches shared host resources.
const cleanup: string[] = []

afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true })
})

function freshRoot(): { root: string; homeDir: string; workspaceDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-tenant-profile-'))
  cleanup.push(root)
  return { root, homeDir: join(root, 'home'), workspaceDir: join(root, 'workspace') }
}

function readManifest(homeDir: string): TenantManifest {
  return JSON.parse(readFileSync(join(homeDir, TENANT_MANIFEST_FILENAME), 'utf8')) as TenantManifest
}

describe('provisionTenantHome', () => {
  it('creates home, workspace, telemetry-off patch, and version-locked manifest', () => {
    const { homeDir, workspaceDir } = freshRoot()
    const result = provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3' })

    expect(result.provisioned).toBe(true)
    expect(existsSync(homeDir)).toBe(true)
    expect(existsSync(workspaceDir)).toBe(true)

    const patch = readFileSync(result.patchPath, 'utf8')
    expect(patch).toBe(TENANT_PROFILE_PATCH)
    expect(patch).toContain('id: session-log-deepseek')
    expect(patch).toContain('id: session-telemetry-otel')

    const manifest = readManifest(homeDir)
    expect(manifest.schema).toBe(1)
    expect(manifest.profileName).toBe('acp')
    expect(manifest.dshVersion).toBe('1.2.3')
    expect(manifest.workspaceDir).toBe(workspaceDir)
    expect(manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('is idempotent: a second identical run rewrites nothing', () => {
    const { homeDir, workspaceDir } = freshRoot()
    provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3' })
    const first = readManifest(homeDir)

    const second = provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3' })

    expect(second.provisioned).toBe(false)
    expect(readManifest(homeDir)).toEqual(first)
  })

  it('rejects a dsh version drift without force and re-locks with force', () => {
    const { homeDir, workspaceDir } = freshRoot()
    provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3' })

    expect(() => provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.3.0' }))
      .toThrow(/dshVersion .*locked/)

    provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.3.0', force: true })
    expect(readManifest(homeDir).dshVersion).toBe('1.3.0')
  })

  it('rejects a foreign patch layer without force and overwrites it with force', () => {
    const { homeDir, workspaceDir } = freshRoot()
    const foreign = join(homeDir, 'profiles', 'acp', 'cordis.patch.yml')
    provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3' })
    writeFileSync(foreign, '- id: something-else\n')

    expect(() => provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3' }))
      .toThrow(/exists with different content/)

    const result = provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3', force: true })
    expect(readFileSync(result.patchPath, 'utf8')).toBe(TENANT_PROFILE_PATCH)
  })

  it('rejects relative homeDir and workspaceDir', () => {
    const { homeDir, workspaceDir } = freshRoot()
    expect(() => provisionTenantHome({ homeDir: 'relative/home', workspaceDir, dshVersion: '1' }))
      .toThrow(/homeDir must be absolute/)
    expect(() => provisionTenantHome({ homeDir, workspaceDir: 'relative/ws', dshVersion: '1' }))
      .toThrow(/workspaceDir must be absolute/)
  })

  it('rejects a corrupt manifest with a clear error and repairs it with force', () => {
    const { homeDir, workspaceDir } = freshRoot()
    provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3' })
    writeFileSync(join(homeDir, TENANT_MANIFEST_FILENAME), '{"schema": 1, "dshVer')

    expect(() => provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3' }))
      .toThrow(/not valid JSON.*pass force to overwrite/s)

    const repaired = provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3', force: true })
    expect(repaired.provisioned).toBe(true)
    expect(readManifest(homeDir).dshVersion).toBe('1.2.3')
  })

  it('rejects a shape-invalid manifest without a bare TypeError and repairs it with force', () => {
    const { homeDir, workspaceDir } = freshRoot()
    provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3' })
    writeFileSync(join(homeDir, TENANT_MANIFEST_FILENAME), JSON.stringify({ schema: 1, workspaceDir: 5 }))

    let failure: unknown
    try {
      provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3' })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/not a tenant manifest object.*pass force to overwrite/s)
    expect((failure as Error).message).not.toMatch(/TypeError|ERR_INVALID/)

    provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3', force: true })
    expect(readManifest(homeDir).workspaceDir).toBe(workspaceDir)
  })

  it('reports an unreadable manifest distinctly from invalid JSON', () => {
    const { homeDir, workspaceDir } = freshRoot()
    provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3' })
    // A directory at the manifest path is a deterministic EISDIR on every
    // platform, unlike a permission-bit trick.
    rmSync(join(homeDir, TENANT_MANIFEST_FILENAME))
    mkdirSync(join(homeDir, TENANT_MANIFEST_FILENAME))

    expect(() => provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1.2.3' }))
      .toThrow(/unreadable \(EISDIR.*pass force to overwrite/s)
  })

  it('rejects invalid profile names', () => {
    const { homeDir, workspaceDir } = freshRoot()
    for (const name of ['', '..', 'a/b', 'node_modules']) {
      expect(() => provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1', profileName: name }))
        .toThrow(/invalid profile name/)
    }
  })

  it('writes the patch into the named profile directory', () => {
    const { homeDir, workspaceDir } = freshRoot()
    const result = provisionTenantHome({ homeDir, workspaceDir, dshVersion: '1', profileName: 'acp-tenant' })
    expect(result.patchPath.endsWith(join('profiles', 'acp-tenant', 'cordis.patch.yml'))).toBe(true)
    expect(readManifest(homeDir).profileName).toBe('acp-tenant')
  })
})
