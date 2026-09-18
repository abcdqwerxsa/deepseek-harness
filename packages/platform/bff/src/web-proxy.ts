import { connect } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import type { Duplex } from 'node:stream'
import { isSafeTenantSegment, type TenantPrincipal } from './auth.ts'

/**
 * Streaming reverse proxy for the user-side original UI: `/u/<dept>/<user>/`
 * requests are forwarded to that user's on-demand `dsh web` child with the
 * prefix stripped and the original Host preserved (the child's browser-trust
 * fence and cookie authority depend on it). Index HTML responses get their
 * `<base href>` rewritten to the subpath so the SPA's relative API and
 * WebSocket URLs resolve through the proxy; everything else — static assets,
 * HTTP APIs, SSE, WebSocket tunnels — streams through untouched.
 * @module
 */

/** Hop-by-hop headers never forwarded on a plain (non-upgrade) request. */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
])

/** Whether `principal` may use the web UI mounted at `deptId/userId`. */
export function mayUseWebUi(principal: TenantPrincipal, deptId: string, userId: string): boolean {
  if (principal.role === 'platform-admin') return true
  return principal.deptId === deptId && principal.userId === userId
}

/**
 * Split a `/u/<dept>/<user>[/<rest...>]` pathname; undefined when the path is
 * not a syntactically valid user mount (both segments must be safe).
 */
export function parseUserMount(pathname: string): { deptId: string; userId: string; rest: string } | undefined {
  const segments = pathname.split('/').filter(segment => segment !== '')
  if (segments[0] !== 'u' || segments.length < 3) return undefined
  const [, deptId, userId, ...rest] = segments as [string, string, string, ...string[]]
  if (!isSafeTenantSegment(deptId) || !isSafeTenantSegment(userId)) return undefined
  return { deptId, userId, rest: rest.join('/') }
}

/** The subpath prefix ending in a slash: `/u/<dept>/<user>/`. */
export function mountPrefix(deptId: string, userId: string): string {
  return `/u/${deptId}/${userId}/`
}

export interface WebMount {
  readonly deptId: string
  readonly userId: string
  readonly rest: string
}

/**
 * Proxy one HTTP request to the user's web runtime (authorization is the
 * caller's job). Holds a manager reference for the request's lifetime.
 */
export async function proxyWebRequest(
  manager: { acquire(key: string): Promise<{ port: number; launchToken: string | undefined }>; release(key: string): void },
  request: IncomingMessage,
  response: ServerResponse,
  mount: WebMount,
  url: URL,
): Promise<void> {
  const key = `${mount.deptId}/${mount.userId}`
  const runtime = await manager.acquire(key)
  try {
    const target = `/${mount.rest}${url.search}`
    const isIndex = request.method === 'GET' && mount.rest === ''
    if (isIndex) {
      await forwardIndex(runtime, request, response, mount, target, url)
      return
    }
    await streamThrough(runtime.port, request, response, target)
  } finally {
    manager.release(key)
  }
}

/**
 * Tunnel one WebSocket upgrade to the user's web runtime: raw socket piping
 * with the request line rebuilt against the stripped path. Holds a manager
 * reference until either side closes.
 */
