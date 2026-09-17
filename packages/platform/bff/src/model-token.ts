import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Model gateway: the platform-held provider key never enters a tenant
 * runtime. Each runtime receives a short-lived HMAC-signed token for the
 * BFF-internal OpenAI-compatible endpoint; the BFF verifies the token,
 * identifies the tenant, forwards to the real provider, and meters usage.
 * @module
 */

export interface ModelTokenPayload {
  /** Tenant identity the runtime speaks for. */
  readonly tenant: string
  /** Optional user within the tenant. */
  readonly user?: string
  /** Expiry, epoch milliseconds. */
  readonly exp: number
}

const TOKEN_PREFIX = 'mt_'
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

function b64url(value: Uint8Array | string): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function b64urlDecode(value: string): Buffer {
  const padded = value.replaceAll('-', '+').replaceAll('/', '_') + '='.repeat((4 - value.length % 4) % 4)
  return Buffer.from(padded, 'base64')
}

function hmac(secret: string, data: string): string {
  return b64url(createHmac('sha256', secret).update(data).digest())
}

/** Mint a model-gateway token for one runtime (valid for a day by default). */
export function signModelToken(secret: string, tenant: string, user?: string, ttlMs: number = TOKEN_TTL_MS): string {
  const payload: ModelTokenPayload = { tenant, ...(user === undefined ? {} : { user }), exp: Date.now() + ttlMs }
  const body = b64url(JSON.stringify(payload))
  return `${TOKEN_PREFIX}${body}.${hmac(secret, body)}`
}

/** Verify a model-gateway token; undefined when malformed, forged, or expired. */
export function verifyModelToken(secret: string, token: string): ModelTokenPayload | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined
  const [body, signature] = token.slice(TOKEN_PREFIX.length).split('.')
  if (body === undefined || signature === undefined) return undefined
  const expected = hmac(secret, body)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return undefined
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as ModelTokenPayload
    if (typeof payload.tenant !== 'string' || typeof payload.exp !== 'number') return undefined
    if (payload.exp < Date.now()) return undefined
    return payload
  } catch {
    return undefined
  }
}
