import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { TenantPrincipal } from './auth.ts'
import { isSafeTenantSegment } from './auth.ts'

/**
 * Workspace file management and security guard for tenant workspaces.
 *
 * Each user owns `<tenantsRoot>/<deptId>/<userId>/workspace`. The workspace
 * is the agent's execution sandbox and task deliverables space. This module
 * provides safe listing, reading, and uploading into that space while
 * strictly barring path traversal across users, departments, or host files.
 * @module
 */

export class PathTraversalError extends Error {
  constructor(path: string) {
    super(`workspace: access denied for unsafe or escaping path: ${JSON.stringify(path)}`)
    this.name = 'PathTraversalError'
  }
}

export interface WorkspaceFileInfo {
  /** Basename of the file or directory. */
  readonly name: string
  /** Path relative to the user's workspace root, using forward slashes. */
  readonly relativePath: string
  /** Size in bytes; 0 for directories. */
  readonly size: number
  /** Modification time (epoch ms). */
  readonly mtimeMs: number
  /** True for directories. */
  readonly isDirectory: boolean
}

/**
 * Derive the absolute workspace root for a validated tenant principal.
 * Ensures the directory exists before returning.
 */
export function getTenantWorkspaceDir(tenantsRoot: string, principal: TenantPrincipal): string {
  if (!isSafeTenantSegment(principal.deptId) || !isSafeTenantSegment(principal.userId)) {
    throw new PathTraversalError(`${principal.deptId}/${principal.userId}`)
  }
  const dir = join(tenantsRoot, principal.deptId, principal.userId, 'workspace')
  mkdirSync(dir, { recursive: true })
  return resolve(dir)
}

export function safeResolveTenantCwd(workspaceDir: string, requestedCwd: string): string {
  if (requestedCwd.includes('\u0000')) {
    throw new PathTraversalError(requestedCwd)
  }
  const normalizedRoot = resolve(workspaceDir)
  let canonicalRoot = normalizedRoot
  try {
    if (existsSync(normalizedRoot)) canonicalRoot = realpathSync(normalizedRoot)
  } catch {
    // Root may not exist yet in tests
  }

  let resolved: string
  if (isAbsolute(requestedCwd)) {
    resolved = resolve(requestedCwd)
  } else {
    resolved = resolve(workspaceDir, requestedCwd)
  }

  // 1. Lexical boundary check
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + sep)) {
    throw new PathTraversalError(requestedCwd)
  }

  // 2. Canonical boundary check
  if (existsSync(resolved)) {
    try {
      const canonical = realpathSync(resolved)
      if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + sep)) {
        throw new PathTraversalError(requestedCwd)
      }
    } catch (err) {
      if (err instanceof PathTraversalError) throw err
    }
  }

  return resolved
}

/**
 * Resolve a user-supplied relative path against the user's workspace root.
 * Throws `PathTraversalError` if the path escapes the workspace root,
 * whether lexically or via symbolic links.
 */
export function safeResolveWorkspacePath(workspaceDir: string, relativePath: string): string {
  if (relativePath.includes('\u0000')) {
    throw new PathTraversalError(relativePath)
  }
  // Strip any leading slashes/backslashes to treat it purely relative
  const sanitized = relativePath.replace(/^[/\\]+/u, '')
  const resolved = resolve(workspaceDir, sanitized)
  const normalizedRoot = resolve(workspaceDir)

  // 1. Lexical boundary check
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + sep)) {
    throw new PathTraversalError(relativePath)
  }

  // 2. Canonical boundary check against symlink escapes
  let canonicalRoot = normalizedRoot
  try {
    if (existsSync(normalizedRoot)) canonicalRoot = realpathSync(normalizedRoot)
  } catch {
    // Root may not exist yet in pure unit tests
  }

  if (existsSync(resolved)) {
    try {
      const canonical = realpathSync(resolved)
      if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + sep)) {
        throw new PathTraversalError(relativePath)
      }
    } catch (err) {
      if (err instanceof PathTraversalError) throw err
    }
  } else {
    // When target does not exist yet (e.g. before write), verify that existing ancestors
    // do not point outside the workspace root via symlink
    let ancestor = resolve(resolved, '..')
    while (!existsSync(ancestor) && ancestor !== normalizedRoot) {
      const parent = resolve(ancestor, '..')
      if (parent === ancestor) break
      ancestor = parent
    }
    if (existsSync(ancestor)) {
      try {
        const canonicalAncestor = realpathSync(ancestor)
        if (canonicalAncestor !== canonicalRoot && !canonicalAncestor.startsWith(canonicalRoot + sep)) {
          throw new PathTraversalError(relativePath)
        }
      } catch (err) {
        if (err instanceof PathTraversalError) throw err
      }
    }
  }

  return resolved
}

