import type { IncomingMessage } from 'node:http'

/**
 * Tenant authentication for the platform BFF. The shipped implementation maps
 * static bearer tokens to `(department, user, role)` identities
 * (internal-network v1); an OIDC verifier for an upstream IdP implements the
 * same interface when the deployment has one.
 * @module
 */

/** Role: a regular user, or an admin who may read console views. */
export type TenantRole = 'user' | 'admin'

export interface TenantPrincipal {
  /** Department the user belongs to. */
  readonly deptId: string
  /** User within the department. */
  readonly userId: string
  /** Role of this user within their department (or the platform). */
  readonly role: TenantRole
  /**
   * Composite storage and runtime key `${deptId}/${userId}`: the directory
   * under the tenants root and the sandbox identity every subsystem
   * (orchestrator, web runtimes, transcript) keys by.
   */
  readonly tenantId: string
}

export interface Authenticator {
  /** Resolve a bearer token to an identity, or undefined when unauthorized. */
  authenticateToken(token: string): TenantPrincipal | undefined
  /**
   * Users of one department (the console's directory view), or undefined
   * when the deployment's authenticator has no directory.
   */
  listMembers?(deptId: string): { userId: string; role: TenantRole }[]
  /** All departments with their user counts, or undefined without a directory. */
  listDepartments?(): { deptId: string; users: number }[]
}

/** One static-token identity for internal-network deployments. */
export interface DevTokenIdentity {
  readonly deptId: string
  readonly userId: string
  readonly role: TenantRole
}

/**
 * A single safe path segment: it becomes one directory-name component under
 * the tenants root and a read-write bind target inside its sandbox. A leading
 * underscore is reserved for platform-synthesized identities (`_platform`).
 */
export function isSafeTenantSegment(segment: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(segment) && !segment.includes('..')
}

/** Build a principal from identity parts (segments must be safe). */
export function tenantPrincipal(deptId: string, userId: string, role: TenantRole): TenantPrincipal {
  if (!isSafeTenantSegment(deptId) || !isSafeTenantSegment(userId)) {
    throw new Error(`auth: department and user ids must be safe path segments, received ${JSON.stringify(`${deptId}/${userId}`)}`)
  }
  return { deptId, userId, role, tenantId: `${deptId}/${userId}` }
}

/**
 * Split a composite `${deptId}/${userId}` key into its safe segments, or
 * undefined when the key is not exactly such a pair. The inverse of
 * {@link tenantPrincipal}'s `tenantId`.
 */
export function parseTenantKey(tenantId: string): { deptId: string; userId: string } | undefined {
  const parts = tenantId.split('/')
  if (parts.length !== 2) return undefined
  const [deptId, userId] = parts as [string, string]
  if (!isSafeTenantSegment(deptId) || !isSafeTenantSegment(userId)) return undefined
  return { deptId, userId }
}

/** Bearer token of an HTTP request, or undefined. */
export function bearerOf(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  if (header === undefined || !header.startsWith('Bearer ')) return undefined
  const token = header.slice('Bearer '.length).trim()
  return token === '' ? undefined : token
}

/** Static token→identity map for internal-network deployments. */
export function devTokenAuthenticator(tokens: ReadonlyMap<string, DevTokenIdentity>): Authenticator {
  for (const identity of tokens.values()) {
    if (!isSafeTenantSegment(identity.deptId) || !isSafeTenantSegment(identity.userId)) {
      throw new Error(`auth: token map holds an unsafe identity ${JSON.stringify(`${identity.deptId}/${identity.userId}`)}`)
    }
  }
  return {
    authenticateToken(token: string): TenantPrincipal | undefined {
      const identity = tokens.get(token)
      return identity === undefined ? undefined : tenantPrincipal(identity.deptId, identity.userId, identity.role)
    },
    listMembers(deptId: string): { userId: string; role: TenantRole }[] {
      const seen = new Map<string, TenantRole>()
      for (const identity of tokens.values()) {
        if (identity.deptId === deptId && !seen.has(identity.userId)) seen.set(identity.userId, identity.role)
      }
      return [...seen].map(([userId, role]) => ({ userId, role }))
    },
    listDepartments(): { deptId: string; users: number }[] {
      const counts = new Map<string, number>()
      for (const identity of tokens.values()) {
        counts.set(identity.deptId, (counts.get(identity.deptId) ?? 0) + 1)
      }
      return [...counts].map(([deptId, users]) => ({ deptId, users }))
    },
  }
}
