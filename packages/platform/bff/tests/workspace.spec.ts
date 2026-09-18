import { mkdtempSync, rmSync } from 'node:fs'
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
})
