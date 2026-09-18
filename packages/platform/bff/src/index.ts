import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  TenantRuntimeManager,
  type TenantRuntime,
  type TenantRuntimeFactory,
  type TenantRuntimeManagerOptions,
} from '@deepseek-ai/dsh-orchestrator'
import { bearerOf, isSafeTenantSegment, type Authenticator, type TenantPrincipal } from './auth.ts'
import { verifyModelToken } from './model-token.ts'

export { bearerOf, devTokenAuthenticator, type Authenticator, type TenantPrincipal } from './auth.ts'
import { TranscriptStore } from './transcript.ts'

export { composeTenantRuntimeFactory, composeWebRuntimeFactory, type ComposeTenantRuntimeOptions, type ComposeWebRuntimeOptions } from './compose.ts'
import { mayUseWebUi, mountPrefix, parseUserMount, proxyWebUpgrade, proxyWebRequest } from './web-proxy.ts'
import { WebRuntimeManager, type WebManagerStats, type WebRuntimeFactory } from '@deepseek-ai/dsh-orchestrator'

/**
 * Thin BFF for the multi-tenant platform: bearer-token tenant auth, ACP REST
 * passthrough through the orchestrator, WebSocket fan-out of session updates,
 * browser-forwarded permission approval, and a SQLite transcript. Boring
 * `node:http` + `ws` on purpose — no framework, no new dependencies.
 * @module @deepseek-ai/dsh-platform-bff
 */

export interface PlatformServerOptions {
  /** Tenant authentication; bearer tokens on HTTP, token query param on WS. */
  readonly authenticator: Authenticator
  /** Runtime factory (provision home + spawn child + key env), as for the orchestrator. */
  readonly createRuntime: TenantRuntimeFactory
  /** SQLite file for the transcript; defaults to `:memory:`. */
  readonly dbPath?: string
  /** Listen host. Default 127.0.0.1 — an internal deployment puts its own gateway in front. */
  readonly host?: string
  /** Listen port; 0 (default) requests an OS-assigned port. */
  readonly port?: number
  /** How long a forwarded permission request waits for a browser answer. Default 5 min. */
  readonly permissionTimeoutMs?: number
  /** Orchestrator sizing passed through. */
  readonly maxConcurrent?: number
  readonly idleTimeoutMs?: number
  /**
   * Model gateway: the platform-held provider key stays in this process and
   * tenant runtimes receive a signed token for the internal endpoint instead.
   * Enabled runtimes get DEEPSEEK_API_KEY/DEEPSEEK_BASE_URL overridden
   * automatically (chat-completions protocol required in settingsYaml).
   */
  readonly modelGateway?: {
    readonly secret: string
    readonly upstreamBaseUrl: string
    readonly upstreamApiKey: string
  }
  /**
   * User-side original UI: when set, `/u/<dept>/<user>/` mounts an on-demand
   * sandboxed `dsh web` per user behind the platform session.
   */
  readonly webRuntimes?: {
    readonly factory: WebRuntimeFactory
    readonly portMin?: number
    readonly portMax?: number
    readonly idleTimeoutMs?: number
  }
}

export interface PlatformServer {
  readonly port: number
  readonly server: Server
  /** Live runtime for the tenant, or undefined (tests and diagnostics). */
  peekRuntime(tenantId: string): TenantRuntime | undefined
  /** Live web runtimes overview (console health view). */
  webStats(): WebManagerStats
  close(): Promise<void>
}

interface TenantSockets {
  readonly sockets: Set<WebSocket>
  readonly pending: Map<string, { request: unknown; resolve: (response: unknown) => void; timer: NodeJS.Timeout }>
}

/** The build-free tenant portal served at `/` (and its script). */
const PORTAL_FILES: ReadonlyMap<string, readonly [contentType: string, body: string]> = new Map([
  ['/', ['text/html; charset=utf-8', readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'portal', 'index.html'), 'utf8')]],
  ['/portal.js', ['text/javascript; charset=utf-8', readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'portal', 'portal.js'), 'utf8')]],
])

