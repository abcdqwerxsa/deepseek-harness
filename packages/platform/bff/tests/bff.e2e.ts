import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { provisionTenantHome } from '@deepseek-ai/dsh-tenant-profile'
import { spawnAcpStdioRuntime } from '@deepseek-ai/dsh-orchestrator'
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

function provisionTenantRoot(tenantId: string): { homeDir: string; workspaceDir: string } {
  const root = mkdtempSync(join(tmpdir(), `dsh-bff-${tenantId}-`))
  cleanupFns.push(() => { rmSync(root, { recursive: true, force: true }) })
  const { homeDir, workspaceDir } = provisionTenantHome({
    homeDir: join(root, 'home'),
    workspaceDir: join(root, 'workspace'),
    dshVersion: 'bff-e2e',
  })
  writeFileSync(join(homeDir, 'settings.yaml'), 'llm-deepseek:\n  protocol: chat-completions\n')
  return { homeDir, workspaceDir }
}

async function startBff(server0: MockLlmServer): Promise<PlatformServer> {
  const platform = await startPlatformServer({
    authenticator: devTokenAuthenticator(new Map([[TOKEN_A, 'alpha'], [TOKEN_B, 'beta']])),
    createRuntime: async (tenantId) => {
      const { homeDir, workspaceDir } = provisionTenantRoot(tenantId)
      return spawnAcpStdioRuntime(tenantId, {
        command: process.execPath,
        args: [dshBin, '--profile', 'acp'],
        cwd: workspaceDir,
        env: {
          ...process.env,
          DSH_HOME: homeDir,
          DSH_TELEMETRY_DISABLED: '1',
          DEEPSEEK_API_KEY: 'bff-e2e-key',
          DEEPSEEK_BASE_URL: server0.baseURL,
        },
      })
    },
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
  }, TEST_BUDGET_MS)
})
