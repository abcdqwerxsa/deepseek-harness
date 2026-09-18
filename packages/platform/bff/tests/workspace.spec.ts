import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tenantPrincipal } from '../src/auth.ts'
import {
  getTenantWorkspaceDir,
  listWorkspaceFiles,
  PathTraversalError,
  readWorkspaceFile,
  safeResolveWorkspacePath,
  safeResolveTenantCwd,
  writeWorkspaceFile,
} from '../src/workspace.ts'

describe('tenant workspace file safety', () => {
  let tempRoot: string

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'dsh-workspace-test-'))
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('provisions and resolves workspace root cleanly', () => {
    const principal = tenantPrincipal('finance', 'alice', 'member')
    const wsDir = getTenantWorkspaceDir(tempRoot, principal)
    expect(wsDir).toBe(join(tempRoot, 'finance', 'alice', 'workspace'))
  })

  it('rejects illegal path segments in principal', () => {
    expect(() => getTenantWorkspaceDir(tempRoot, { deptId: '..', userId: 'alice', role: 'member', tenantId: '../alice' }))
      .toThrow(PathTraversalError)
  })

  it('safely resolves child paths within workspace', () => {
    const wsDir = join(tempRoot, 'ws')
    expect(safeResolveWorkspacePath(wsDir, 'report.md')).toBe(join(wsDir, 'report.md'))
    expect(safeResolveWorkspacePath(wsDir, 'sub/data.csv')).toBe(join(wsDir, 'sub', 'data.csv'))
    expect(safeResolveWorkspacePath(wsDir, './file.txt')).toBe(join(wsDir, 'file.txt'))
  })

  it('strictly rejects path traversal attacks', () => {
    const wsDir = join(tempRoot, 'ws')
    expect(() => safeResolveWorkspacePath(wsDir, '../secret.txt')).toThrow(PathTraversalError)
    expect(() => safeResolveWorkspacePath(wsDir, '../../etc/passwd')).toThrow(PathTraversalError)
    expect(() => safeResolveWorkspacePath(wsDir, 'sub/../../outside')).toThrow(PathTraversalError)
    expect(() => safeResolveWorkspacePath(wsDir, 'foo\u0000bar')).toThrow(PathTraversalError)
  })

  it('writes, reads, and lists files correctly', () => {
    const wsDir = join(tempRoot, 'ws')
    writeWorkspaceFile(wsDir, 'hello.txt', Buffer.from('hello world', 'utf8'))
    writeWorkspaceFile(wsDir, 'data/report.csv', Buffer.from('id,val\n1,100', 'utf8'))

    const read = readWorkspaceFile(wsDir, 'hello.txt')
    expect(read.data.toString('utf8')).toBe('hello world')
    expect(read.contentType).toBe('text/plain; charset=utf-8')

    const files = listWorkspaceFiles(wsDir)
    const relPaths = files.map(f => f.relativePath)
    expect(relPaths).toContain('hello.txt')
    expect(relPaths).toContain('data')
    expect(relPaths).toContain('data/report.csv')
  })

  it('strictly bars symlink traversal and symlink overwriting', async () => {
    const { symlinkSync, writeFileSync, mkdirSync } = await import('node:fs')
    const wsDir = join(tempRoot, 'ws')
    const outsideDir = join(tempRoot, 'outside')
    mkdirSync(wsDir, { recursive: true })
    mkdirSync(outsideDir, { recursive: true })

    // Outside secret file
    writeFileSync(join(outsideDir, 'secret.env'), 'SUPER_SECRET=123', 'utf8')

    // Create a symlink inside ws pointing outside
    symlinkSync(join(outsideDir, 'secret.env'), join(wsDir, 'stolen.txt'))

    // 1. Reading through symlink must throw PathTraversalError
    expect(() => readWorkspaceFile(wsDir, 'stolen.txt')).toThrow(PathTraversalError)

    // 2. Writing to an existing symlink must throw PathTraversalError (never overwrite outside target)
    expect(() => writeWorkspaceFile(wsDir, 'stolen.txt', Buffer.from('pwned', 'utf8'))).toThrow(PathTraversalError)
    // Verify outside file was NOT overwritten
    const { readFileSync } = await import('node:fs')
    expect(readFileSync(join(outsideDir, 'secret.env'), 'utf8')).toBe('SUPER_SECRET=123')

    // 3. Symlink directory pointing outside: listing must not include outside files
    writeFileSync(join(outsideDir, 'external_doc.md'), '# external doc', 'utf8')
    symlinkSync(outsideDir, join(wsDir, 'symlink_folder'))

    const files = listWorkspaceFiles(wsDir)
    const names = files.map(f => f.name)
    expect(names).not.toContain('external_doc.md')

    // 4. Directory symlink loop: listing must not infinite loop
    symlinkSync(wsDir, join(wsDir, 'loop_link'))
    const filesWithLoop = listWorkspaceFiles(wsDir)
    expect(Array.isArray(filesWithLoop)).toBe(true)

    // 5. Dangling symlink pointing outside: read and write must be blocked, never create outside target
    const targetOutsideNonExistent = join(outsideDir, 'outside_target.txt')
    symlinkSync(targetOutsideNonExistent, join(wsDir, 'dangling.txt'))

    expect(() => readWorkspaceFile(wsDir, 'dangling.txt')).toThrow(PathTraversalError)
    expect(() => writeWorkspaceFile(wsDir, 'dangling.txt', Buffer.from('escape', 'utf8'))).toThrow(PathTraversalError)
    const { existsSync: checkExists } = await import('node:fs')
    expect(checkExists(targetOutsideNonExistent)).toBe(false)
  })

  it('safely resolves and restricts session cwd', () => {
    const wsDir = join(tempRoot, 'ws')
    const subDir = join(wsDir, 'nested')
    mkdirSync(subDir, { recursive: true })

    // 1. Relative subfolder resolves correctly
    expect(safeResolveTenantCwd(wsDir, 'nested')).toBe(subDir)

    // 2. Absolute path inside workspace resolves correctly
    expect(safeResolveTenantCwd(wsDir, subDir)).toBe(subDir)

    // 3. Absolute path outside workspace is barred
    expect(() => safeResolveTenantCwd(wsDir, '/etc')).toThrow(PathTraversalError)
    expect(() => safeResolveTenantCwd(wsDir, tempRoot)).toThrow(PathTraversalError)

    // 4. Relative traversal escaping workspace is barred
    expect(() => safeResolveTenantCwd(wsDir, '../../etc')).toThrow(PathTraversalError)

    // 5. Null byte is barred
    expect(() => safeResolveTenantCwd(wsDir, 'nested\u0000')).toThrow(PathTraversalError)

    // 6. Dangling symlink cwd is barred
    const danglingCwd = join(wsDir, 'dangling_sub')
    symlinkSync('/tmp/nonexistent_escape_dir', danglingCwd)
    expect(() => safeResolveTenantCwd(wsDir, 'dangling_sub')).toThrow(PathTraversalError)
  })
})
