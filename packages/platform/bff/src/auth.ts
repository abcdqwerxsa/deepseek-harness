import type { IncomingMessage } from 'node:http'

/**
 * Tenant authentication for the platform BFF. The shipped implementation maps
 * static bearer tokens to tenants (internal-network v1); an OIDC verifier for
 * an upstream IdP implements the same interface when the deployment has one.
 * @module
 */

export interface TenantPrincipal {
  readonly tenantId: string
}

export interface Authenticator {
  /** Resolve a bearer token to a tenant, or undefined when unauthorized. */
  authenticateToken(token: string): TenantPrincipal | undefined
}

/** Bearer token of an HTTP request, or undefined. */
export function bearerOf(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization
  if (header === undefined || !header.startsWith('Bearer ')) return undefined
  const token = header.slice('Bearer '.length).trim()
  return token === '' ? undefined : token
}

/** Static token→tenant map for internal-network deployments. */
export function devTokenAuthenticator(tokens: ReadonlyMap<string, string>): Authenticator {
  return {
    authenticateToken(token: string): TenantPrincipal | undefined {
      const tenantId = tokens.get(token)
      return tenantId === undefined ? undefined : { tenantId }
    },
  }
}