/**
 * List files in the tenant workspace.
 * Recursively scans up to maxDepth (default 3) to collect files and directories.
 * Strictly ignores external symlinks and refuses recursing into symlink directories.
 */
export function listWorkspaceFiles(
  workspaceDir: string,
  options?: { readonly maxDepth?: number; readonly maxEntries?: number },
): WorkspaceFileInfo[] {
  const root = resolve(workspaceDir)
  if (!existsSync(root)) return []

  let canonicalRoot = root
  try {
    canonicalRoot = realpathSync(root)
  } catch {
    // Fall back to root
  }

  const maxDepth = options?.maxDepth ?? 3
  const maxEntries = options?.maxEntries ?? 500
  const results: WorkspaceFileInfo[] = []

  function scan(currentDir: string, currentDepth: number): void {
    if (currentDepth > maxDepth || results.length >= maxEntries) return
    let entries: string[] = []
    try {
      entries = readdirSync(currentDir)
    } catch {
      return
    }

    for (const entry of entries) {
      if (results.length >= maxEntries) break
      // Ignore git internals and hidden runtime caches
      if (entry === '.git' || entry === '.dsh' || entry === 'node_modules') continue

      const fullPath = join(currentDir, entry)
      try {
        const lstat = lstatSync(fullPath)
        const isSymlink = lstat.isSymbolicLink()

        if (isSymlink) {
          try {
            const canonicalTarget = realpathSync(fullPath)
            if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(canonicalRoot + sep)) {
              continue // Bar symlinks escaping the workspace
            }
          } catch {
            continue // Skip broken symlinks
          }
        }

        const stat = statSync(fullPath)
        const rel = relative(root, fullPath).split(sep).join('/')
        results.push({
          name: entry,
          relativePath: rel,
          size: stat.isDirectory() ? 0 : stat.size,
          mtimeMs: Math.round(stat.mtimeMs),
          isDirectory: stat.isDirectory(),
        })

        // Defensive: never recurse into symlinked directories to prevent cycles and traversal
        if (stat.isDirectory() && !isSymlink) {
          scan(fullPath, currentDepth + 1)
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  scan(root, 1)
  // Sort: directories first, then by modification time descending
  return results.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return b.mtimeMs - a.mtimeMs
  })
}

/** Simple content-type detection based on extension. */
export function guessContentType(filename: string): string {
  const ext = extname(filename).toLowerCase()
  switch (ext) {
    case '.txt': return 'text/plain; charset=utf-8'
    case '.md': return 'text/markdown; charset=utf-8'
    case '.csv': return 'text/csv; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.html': return 'text/html; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.js': return 'application/javascript; charset=utf-8'
    case '.py': return 'text/x-python; charset=utf-8'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.svg': return 'image/svg+xml'
    case '.pdf': return 'application/pdf'
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    default: return 'application/octet-stream'
  }
}

/** Read a file safely within the tenant workspace. */
export function readWorkspaceFile(
  workspaceDir: string,
  relativePath: string,
): { readonly data: Buffer; readonly contentType: string; readonly size: number; readonly mtimeMs: number } {
  const resolved = safeResolveWorkspacePath(workspaceDir, relativePath)
  const lstat = lstatSync(resolved)
  if (lstat.isSymbolicLink()) {
    const canonicalRoot = realpathSync(resolve(workspaceDir))
    const canonical = realpathSync(resolved)
    if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + sep)) {
      throw new PathTraversalError(relativePath)
    }
  }
  const stat = statSync(resolved)
  if (stat.isDirectory()) {
    throw new Error(`workspace: path is a directory: ${JSON.stringify(relativePath)}`)
  }
  const data = readFileSync(resolved)
  return {
    data,
    contentType: guessContentType(basename(resolved)),
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
  }
}

/** Write an uploaded file safely into the tenant workspace. */
export function writeWorkspaceFile(
  workspaceDir: string,
  relativePath: string,
  content: Buffer | Uint8Array,
): WorkspaceFileInfo {
  const resolved = safeResolveWorkspacePath(workspaceDir, relativePath)
  // Refuse overwriting through an existing symlink
  if (existsSync(resolved) && lstatSync(resolved).isSymbolicLink()) {
    throw new PathTraversalError(relativePath)
  }
  mkdirSync(resolve(resolved, '..'), { recursive: true })
  writeFileSync(resolved, content)
  const stat = statSync(resolved)
  const rel = relative(resolve(workspaceDir), resolved).split(sep).join('/')
  return {
    name: basename(resolved),
    relativePath: rel,
    size: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
    isDirectory: false,
  }
}