export function proxyWebUpgrade(
  manager: { acquire(key: string): Promise<{ port: number }>; release(key: string): void },
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  mount: WebMount,
  url: URL,
): void {
  const key = `${mount.deptId}/${mount.userId}`
  const target = `/${mount.rest}${url.search}`
  void manager.acquire(key).then((runtime) => {
    const upstream = connect(runtime.port, '127.0.0.1')
    let settled = false
    const cleanup = (): void => {
      if (settled) return
      settled = true
      upstream.destroy()
      socket.destroy()
      manager.release(key)
    }
    upstream.on('connect', () => {
      const lines = [`${request.method ?? 'GET'} ${target} HTTP/1.1`]
      for (const name of Object.keys(request.headers)) {
        const lower = name.toLowerCase()
        // Connection-culled hop-by-hop headers are re-added verbatim below:
        // the upgrade pair must survive onto the tunnel request.
        if (HOP_BY_HOP.has(lower) && lower !== 'upgrade' && lower !== 'connection') continue
        const value = request.headers[name]
        if (value === undefined) continue
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', cleanup)
    socket.on('error', cleanup)
    upstream.on('close', cleanup)
    socket.on('close', cleanup)
  }, () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    socket.destroy()
  })
}

/**
 * Index requests get a buffered round trip: the HTML shell is small and both
 * the `<base href>` rewrite and the dsh-auth cookie mint need body/header
 * surgery. The mint flow: an unauthenticated index 401s from the child, so
 * the proxy redirects once to `?token=<launch token>`; the child then mints
 * the cookie (rewritten to the subpath path) and clean-redirects back.
 */
async function forwardIndex(
  runtime: { port: number; launchToken: string | undefined },
  request: IncomingMessage,
  response: ServerResponse,
  mount: WebMount,
  target: string,
  url: URL,
): Promise<void> {
  const prefix = mountPrefix(mount.deptId, mount.userId)
  const answer = await collectUpstream(runtime.port, request, target)
  if (answer.status === 401 && !url.searchParams.has('token') && runtime.launchToken !== undefined) {
    response.writeHead(303, { location: `${prefix}?token=${runtime.launchToken}`, 'cache-control': 'no-store' })
    response.end()
    return
  }
  const headers = rewriteIndexHeaders(answer, prefix)
  const body = rewriteBase(answer.body, prefix)
  headers['content-length'] = String(body.byteLength)
  response.writeHead(answer.status, headers)
  response.end(request.method === 'HEAD' ? undefined : body)
}

interface CollectedResponse {
  readonly status: number
  readonly headers: import('node:http').IncomingHttpHeaders
  readonly rawHeaders: string[]
  readonly body: Buffer
}

function collectUpstream(port: number, request: IncomingMessage, target: string): Promise<CollectedResponse> {
  return new Promise<CollectedResponse>((resolve, reject) => {
    const headers = forwardableHeaders(request.headers)
    // A GET/HEAD index carries no body worth forwarding; drop content-length
    // so node does not wait for one. Drop accept-encoding too: the index is
    // rewritten as text, so it must arrive identity-encoded.
    delete headers['content-length']
    delete headers['accept-encoding']
    const upstream = httpRequest({ host: '127.0.0.1', port, method: request.method ?? 'GET', path: target, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 502,
          headers: res.headers,
          rawHeaders: res.rawHeaders,
          body: Buffer.concat(chunks),
        })
      })
      res.on('error', reject)
    })
    upstream.on('error', reject)
    upstream.end()
  })
}

/**
 * Point the SPA's relative URLs (API posts, the remote.mux WebSocket) at the
 * subpath: the served index carries `<base href="/">` (frontend-static
 * injects it); an index without one gets it injected after `<head>`.
 */
export function rewriteBase(body: Buffer, prefix: string): Buffer {
  const html = body.toString('utf8')
  const anchored = html.replace(/<base\s+href="\/">/i, `<base href="${prefix}">`)
  if (anchored !== html) return Buffer.from(anchored)
  const injected = anchored.replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="${prefix}">`)
  return Buffer.from(injected)
}

/** Downstream headers for a buffered index response, locations and cookies scoped. */
function rewriteIndexHeaders(answer: CollectedResponse, prefix: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const name of Object.keys(answer.headers)) {
    const lower = name.toLowerCase()
    if (lower === 'content-length' || lower === 'transfer-encoding' || lower === 'connection') continue
    if (lower === 'location') {
      const raw = answer.headers[name]
      const value = Array.isArray(raw) ? raw[0] : raw
      out[name] = rewriteLocation(value ?? '/', prefix)
      continue
    }
    // Scope the child's session cookie to the subpath so several users can
    // share one browser host without their dsh-auth cookies overwriting
    // each other.
    if (lower === 'set-cookie') {
      out[name] = cookieValues(answer.headers[name], answer.rawHeaders)
        .map(cookie => cookie.replaceAll('Path=/', `Path=${prefix}`))
      continue
    }
    out[name] = answer.headers[name] ?? []
  }
  return out
}

/** Rewrite an absolute-path child redirect into the subpath mount. */
function rewriteLocation(location: string, prefix: string): string {
  return location.startsWith('/') ? `${prefix}${location.slice(1)}` : location
}

/** Raw set-cookie values (node folds them into one comma-joined header). */
function cookieValues(value: string | string[] | undefined, rawHeaders: string[]): string[] {
  if (Array.isArray(value)) return value
  const raw: string[] = []
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === 'set-cookie') raw.push(rawHeaders[index + 1] ?? '')
  }
  if (raw.length > 0) return raw
  return value === undefined ? [] : [value]
}

function forwardableHeaders(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const name of Object.keys(headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    const value = headers[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

/** Byte-for-byte bidirectional streaming for everything that is not the index. */
function streamThrough(port: number, request: IncomingMessage, response: ServerResponse, target: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: request.method ?? 'GET',
        path: target,
        headers: forwardableHeaders(request.headers),
      },
      (res) => {
        response.writeHead(res.statusCode ?? 502, res.headers)
        res.pipe(response)
        res.on('close', () => { resolve() })
        res.on('error', reject)
      },
    )
    upstream.on('error', reject)
    request.pipe(upstream)
    response.on('close', () => { upstream.destroy(); resolve() })
  })
}
