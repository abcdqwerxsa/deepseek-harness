import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import { connect as netConnect, type Socket as netSocket } from 'node:net'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { devTokenAuthenticator, type DevTokenIdentity } from '../src/auth.ts'

const ident = (userId: string, deptId = 'core'): DevTokenIdentity => ({ deptId, userId, role: 'member' })
import { startPlatformServer } from '../src/index.ts'
import { messageText, type PlatformServer } from '../src/index.ts'
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
        if (method === 'session/prompt') {
          if ((params as { sessionId?: string }).sessionId === 'boom') {
            throw new Error('spawn /tmp/dsh-tenant-xyz failed: diagnostic detail')
          }
          return { stopReason: 'end_turn' } as T
        }
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
    authenticator: devTokenAuthenticator(new Map([[TOKEN_A, ident('alpha')], [TOKEN_B, ident('beta')]])),
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

  it('lists a freshly created session immediately and auto-resumes on prompt', async () => {
    const calls: string[] = []
    const resumed: unknown[] = []
    const server = await startPlatformServer({
      authenticator: devTokenAuthenticator(new Map([[TOKEN_A, ident('alpha')], [TOKEN_B, ident('beta')]])),
      createRuntime: async tenantId => ({
        tenantId,
        request: async <T>(method: string, params: unknown): Promise<T> => {
          calls.push(method)
          if (method === 'session/new') return { sessionId: 'sess-live' } as T
          if (method === 'session/resume') {
            resumed.push(params)
            return {} as T
          }
          if (method === 'session/prompt') return { stopReason: 'end_turn' } as T
          if (method === 'session/close') return {} as T
          if (method === 'session/list') return { sessions: [] } as T
          throw new Error(`spec fake: ${method}`)
        },
        onUpdate: () => () => {},
        onPermission: () => {},
        get lastUsedAt(): number {
          return Date.now()
        },
        dispose: async () => {},
        exited: () => new Promise<void>(() => {}),
      }),
    })
    cleanupFns.push(() => server.close())

    await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })
    // The registry lists it right away, while the runtime is alive and the
    // session is open (ACP session/list would exclude it).
    const listed = await (await api(server, TOKEN_A, '/api/sessions')).json() as { sessions: { sessionId: string; cwd: string }[] }
    expect(listed.sessions.map(entry => entry.sessionId)).toContain('sess-live')
    expect(listed.sessions[0]!.cwd).toBe('/ws/alpha')

    // Prompt re-opens the session first (runtime may have been reaped).
    await api(server, TOKEN_A, '/api/session/sess-live/prompt', { method: 'POST', body: JSON.stringify({ text: 'hi' }) })
    expect(resumed).toEqual([{ sessionId: 'sess-live', cwd: '/ws/alpha', mcpServers: [] }])
    expect(calls.slice(0, 3)).toEqual(['session/new', 'session/resume', 'session/prompt'])
  })

  it('registers the authoritative cwd on explicit resume and keeps prompting', async () => {
    // Legacy sessions (created before the registry existed) enter through the
    // documented resume route; the recorded cwd must keep later prompts
    // working instead of poisoning the registry with an empty string.
    const calls: string[] = []
    const server = await startPlatformServer({
      authenticator: devTokenAuthenticator(new Map([[TOKEN_A, ident('alpha')], [TOKEN_B, ident('beta')]])),
      createRuntime: async tenantId => ({
        tenantId,
        request: async <T>(method: string): Promise<T> => {
          calls.push(method)
          if (method === 'session/resume') return {} as T
          if (method === 'session/prompt') return { stopReason: 'end_turn' } as T
          if (method === 'session/close') return {} as T
          if (method === 'session/list') return { sessions: [] } as T
          if (method === 'session/new') return { sessionId: 'unused' } as T
          throw new Error(`spec fake: ${method}`)
        },
        onUpdate: () => () => {},
        onPermission: () => {},
        get lastUsedAt(): number {
          return Date.now()
        },
        dispose: async () => {},
        exited: () => new Promise<void>(() => {}),
      }),
    })
    cleanupFns.push(() => server.close())

    // Legacy flow: explicit resume with the real cwd, then two prompts.
    await api(server, TOKEN_A, '/api/session/sess-legacy/resume', { method: 'POST', body: JSON.stringify({ cwd: '/ws/legacy' }) })
    expect((await api(server, TOKEN_A, '/api/session/sess-legacy/prompt', { method: 'POST', body: JSON.stringify({ text: 'one' }) })).status).toBe(200)
    expect((await api(server, TOKEN_A, '/api/session/sess-legacy/prompt', { method: 'POST', body: JSON.stringify({ text: 'two' }) })).status).toBe(200)

    const registered = await (await api(server, TOKEN_A, '/api/sessions')).json() as { sessions: { sessionId: string; cwd: string }[] }
    const entry = registered.sessions.find(item => item.sessionId === 'sess-legacy')
    expect(entry?.cwd).toBe('/ws/legacy')
    // Both prompts auto-resumed with the registered cwd, never an empty one.
    expect(calls.filter(method => method === 'session/resume')).toHaveLength(3)
  })

  it('heals a poisoned registry row through an explicit resume (conflict path)', async () => {
    // Rows written by the pre-fix build carry cwd:''; the upsert must now
    // rewrite cwd so the authoritative value from a successful resume wins.
    const server = await startPlatformServer({
      authenticator: devTokenAuthenticator(new Map([[TOKEN_A, ident('alpha')], [TOKEN_B, ident('beta')]])),
      createRuntime: async tenantId => ({
        tenantId,
        request: async <T>(method: string): Promise<T> => {
          if (method === 'session/resume' || method === 'session/prompt') return {} as T
          throw new Error(`spec fake: ${method}`)
        },
        onUpdate: () => () => {},
        onPermission: () => {},
        get lastUsedAt(): number {
          return Date.now()
        },
        dispose: async () => {},
        exited: () => new Promise<void>(() => {}),
      }),
    })
    cleanupFns.push(() => server.close())

    // First resume registers the row; a second resume with a different
    // (authoritative) cwd must rewrite it, healing pre-fix poisoned rows.
    await api(server, TOKEN_A, '/api/session/sess-poison/resume', { method: 'POST', body: JSON.stringify({ cwd: '/ws/first' }) })
    const poisoned = await (await api(server, TOKEN_A, '/api/sessions')).json() as { sessions: { sessionId: string; cwd: string }[] }
    expect(poisoned.sessions.find(item => item.sessionId === 'sess-poison')?.cwd).toBe('/ws/first')
    await api(server, TOKEN_A, '/api/session/sess-poison/resume', { method: 'POST', body: JSON.stringify({ cwd: '/ws/healed' }) })
    const healed = await (await api(server, TOKEN_A, '/api/sessions')).json() as { sessions: { sessionId: string; cwd: string }[] }
    expect(healed.sessions.find(item => item.sessionId === 'sess-poison')?.cwd).toBe('/ws/healed')
  })

  it('answers 404 on the explicit resume route when the session is gone', async () => {
    const server = await startPlatformServer({
      authenticator: devTokenAuthenticator(new Map([[TOKEN_A, ident('alpha')], [TOKEN_B, ident('beta')]])),
      createRuntime: async tenantId => ({
        tenantId,
        request: async <T>(method: string): Promise<T> => {
          if (method === 'session/resume') throw new Error('session is not resumable: gone')
          throw new Error(`spec fake: ${method}`)
        },
        onUpdate: () => () => {},
        onPermission: () => {},
        get lastUsedAt(): number {
          return Date.now()
        },
        dispose: async () => {},
        exited: () => new Promise<void>(() => {}),
      }),
    })
    cleanupFns.push(() => server.close())
    const gone = await api(server, TOKEN_A, '/api/session/sess-gone/resume', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })
    expect(gone.status).toBe(404)
  })

  it('answers 404 when the registry references a session the runtime no longer has', async () => {
    const server = await startPlatformServer({
      authenticator: devTokenAuthenticator(new Map([[TOKEN_A, ident('alpha')], [TOKEN_B, ident('beta')]])),
      createRuntime: async tenantId => ({
        tenantId,
        request: async <T>(method: string): Promise<T> => {
          if (method === 'session/resume') throw new Error('session is not resumable: gone')
          if (method === 'session/new') return { sessionId: 'sess-gone' } as T
          if (method === 'session/prompt') return { stopReason: 'end_turn' } as T
          throw new Error(`spec fake: ${method}`)
        },
        onUpdate: () => () => {},
        onPermission: () => {},
        get lastUsedAt(): number {
          return Date.now()
        },
        dispose: async () => {},
        exited: () => new Promise<void>(() => {}),
      }),
    })
    cleanupFns.push(() => server.close())
    await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })

    const gone = await api(server, TOKEN_A, '/api/session/sess-gone/prompt', { method: 'POST', body: JSON.stringify({ text: 'hi' }) })
    expect(gone.status).toBe(404)
  })

  it('tolerates already-active on the auto-resume path and maps rate limits to 429', async () => {
    let resumeCount = 0
    let failOnce = true
    const server = await startPlatformServer({
      authenticator: devTokenAuthenticator(new Map([[TOKEN_A, ident('alpha')], [TOKEN_B, ident('beta')]])),
      createRuntime: async tenantId => ({
        tenantId,
        request: async <T>(method: string): Promise<T> => {
          if (method === 'session/new') return { sessionId: 'sess-rl' } as T
          if (method === 'session/resume') {
            resumeCount += 1
            throw new Error('session is already active: sess-rl')
          }
          if (method === 'session/prompt') {
            if (failOnce) {
              failOnce = false
              throw new Error('Internal error: turn failed: inference exceeds tpm/rpm limit')
            }
            return { stopReason: 'end_turn' } as T
          }
          if (method === 'session/close') return {} as T
          throw new Error(`spec fake: ${method}`)
        },
        onUpdate: () => () => {},
        onPermission: () => {},
        get lastUsedAt(): number {
          return Date.now()
        },
        dispose: async () => {},
        exited: () => new Promise<void>(() => {}),
      }),
    })
    cleanupFns.push(() => server.close())
    await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })

    const limited = await api(server, TOKEN_A, '/api/session/sess-rl/prompt', { method: 'POST', body: JSON.stringify({ text: 'hi' }) })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'model provider rate limited or out of quota' })

    const recovered = await api(server, TOKEN_A, '/api/session/sess-rl/prompt', { method: 'POST', body: JSON.stringify({ text: 'hi' }) })
    expect(recovered.status).toBe(200)
    expect(resumeCount).toBe(2)
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
    expect(hub.requests).toEqual(['session/new', 'session/resume', 'session/prompt', 'session/close'])
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

  it('returns 400 for invalid JSON and hides internal error details on 500', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startServer(hub)

    const badJson = await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: '{not json' })
    expect(badJson.status).toBe(400)
    expect(await badJson.json()).toEqual({ error: 'invalid json' })

    // The fake runtime throws a diagnostic-heavy error; the 500 body must be generic.
    const failed = await api(server, TOKEN_A, '/api/session/boom/prompt', {
      method: 'POST',
      body: JSON.stringify({ text: 'x' }),
    })
    expect(failed.status).toBe(500)
    expect(await failed.json()).toEqual({ error: 'internal error' })
  })

  it('survives a hostile Host header on upgrade without authentication', async () => {
    const server = await startServer(new FakeRuntimeHub())
    const garbage = new Promise<void>((resolve) => {
      const socket = netConnect({ port: server.port, host: '127.0.0.1' }, () => {
        socket.write('GET /ws?token=anything HTTP/1.1\r\nHost: a b\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
        resolve()
      })
      socket.on('error', () => { resolve() })
      cleanupFns.push(() => { socket.destroy() })
    })
    await garbage
    // The server process is still serving authenticated traffic.
    expect((await api(server, TOKEN_A, '/api/sessions')).status).toBe(200)
  })

  it('survives a protocol-violating websocket frame from a tenant', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startServer(hub)
    await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })

    const connected = new Promise<netSocket>((resolve) => {
      const socket = netConnect({ port: server.port, host: '127.0.0.1' }, () => {
        const key = randomBytes(16).toString('base64')
        socket.write(
          'GET /ws?token=' + TOKEN_A + ' HTTP/1.1\r\n'
          + 'Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
          + 'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n',
        )
        socket.once('data', () => { resolve(socket) })
      })
      socket.on('error', () => {})
      cleanupFns.push(() => { socket.destroy() })
    })
    const raw = await connected
    // Unmasked text frame from the client: a protocol violation the receiver
    // raises as a socket 'error'.
    raw.write(Buffer.from([0x81, 0x01, 0x41]))
    await new Promise((resolve) => { setTimeout(resolve, 150) })
    expect((await api(server, TOKEN_A, '/api/sessions')).status).toBe(200)
  })

  it('degrades a malformed permission answer to cancelled', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startServer(hub)
    await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${TOKEN_A}`)
    sockets.push(socket)
    await new Promise<void>((resolve) => { socket.on('open', resolve) })
    const requestMessage = new Promise<{ type: string; id: string }>((resolve) => {
      socket.on('message', (data) => {
        resolve(JSON.parse(messageText(data)) as { type: string; id: string })
      })
    })

    const answer = hub.permissionHandler!({ options: [] })
    const received = await requestMessage
    socket.send(JSON.stringify({ type: 'permission-response', id: received.id, response: 5 }))
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
  })

  it('replays a pending permission request to a reconnecting tenant socket', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startServer(hub, { permissionTimeoutMs: 5_000 })
    await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })

    const first = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${TOKEN_A}`)
    sockets.push(first)
    await new Promise<void>((resolve) => { first.on('open', resolve) })
    const firstMessage = new Promise<{ type: string; id: string }>((resolve) => {
      first.on('message', (data) => {
        resolve(JSON.parse(messageText(data)) as { type: string; id: string })
      })
    })
    const answer = hub.permissionHandler!({ options: [{ optionId: 'allow-once' }] })
    const pending = await firstMessage
    expect(pending.type).toBe('permission-request')
    first.close()

    const second = new WebSocket(`ws://127.0.0.1:${server.port}/ws?token=${TOKEN_A}`)
    sockets.push(second)
    const replay = await new Promise<{ type: string; id: string }>((resolve) => {
      second.on('message', (data) => {
        resolve(JSON.parse(messageText(data)) as { type: string; id: string })
      })
    })
    expect(replay.type).toBe('permission-request')
    second.send(JSON.stringify({ type: 'permission-response', id: replay.id, response: { outcome: { outcome: 'selected', optionId: 'allow-once' } } }))
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })

  it('aggregates usage from the update stream and keeps an audit trail', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startPlatformServer({
      authenticator: devTokenAuthenticator(new Map([[TOKEN_A, ident('alpha')], [TOKEN_B, ident('beta')]])),
      createRuntime: async tenantId => ({
        tenantId,
        request: async <T>(method: string): Promise<T> => {
          if (method === 'session/new') return { sessionId: 'sess-usage' } as T
          if (method === 'session/prompt') {
            hub.emitUpdate('sess-usage', { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'go' } })
            hub.emitUpdate('sess-usage', { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', kind: 'execute' })
            hub.emitUpdate('sess-usage', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } })
            hub.emitUpdate('sess-usage', { sessionUpdate: 'usage_update', used: 1234, size: 128000 })
            return { stopReason: 'end_turn' } as T
          }
          if (method === 'session/close' || method === 'session/resume') return {} as T
          throw new Error(`usage fake: unsupported ${method}`)
        },
        onUpdate: (listener) => {
          hub.updateListener = listener
          return () => { hub.updateListener = undefined }
        },
        onPermission: () => {},
        get lastUsedAt(): number {
          return Date.now()
        },
        dispose: async () => {},
        exited: () => new Promise<void>(() => {}),
      }),
    })

    await api(server, TOKEN_A, '/api/session/new', { method: 'POST', body: JSON.stringify({ cwd: '/ws/alpha' }) })
    await api(server, TOKEN_A, '/api/session/sess-usage/prompt', { method: 'POST', body: JSON.stringify({ text: 'go' }) })

    const usage = await (await api(server, TOKEN_A, '/api/usage')).json() as {
      totals: { sessions: number; turns: number; messages: number; toolCalls: number }
      sessions: { sessionId: string; contextUsed: number | null; contextSize: number | null }[]
    }
    expect(usage.totals).toEqual({ sessions: 1, turns: 1, messages: 1, toolCalls: 1 })
    expect(usage.sessions[0]).toMatchObject({ sessionId: 'sess-usage', contextUsed: 1234, contextSize: 128000 })

    const audit = await (await api(server, TOKEN_A, '/api/audit')).json() as { event: string; detail: string | null }[]
    const events = audit.map(entry => entry.event)
    expect(events).toContain('session-new')
    expect(events).toContain('session-prompt')

    // Auth failures land in the 'unknown' bucket, not the tenant's trail.
    await fetch(`http://127.0.0.1:${server.port}/api/sessions`)
    const tenantAudit = await (await api(server, TOKEN_A, '/api/audit')).json() as { event: string }[]
    expect(tenantAudit.map(entry => entry.event)).not.toContain('auth-failed')
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
