import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  TenantRuntimeManager,
  type TenantRuntime,
  type TenantRuntimeFactory,
  type TenantRuntimeManagerOptions,
} from '@deepseek-ai/dsh-orchestrator'
import { bearerOf, type Authenticator } from './auth.ts'
import { TranscriptStore } from './transcript.ts'

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
}

export interface PlatformServer {
  readonly port: number
  readonly server: Server
  /** Live runtime for the tenant, or undefined (tests and diagnostics). */
  peekRuntime(tenantId: string): TenantRuntime | undefined
  close(): Promise<void>
}

interface TenantSockets {
  readonly sockets: Set<WebSocket>
  readonly pending: Map<string, { request: unknown; resolve: (response: unknown) => void; timer: NodeJS.Timeout }>
}

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

  const json = (response: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body)
    response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    response.end(payload)
  }

  const dispatch = async (request: IncomingMessage, response: ServerResponse, tenantId: string, pathname: string): Promise<void> => {
    const method = request.method
    const segments = pathname.split('/').filter(segment => segment !== '')
    if (segments[0] !== 'api') {
      json(response, 404, { error: 'not found' })
      return
    }
    if (method === 'GET' && segments.length === 2 && segments[1] === 'sessions') {
      const listed = await manager.withTenant(tenantId, runtime => runtime.request('session/list', {}))
      json(response, 200, listed)
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
        const result = await manager.withTenant(tenantId, runtime => runtime.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: body.text }],
        }))
        json(response, 200, result)
        return
      }
      if (method === 'POST' && action === 'close') {
        const result = await manager.withTenant(tenantId, runtime => runtime.request('session/close', { sessionId }))
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
        const result = await manager.withTenant(tenantId, runtime => runtime.request('session/resume', {
          sessionId,
          cwd,
          mcpServers: [],
        }))
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
      // Generic outward message: internal errors can carry paths and spawn
      // diagnostics that no tenant should see.
      console.error('[platform-bff] request failed:', error)
      json(response, 500, { error: 'internal error' })
    })
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    const token = bearerOf(request)
    const principal = token === undefined ? undefined : options.authenticator.authenticateToken(token)
    if (principal === undefined) {
      json(response, 401, { error: 'unauthorized' })
      return
    }
    if (!url.pathname.startsWith('/api/')) {
      json(response, 404, { error: 'not found' })
      return
    }
    await dispatch(request, response, principal.tenantId, url.pathname)
  }

  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    // Synchronous event callback: an unguarded throw (a hostile Host header
    // fails URL parsing before any auth) would crash the whole process.
    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
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
        // A tenant's only viewer may have reconnected (page refresh): replay
        // pending permission requests instead of timing them out silently.
        for (const [id, pending] of entry.pending) {
          ws.send(JSON.stringify({ type: 'permission-request', id, request: pending.request }))
        }
        ws.on('close', () => { entry.sockets.delete(ws) })
        ws.on('message', (data) => {
          let message: unknown
          try {
            message = JSON.parse(messageText(data))
          } catch {
            return
          }
          const record = message as { type?: string; id?: string; response?: unknown }
          if (record.type === 'permission-response' && typeof record.id === 'string') {
            entry.pending.get(record.id)?.resolve(validPermissionResponse(record.response))
          }
        })
      })
    } catch {
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
    close: async () => {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve, reject) => {
        server.close(() => { resolve() })
        server.once('error', reject)
      })
      await manager.shutdown()
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