export async function startPlatformServer(options: PlatformServerOptions): Promise<PlatformServer> {
  const permissionTimeoutMs = options.permissionTimeoutMs ?? 5 * 60_000
  const transcript = new TranscriptStore(options.dbPath ?? ':memory:')
  const tenants = new Map<string, TenantSockets>()

  const socketsOf = (tenantId: string): TenantSockets => {
    let entry = tenants.get(tenantId)
    if (entry === undefined) {
      entry = { sockets: new Set(), pending: new Map() }
      tenants.set(tenantId, entry)
    }
    return entry
  }

  const broadcast = (tenantId: string, message: unknown): void => {
    const entry = tenants.get(tenantId)
    if (entry === undefined) return
    const text = JSON.stringify(message)
    for (const socket of entry.sockets) socket.send(text)
  }

  const forwardPermission = (tenantId: string, request: unknown): Promise<unknown> => {
    const entry = socketsOf(tenantId)
    if (entry.sockets.size === 0) {
      // Fail-closed: nobody is watching this tenant, so nothing is approved.
      return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    }
    return new Promise<unknown>((resolve) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        entry.pending.delete(id)
        resolve({ outcome: { outcome: 'cancelled' } })
      }, permissionTimeoutMs)
      timer.unref()
      entry.pending.set(id, {
        request,
        resolve: (response) => {
          clearTimeout(timer)
          entry.pending.delete(id)
          resolve(response)
        },
        timer,
      })
      transcript.audit(tenantId, 'permission-request', id)
      broadcast(tenantId, { type: 'permission-request', id, request })
    })
  }

  const createRuntime: TenantRuntimeFactory = async (tenantId) => {
    const runtime = await options.createRuntime(tenantId)
    runtime.onUpdate((sessionId, update) => {
      transcript.append(tenantId, sessionId, update)
      broadcast(tenantId, { type: 'session-update', sessionId, update })
    })
    runtime.onPermission(request => forwardPermission(tenantId, request))
    return runtime
  }

  const managerOptions: TenantRuntimeManagerOptions = { createRuntime }
  if (options.maxConcurrent !== undefined) managerOptions.maxConcurrent = options.maxConcurrent
  if (options.idleTimeoutMs !== undefined) managerOptions.idleTimeoutMs = options.idleTimeoutMs
  const manager = new TenantRuntimeManager(managerOptions)
  const webManager = options.webRuntimes === undefined
    ? undefined
    : new WebRuntimeManager({
      createRuntime: options.webRuntimes.factory,
      ...(options.webRuntimes.portMin === undefined ? {} : { portMin: options.webRuntimes.portMin }),
      ...(options.webRuntimes.portMax === undefined ? {} : { portMax: options.webRuntimes.portMax }),
      ...(options.webRuntimes.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.webRuntimes.idleTimeoutMs }),
    })

  const json = (response: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    response.end(payload)
  }

  const dispatch = async (
    request: IncomingMessage,
    response: ServerResponse,
    principal: TenantPrincipal,
    pathname: string,
  ): Promise<void> => {
    const method = request.method
    const segments = pathname.split('/').filter(segment => segment !== '')
    if (segments[0] !== 'api') {
      json(response, 404, { error: 'not found' })
      return
    }
    const tenantId = principal.tenantId
    if (method === 'GET' && segments.length === 2 && segments[1] === 'whoami') {
      json(response, 200, { deptId: principal.deptId, userId: principal.userId, role: principal.role, tenantId })
      return
    }
    // Department-scoped console views: dept admins see their own department,
    // platform admins any department through ?dept=.
    if (segments[1] === 'dept') {
      const deptId = deptScopeOf(request, principal)
      if (deptId === undefined) {
        json(response, 403, { error: 'forbidden' })
        return
      }
      if (method === 'GET' && segments.length === 3 && segments[2] === 'members') {
        const members = options.authenticator.listMembers?.(deptId) ?? []
        json(response, 200, { deptId, members })
        return
      }
      if (method === 'GET' && segments.length === 3 && segments[2] === 'usage') {
        json(response, 200, transcript.deptUsage(deptId))
        return
      }
      if (method === 'GET' && segments.length === 3 && segments[2] === 'audit') {
        json(response, 200, transcript.deptAuditTrail(deptId, 200))
        return
      }
    }
    if (principal.role === 'platform-admin' && method === 'GET' && segments.length === 3 && segments[1] === 'admin' && segments[2] === 'overview') {
      json(response, 200, {
        departments: options.authenticator.listDepartments?.() ?? [],
        acp: manager.stats(),
        web: webManager?.stats() ?? { live: 0, liveKeys: [] },
      })
      return
    }
    if (method === 'GET' && segments.length === 2 && segments[1] === 'usage') {
      json(response, 200, transcript.usage(tenantId))
      return
    }
    if (method === 'GET' && segments.length === 2 && segments[1] === 'audit') {
      json(response, 200, transcript.auditTrail(tenantId))
      return
    }
    if (method === 'GET' && segments.length === 2 && segments[1] === 'sessions') {
      json(response, 200, { sessions: transcript.listSessions(tenantId) })
      return
    }
    if (method === 'POST' && segments.length === 3 && segments[1] === 'session' && segments[2] === 'new') {
      const body = await readJsonBody(request) as { cwd?: string }
      if (typeof body.cwd !== 'string' || body.cwd === '') {
        json(response, 400, { error: 'cwd required' })
        return
      }
      const cwd = body.cwd
      const result = await manager.withTenant(tenantId, runtime => runtime.request('session/new', {
        cwd,
        mcpServers: [],
      }))
      const sessionId = (result as { sessionId?: string }).sessionId ?? ''
      if (sessionId !== '') transcript.registerSession(tenantId, sessionId, cwd)
      transcript.audit(tenantId, 'session-new', `${sessionId} cwd=${cwd}`)
      json(response, 200, result)
      return
    }
    if (segments.length === 4 && segments[1] === 'session' && segments[2] !== undefined && segments[3] !== undefined) {
      const sessionId = segments[2]
      const action = segments[3]
      if (method === 'POST' && action === 'prompt') {
        const body = await readJsonBody(request) as { text?: string }
        if (typeof body.text !== 'string' || body.text === '') {
          json(response, 400, { error: 'text required' })
          return
        }
        // The runtime may have been reaped since this session last ran: ACP
        // prompts only work on open sessions, so re-open (resume) first and
        // treat "already active" as success. The registry's cwd is what
        // resume must repeat. One withTenant covers both calls so an eager
        // eviction cannot spawn a fresh runtime between them.
        const cwd = transcript.sessionCwd(tenantId, sessionId)
        const result = await manager.withTenant(tenantId, async (runtime) => {
          if (cwd !== undefined) {
            try {
              await runtime.request('session/resume', { sessionId, cwd, mcpServers: [] })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              if (message.includes('not resumable')) throw new SessionGoneError(sessionId)
              if (!message.includes('already active')) throw error
            }
          }
          return runtime.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: body.text }],
          })
        })
        if (cwd !== undefined) transcript.registerSession(tenantId, sessionId, cwd)
        transcript.audit(tenantId, 'session-prompt', `${sessionId} stop=${(result as { stopReason?: string }).stopReason ?? '?'}`)
        json(response, 200, result)
        return
      }
      if (method === 'POST' && action === 'close') {
        const result = await manager.withTenant(tenantId, runtime => runtime.request('session/close', { sessionId }))
        transcript.audit(tenantId, 'session-close', sessionId)
        json(response, 200, result)
        return
      }
      if (method === 'POST' && action === 'resume') {
        const body = await readJsonBody(request) as { cwd?: string }
        if (typeof body.cwd !== 'string' || body.cwd === '') {
          json(response, 400, { error: 'cwd required' })
          return
        }
        const cwd = body.cwd
        const result = await manager.withTenant(tenantId, async (runtime) => {
          try {
            return await runtime.request('session/resume', { sessionId, cwd, mcpServers: [] })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes('not resumable')) throw new SessionGoneError(sessionId)
            throw error
          }
        })
        transcript.registerSession(tenantId, sessionId, cwd)
        json(response, 200, result)
        return
      }
      if (method === 'GET' && action === 'transcript') {
        json(response, 200, transcript.list(tenantId, sessionId))
        return
      }
    }
    json(response, 404, { error: 'not found' })
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (error instanceof InvalidJsonBodyError) {
        json(response, 400, { error: 'invalid json' })
        return
      }
      if (error instanceof SessionGoneError) {
        json(response, 404, { error: 'session no longer exists on this tenant runtime' })
        return
      }
      // Provider rate limits deserve a tenant-actionable answer; everything
      // else stays generic (internal errors can carry paths and spawn
      // diagnostics no tenant should see).
      // ponytail: message regex is the only lever here - the ACP bridge
      // flattens structured error codes into strings; the durable fix is
      // bridging the provider code through RequestError data.
      const message = error instanceof Error ? error.message : String(error)
      if (/rate.?limit|tpm.rpm|exceeds tpm|insufficient quota/i.test(message)) {
        json(response, 429, { error: 'model provider rate limited or out of quota' })
        return
      }
      console.error('[platform-bff] request failed:', error)
      json(response, 500, { error: 'internal error' })
    })
  })

  async function proxyModelCall(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    gateway: NonNullable<PlatformServerOptions['modelGateway']>,
  ): Promise<void> {
    const token = bearerOf(request)
    const payload = token === undefined ? undefined : verifyModelToken(gateway.secret, token)
    if (payload === undefined) {
      json(response, 401, { error: 'invalid model token' })
      return
    }
    const upstreamPath = url.pathname.replace(/^\/internal\/model\/v1/, '') + (url.search || '')
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
    const upstreamHeaders: Record<string, string> = {
      authorization: `Bearer ${gateway.upstreamApiKey}`,
    }
    if (body !== undefined) upstreamHeaders['content-type'] = request.headers['content-type'] ?? 'application/json'
    const upstream = await fetch(`${gateway.upstreamBaseUrl.replace(/\/$/u, '')}${upstreamPath}`, {
      method: request.method ?? 'POST',
      headers: upstreamHeaders,
      ...(body === undefined ? {} : { body: new Uint8Array(body) }),
    })
    response.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/json',
      'cache-control': 'no-store',
    })
    if (upstream.body === null) {
      response.end()
      return
    }
    // Stream through while sniffing usage for metering (chat-completions
    // responses carry a usage object - the final SSE frame when streaming).
    let collected = ''
    const reader = upstream.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      response.write(value)
      if (collected.length < 4_000_000) collected += Buffer.from(value).toString('utf8')
    }
    response.end()
    const usage = extractUsage(upstream.headers.get('content-type') ?? '', collected)
    // Metering attributes to the composite `deptId/userId` storage key the
    // console drills down by; bare-tenant tokens (legacy) audit as-is.
    const meteredKey = payload.user === undefined ? payload.tenant : `${payload.tenant}/${payload.user}`
    transcript.audit(
      meteredKey,
      'model-call',
      `user=${payload.user ?? '-'} status=${String(upstream.status)} ${usage === undefined ? 'tokens=?' : `tokens=${String(usage.prompt)}+${String(usage.completion)}`}`,
    )
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    // Model gateway: signed runtime tokens, not tenant bearer tokens, and no
    // session state - only provider forwarding and metering.
    if (options.modelGateway !== undefined && url.pathname.startsWith('/internal/model/')) {
      await proxyModelCall(request, response, url, options.modelGateway)
      return
    }
    // User-side original UI mount: browsers hold a platform session cookie
    // (minted from a ptoken query), not bearer headers.
    const mount = parseUserMount(url.pathname)
    if (mount !== undefined) {
      await handleUserMount(request, response, url, mount)
      return
    }
    if (request.method === 'GET' && url.pathname !== '/api/') {
      const portalFile = PORTAL_FILES.get(url.pathname)
      if (portalFile !== undefined) {
        response.writeHead(200, { 'content-type': portalFile[0], 'cache-control': 'no-store' })
        response.end(portalFile[1])
        return
      }
      if (!url.pathname.startsWith('/api/')) {
        json(response, 404, { error: 'not found' })
        return
      }
    }
    const token = bearerOf(request)
    const principal = token === undefined ? undefined : options.authenticator.authenticateToken(token)
    if (principal === undefined) {
      transcript.audit('unknown', 'auth-failed', request.method === 'GET' ? url.pathname : `${request.method} ${url.pathname}`)
      json(response, 401, { error: 'unauthorized' })
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      json(response, 404, { error: 'not found' })
      return
    }
    await dispatch(request, response, principal, url.pathname)
  }

  /** Resolve the platform session for browser-facing /u/ requests. */
  function sessionOf(request: IncomingMessage, url: URL): { principal: TenantPrincipal | undefined; cookieAuthenticated: boolean } {
    const cookieToken = readSessionCookie(request)
    if (cookieToken !== undefined) {
      const principal = options.authenticator.authenticateToken(cookieToken)
      if (principal !== undefined) return { principal, cookieAuthenticated: true }
    }
    const ptoken = url.searchParams.get('ptoken')
    return {
      principal: ptoken === null ? undefined : options.authenticator.authenticateToken(ptoken),
      cookieAuthenticated: false,
    }
  }

  async function handleUserMount(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    mount: { deptId: string; userId: string; rest: string },
  ): Promise<void> {
    if (webManager === undefined) {
      json(response, 404, { error: 'web ui not enabled' })
      return
    }
    // Routing fix-up first: the SPA's relative URLs only resolve when the
    // mount itself carries its trailing slash.
    if (mount.rest === '' && !url.pathname.endsWith('/')) {
      response.writeHead(308, { location: mountPrefix(mount.deptId, mount.userId) })
      response.end()
      return
    }
    const { principal, cookieAuthenticated } = sessionOf(request, url)
    if (principal === undefined) {
      const ptoken = url.searchParams.get('ptoken')
      if (ptoken !== null) {
        transcript.audit('unknown', 'web-auth-failed', `${mount.deptId}/${mount.userId}`)
        json(response, 401, { error: 'unauthorized' })
        return
      }
      // No session at all: the browser needs the sign-in entry point.
      response.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      response.end('unauthorized: open your web UI through the console link (?ptoken=<your token> once)')
      return
    }
    // A console link carries the ptoken: mint or rotate the session cookie
    // whenever the browser's current one is absent OR no longer
    // authenticates (a revoked token must not wedge the user out of the
    // re-mint path), then land clean on the subpath root.
    if (!cookieAuthenticated && url.searchParams.has('ptoken')) {
      response.writeHead(303, {
        location: mountPrefix(mount.deptId, mount.userId),
        'set-cookie': sessionCookieHeader(ptokenValue(url)),
        'cache-control': 'no-store',
      })
      response.end()
      return
    }
    if (!mayUseWebUi(principal, mount.deptId, mount.userId)) {
      transcript.audit(principal.tenantId, 'web-forbidden', `${mount.deptId}/${mount.userId}`)
      json(response, 403, { error: 'forbidden' })
      return
    }
    await proxyWebRequest(webManager, request, response, mount, url)
  }

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    // Synchronous event callback: an unguarded throw (a hostile Host header
    // fails URL parsing before any auth) would crash the whole process.
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      // Original-UI WebSocket tunnels (the SPA's remote.mux socket).
      const mount = parseUserMount(url.pathname)
      if (mount !== undefined) {
        if (webManager === undefined) {
          socket.destroy()
          return
        }
        const principal = sessionOf(request, url).principal
        if (principal === undefined) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
        if (!mayUseWebUi(principal, mount.deptId, mount.userId)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }
        proxyWebUpgrade(webManager, request, socket, head, mount)
        return
      }
      if (url.pathname !== '/ws') {
        socket.destroy()
        return
      }
      const token = url.searchParams.get('token')
      const principal = token === null ? undefined : options.authenticator.authenticateToken(token)
      if (principal === undefined) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        // ws emits 'error' on protocol violations and failed sends; an
        // unhandled 'error' would crash the process, so terminate instead.
        ws.on('error', () => { ws.terminate() })
        const entry = socketsOf(principal.tenantId)
        entry.sockets.add(ws)
        // Registered before the replay loop so a socket that dies mid-replay
        // cannot linger in the tenant set.
        ws.on('close', () => { entry.sockets.delete(ws) })
        // A tenant's only viewer may have reconnected (page refresh): replay
        // pending permission requests instead of timing them out silently.
        for (const [id, pending] of entry.pending) {
          ws.send(JSON.stringify({ type: 'permission-request', id, request: pending.request }))
        }
        ws.on('message', (data) => {
          let message: unknown
          try {
            message = JSON.parse(messageText(data))
          } catch {
            return
          }
          const record = message as { type?: string; id?: string; response?: unknown }
          if (record.type === 'permission-response' && typeof record.id === 'string') {
            const pending = entry.pending.get(record.id)
            if (pending !== undefined) transcript.audit(principal.tenantId, 'permission-answer', record.id)
            pending?.resolve(validPermissionResponse(record.response))
          }
        })
      })
    } catch (error) {
      console.error('[platform-bff] upgrade failed:', error)
      socket.destroy()
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('platform-bff: unexpected listen address')

  return {
    port: address.port,
    server,
    peekRuntime: tenantId => manager.peek(tenantId),
    webStats: () => webManager?.stats() ?? { live: 0, liveKeys: [] },
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve, reject) => {
        server.close(() => { resolve() })
        server.once('error', reject)
      })
      await manager.shutdown()
      await webManager?.shutdown()
      transcript.close()
    },
  }
}

