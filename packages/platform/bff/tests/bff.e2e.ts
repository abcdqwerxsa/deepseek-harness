import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { composeTenantRuntimeFactory } from '../src/compose.ts'
import { afterEach, describe, expect, it } from 'vitest'
import { devTokenAuthenticator } from '../src/auth.ts'
import { messageText, startPlatformServer, type PlatformServer } from '../src/index.ts'

/**
 * BFF e2e against a real spawned `dsh --profile acp` child per tenant: REST
 * session flow, live WS update fan-out, persisted transcript, and tenant
 * isolation across homes. Mock provider ports are OS-assigned; every tenant
 * root is a unique mkdtemp.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')
const TEST_BUDGET_MS = 120_000

const TOKEN_A = 'e2e-token-alpha'
const TOKEN_B = 'e2e-token-beta'

const cleanupFns: Array<() => Promise<void> | void> = []
const sockets: WebSocket[] = []

afterEach(async () => {
  while (sockets.length > 0) sockets.pop()!.close()
  while (cleanupFns.length > 0) await cleanupFns.pop()!()
})

async function startBff(server0: MockLlmServer): Promise<PlatformServer> {
  // The production glue drives this e2e: per-tenant provisioned homes under
  // a mkdtemp tenants root, mock provider via baseUrl + settings override.
  const tenantsRoot = mkdtempSync(join(tmpdir(), 'dsh-bff-tenants-'))
  cleanupFns.push(() => { rmSync(tenantsRoot, { recursive: true, force: true }) })
  const platform = await startPlatformServer({
    authenticator: devTokenAuthenticator(new Map([[TOKEN_A, 'alpha'], [TOKEN_B, 'beta']])),
    createRuntime: composeTenantRuntimeFactory({
      tenantsRoot,
      dshBin,
      apiKey: 'bff-e2e-key',
      baseUrl: server0.baseURL,
      dshVersion: 'bff-e2e',
      settingsYaml: 'llm-deepseek:\n  protocol: chat-completions\n',
    }),
    maxConcurrent: 2,
  })
  cleanupFns.push(() => platform.close())
  return platform
}

function api(platform: PlatformServer, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${platform.port}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
}

describe('platform BFF over real spawned runtimes', () => {
  it('serves the build-free portal page from the same origin', async () => {
    const platform = await startBff(await (async () => {
      const server = await startMockLlmServer({ sequence: ['success'], apiKey: 'bff-e2e-key', successText: 'x', repeatLast: true })
      cleanupFns.push(() => server.close())
      return server
    })())
    const page = await fetch(`http://127.0.0.1:${platform.port}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('租户会话')
    expect(html).toContain('portal.js')
    const script = await fetch(`http://127.0.0.1:${platform.port}/portal.js`)
    expect(script.status).toBe(200)
  }, TEST_BUDGET_MS)

  it('drives a session through REST, streams updates over WS, and persists transcript', async () => {
    const mock = await startMockLlmServer({
      sequence: ['success'],
      apiKey: 'bff-e2e-key',
      successText: 'BFF E2E OK',
      repeatLast: true,
    })
    cleanupFns.push(() => mock.close())
    const platform = await startBff(mock)

    const socket = new WebSocket(`ws://127.0.0.1:${platform.port}/ws?token=${TOKEN_A}`)
    sockets.push(socket)
    await new Promise<void>((resolve) => { socket.on('open', resolve) })
    const updates: unknown[] = []
    socket.on('message', (data) => {
      const message = JSON.parse(messageText(data)) as { type: string; update?: unknown }
      if (message.type === 'session-update') updates.push(message.update)
    })

    const scratch = mkdtempSync(join(tmpdir(), 'dsh-bff-scratch-'))
    cleanupFns.push(() => { rmSync(scratch, { recursive: true, force: true }) })
    const created = await api(platform, TOKEN_A, '/api/session/new', {
      method: 'POST',
      body: JSON.stringify({ cwd: scratch }),
    })
    const { sessionId } = await created.json() as { sessionId: string }
    expect(sessionId).toBeTruthy()

    const prompted = await api(platform, TOKEN_A, `/api/session/${sessionId}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text: 'say the marker' }),
    })
    expect(await prompted.json()).toEqual({ stopReason: 'end_turn' })

    // Updates streamed to the tenant's socket.
    expect(updates.some(update => (
      (update as { sessionUpdate?: string; content?: { text?: string } }).sessionUpdate === 'agent_message_chunk'
      && (update as { content?: { text?: string } }).content?.text === 'BFF E2E OK'
    ))).toBe(true)

    // Transcript persisted server-side and replayable.
    const transcript = await (await api(platform, TOKEN_A, `/api/session/${sessionId}/transcript`)).json() as { update: string }[]
    const parsed = transcript.map(row => JSON.parse(row.update) as { content?: { text?: string } })
    expect(parsed.some(row => row.content?.text === 'BFF E2E OK')).toBe(true)

    // Cross-tenant isolation: beta sees nothing of alpha's session.
    expect(await api(platform, TOKEN_B, '/api/sessions')).toBeDefined()
    const foreign = await (await api(platform, TOKEN_B, `/api/session/${sessionId}/transcript`)).json() as unknown[]
    expect(foreign).toEqual([])

    expect((await api(platform, TOKEN_A, `/api/session/${sessionId}/close`, { method: 'POST' })).status).toBe(200)

    // Usage aggregates reflect the real stack: one audited turn and at least
    // the streamed reply chunk from the real child's update stream.
    const usage = await (await api(platform, TOKEN_A, '/api/usage')).json() as {
      totals: { sessions: number; turns: number; messages: number }
    }
    expect(usage.totals.sessions).toBeGreaterThanOrEqual(1)
    expect(usage.totals.turns).toBeGreaterThanOrEqual(1)
    expect(usage.totals.messages).toBeGreaterThanOrEqual(1)
  }, TEST_BUDGET_MS)
})
