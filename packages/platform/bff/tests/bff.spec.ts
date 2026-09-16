import { EventEmitter } from 'node:events'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { devTokenAuthenticator } from '../src/auth.ts'
import { messageText, startPlatformServer, type PlatformServer } from '../src/index.ts'
import type { TenantRuntime } from '@deepseek-ai/dsh-orchestrator'

/**
 * BFF behavior against an in-memory fake runtime: real HTTP + WS on an
 * OS-assigned port, no child processes. Real-spawn coverage lives in
 * bff.e2e.ts. Tokens and ports are per-test; nothing is shared.
 */

class FakeRuntimeHub extends EventEmitter {
  permissionHandler: ((request: unknown) => Promise<unknown>) | undefined
  updateListener: ((sessionId: string, update: unknown) => void) | undefined
  requests: string[] = []

  emitUpdate(sessionId: string, update: unknown): void {
    this.updateListener?.(sessionId, update)
  }
}

function fakeRuntimeFactory(hub: FakeRuntimeHub): (tenantId: string) => Promise<TenantRuntime> {
  return async (tenantId) => {
    const runtime: TenantRuntime = {
      tenantId,
      request: async <T>(method: string, params: unknown): Promise<T> => {
        hub.requests.push(method)
        if (method === 'session/new') return { sessionId: 'sess-1' } as T
        if (method === 'session/prompt') return { stopReason: 'end_turn' } as T
        if (method === 'session/close') return {} as T
        if (method === 'session/list') return { sessions: [{ sessionId: 'sess-1', cwd: `/ws/${tenantId}` }] } as T
        if (method === 'session/resume') return {} as T
        throw new Error(`fake runtime: unsupported method ${method} (${JSON.stringify(params)})`)
      },
      onUpdate: (listener) => {
        hub.updateListener = listener
        return () => { hub.updateListener = undefined }
      },
      onPermission: (handler) => { hub.permissionHandler = handler },
      get lastUsedAt(): number {
        return Date.now()
      },
      dispose: async () => {},
      exited: () => new Promise<void>(() => {}),
    }
    return runtime
  }
}

const TOKEN_A = 'token-alpha'
const TOKEN_B = 'token-beta'

const cleanupFns: Array<() => Promise<void> | void> = []
const sockets: WebSocket[] = []

afterEach(async () => {
  while (sockets.length > 0) sockets.pop()!.close()
  while (cleanupFns.length > 0) await cleanupFns.pop()!()
})

async function startServer(hub: FakeRuntimeHub, options: { permissionTimeoutMs?: number } = {}): Promise<PlatformServer> {
  const server = await startPlatformServer({
    authenticator: devTokenAuthenticator(new Map([[TOKEN_A, 'alpha'], [TOKEN_B, 'beta']])),
    createRuntime: fakeRuntimeFactory(hub),
    ...(options.permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs: options.permissionTimeoutMs }),
  })
  cleanupFns.push(() => server.close())
  return server
}

function api(server: PlatformServer, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
}

describe('platform BFF', () => {
  it('rejects missing or unknown tokens and accepts a known tenant', async () => {
    const server = await startServer(new FakeRuntimeHub())
    expect((await fetch(`http://127.0.0.1:${server.port}/api/sessions`)).status).toBe(401)
    expect((await api(server, 'wrong-token', '/api/sessions')).status).toBe(401)
    expect((await api(server, TOKEN_A, '/api/sessions')).status).toBe(200)
  })

  it('drives the REST session flow and validates required fields', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startServer(hub)

    expect((await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: '{}' })).status).toBe(400)

    const created = await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })
    expect(await created.json()).toEqual({ sessionId: 'sess-1' })

    expect((await api(server, TOKEN_A, '/api/session/sess-1/prompt', { method: 'POST', body: '{}' })).status).toBe(400)
    const prompted = await api(server, TOKEN_A, '/api/session/sess-1/prompt', {
      method: 'POST',
      body: JSON.stringify({ text: 'hello' }),
    })
    expect(await prompted.json()).toEqual({ stopReason: 'end_turn' })

    expect((await api(server, TOKEN_A, '/api/session/sess-1/close', { method: 'POST' })).status).toBe(200)
    expect(hub.requests).toEqual(['session/new', 'session/prompt', 'session/close'])
  })

  it('persists observed updates as transcript and keeps tenants isolated', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startServer(hub)
    await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })

    hub.emitUpdate('sess-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } })
    hub.emitUpdate('sess-1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' there' } })

    const rows = (await (await api(server, TOKEN_A, '/api/session/sess-1/transcript')).json()) as { seq: number; update: string }[]
    expect(rows).toHaveLength(2)
    expect(JSON.parse(rows[0]!.update)).toMatchObject({ sessionUpdate: 'agent_message_chunk' })
    expect(rows[0]!.seq).toBeLessThan(rows[1]!.seq)

    const foreign = await api(server, TOKEN_B, '/api/session/sess-1/transcript')
    expect(foreign.status).toBe(200)
    expect(await foreign.json()).toEqual([])
  })

  it('fans updates out over WebSocket and rejects bad upgrades', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startServer(hub)
    await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${TOKEN_A}`)
    sockets.push(socket)
    const received = new Promise<unknown[]>((resolve) => {
      const messages: unknown[] = []
      socket.on('message', (data) => {
        messages.push(JSON.parse(messageText(data)) as unknown)
        if (messages.length === 1) resolve(messages)
      })
    })
    await new Promise<void>((resolve) => { socket.on('open', resolve) })

    hub.emitUpdate('sess-1', { sessionUpdate: 'agent_message_chunk' })
    expect(await received).toEqual([
      { type: 'session-update', sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk' } },
    ])

    const denied = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=nope`)
    sockets.push(denied)
    const deniedOutcome = await Promise.race([
      new Promise<'closed'>((resolve) => { denied.on('error', () => { resolve('closed') }); denied.on('close', () => { resolve('closed') }) }),
      new Promise<'open'>((resolve) => { denied.on('open', () => { resolve('open') }) }),
    ])
    expect(deniedOutcome).toBe('closed')
  })

  it('forwards permission requests to the tenant socket and resolves the answer', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startServer(hub)
    await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${TOKEN_A}`)
    sockets.push(socket)
    await new Promise<void>((resolve) => { socket.on('open', resolve) })
    const requestMessage = new Promise<{ type: string; id: string; request: unknown }>((resolve) => {
      socket.on('message', (data) => {
        resolve(JSON.parse(messageText(data)) as { type: string; id: string; request: unknown })
      })
    })

    const answer = hub.permissionHandler!({ options: [{ optionId: 'allow-once' }] })
    const received = await requestMessage
    expect(received.type).toBe('permission-request')
    socket.send(JSON.stringify({ type: 'permission-response', id: received.id, response: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }))
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })

  it('fails closed when no tenant socket is connected', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startServer(hub)
    await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })

    await expect(hub.permissionHandler!({ options: [] })).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('times out an unanswered forwarded permission as cancelled', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startServer(hub, { permissionTimeoutMs: 100 })
    await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${TOKEN_A}`)
    sockets.push(socket)
    await new Promise<void>((resolve) => { socket.on('open', resolve) })

    await expect(hub.permissionHandler!({ options: [] })).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  }, 10_000)
})

afterAll(() => {
  vi.restoreAllMocks()
})