/** Decode one ws `message` payload to text across its possible shapes. */
export function messageText(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Buffer) return data.toString('utf8')
  if (Array.isArray(data)) return data.map(chunk => messageText(chunk)).join('')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  throw new Error(`platform-bff: unsupported websocket message payload ${typeof data}`)
}

class InvalidJsonBodyError extends Error {}

/** Best-effort usage extraction from a (possibly SSE) chat-completions response. */
function extractUsage(contentType: string, collected: string): { prompt: number; completion: number } | undefined {
  try {
    if (contentType.includes('text/event-stream')) {
      let found: { prompt: number; completion: number } | undefined
      for (const line of collected.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '' || data === '[DONE]') continue
        const usage = (JSON.parse(data) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
        if (usage !== undefined) found = { prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0 }
      }
      return found
    }
    const usage = (JSON.parse(collected) as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage
    if (usage === undefined) return undefined
    return { prompt: usage.prompt_tokens ?? 0, completion: usage.completion_tokens ?? 0 }
  } catch {
    return undefined
  }
}

/** The registry references a session the tenant runtime no longer has. */
class SessionGoneError extends Error {}

/**
 * The department a console request may read: a dept admin's own department,
 * a platform admin's ?dept= selection (still a safe segment — the transcript's
 * GLOB prefix queries document that invariant), or undefined when the caller
 * may not read departments at all (members) or named an invalid one.
 */
function deptScopeOf(request: IncomingMessage, principal: TenantPrincipal): string | undefined {
  if (principal.role === 'platform-admin') {
    const dept = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).searchParams.get('dept')
    if (dept === null || dept === '' || !isSafeTenantSegment(dept)) return undefined
    return dept
  }
  if (principal.role === 'dept-admin') return principal.deptId
  return undefined
}

const PLATFORM_SESSION_COOKIE = 'dsh-platform-session'

/** Read the platform session cookie's token, or undefined. */
function readSessionCookie(request: IncomingMessage): string | undefined {
  const header = request.headers.cookie
  if (header === undefined) return undefined
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === PLATFORM_SESSION_COOKIE && rest.length > 0) return rest.join('=')
  }
  return undefined
}

function ptokenValue(url: URL): string | undefined {
  return url.searchParams.get('ptoken') ?? undefined
}

/** HttpOnly, scoped to the /u/ mounts; SameSite=Lax survives the console link navigation. */
function sessionCookieHeader(token: string | undefined): string {
  if (token === undefined) return ''
  return `${PLATFORM_SESSION_COOKIE}=${token}; Path=/u/; HttpOnly; SameSite=Lax; Max-Age=${String(30 * 24 * 60 * 60)}`
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (error) {
    throw new InvalidJsonBodyError('request body is not valid JSON', { cause: error })
  }
}

/** A tenant socket's permission answer, degraded to fail-closed when malformed. */
function validPermissionResponse(response: unknown): unknown {
  if (typeof response === 'object' && response !== null) {
    const outcome = (response as { outcome?: unknown }).outcome
    if (typeof outcome === 'object' && outcome !== null) {
      const kind = (outcome as { outcome?: unknown }).outcome
      if (kind === 'cancelled' || kind === 'selected') return response
    }
  }
  return { outcome: { outcome: 'cancelled' } }
}
