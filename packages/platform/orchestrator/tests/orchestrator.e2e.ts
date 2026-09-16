import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { provisionTenantHome } from '@deepseek-ai/dsh-tenant-profile'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnAcpStdioRuntime, TenantRuntimeManager, type TenantRuntime } from '../src/index.ts'

/**
 * Orchestrator e2e against real spawned `dsh --profile acp` children: two
 * tenants with isolated provisioned homes, the concurrency cap queueing a
 * second tenant behind a live one, idle reaping of a real process, and
 * respawn on next use. Mock provider ports are OS-assigned and every tenant
 * root is a unique mkdtemp, so parallel CI workers cannot collide.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')
const TEST_BUDGET_MS = 120_000

const liveManagers: TenantRuntimeManager[] = []
const liveServers: MockLlmServer[] = []
const liveRoots: string[] = []

afterEach(async () => {
  while (liveManagers.length > 0) await liveManagers.pop()!.shutdown()
  while (liveServers.length > 0) await liveServers.pop()!.close()
  while (liveRoots.length > 0) rmSync(liveRoots.pop()!, { recursive: true, force: true })
})

function freshTenant(tenantId: string): { homeDir: string; workspaceDir: string } {
  const root = mkdtempSync(join(tmpdir(), `dsh-orch-${tenantId}-`))
  liveRoots.push(root)
  const { homeDir, workspaceDir } = provisionTenantHome({
    homeDir: join(root, 'home'),
    workspaceDir: join(root, 'workspace'),
    dshVersion: 'orch-e2e',
  })
  writeFileSync(join(homeDir, 'settings.yaml'), 'llm-deepseek:\n  protocol: chat-completions\n')
  return { homeDir, workspaceDir }
}

function managerFor(server: MockLlmServer, options: { maxConcurrent?: number; idleTimeoutMs?: number } = {}): TenantRuntimeManager {
  const manager = new TenantRuntimeManager({
    createRuntime: async (tenantId) => {
      const { homeDir, workspaceDir } = freshTenant(tenantId)
      return spawnAcpStdioRuntime(tenantId, {
        command: process.execPath,
        args: [dshBin, '--profile', 'acp'],
        cwd: workspaceDir,
        env: {
          ...process.env,
          DSH_HOME: homeDir,
          DSH_TELEMETRY_DISABLED: '1',
          DEEPSEEK_API_KEY: 'orch-e2e-key',
          DEEPSEEK_BASE_URL: server.baseURL,
        },
      })
    },
    maxConcurrent: options.maxConcurrent ?? 8,
    idleTimeoutMs: options.idleTimeoutMs ?? 5 * 60_000,
    disposeGraceMs: 5_000,
  })
  liveManagers.push(manager)
  return manager
}

async function promptRoundTrip(runtime: TenantRuntime, workspaceDir: string, text: string): Promise<void> {
  const session = await runtime.request<{ sessionId: string }>('session/new', {
    cwd: workspaceDir,
    mcpServers: [],
  })
  const result = await runtime.request<{ stopReason: string }>('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text }],
  })
  expect(result.stopReason).toBe('end_turn')
  await runtime.request('session/close', { sessionId: session.sessionId })
}

describe('TenantRuntimeManager over real spawned runtimes', () => {
  it('serves two tenants with isolated homes and reuses one process per tenant', async () => {
    const server = await startMockLlmServer({
      sequence: ['success'],
      apiKey: 'orch-e2e-key',
      successText: 'ORCH OK',
      repeatLast: true,
    })
    liveServers.push(server)
    const manager = managerFor(server)

    // Two rounds for alpha: the second must reuse the live process.
    const alphaHome = freshTenant('alpha')
    const betaHome = freshTenant('beta')
    await manager.withTenant('alpha', async rt => promptRoundTrip(rt, alphaHome.workspaceDir, 'alpha one'))
    await manager.withTenant('beta', async rt => promptRoundTrip(rt, betaHome.workspaceDir, 'beta one'))
    await manager.withTenant('alpha', async rt => promptRoundTrip(rt, alphaHome.workspaceDir, 'alpha two'))

    expect(manager.stats().live).toBe(2)
    expect(manager.stats().liveTenants).toEqual(['alpha', 'beta'])

    // Distinct tenant homes under distinct roots.
    expect(alphaHome.homeDir).not.toBe(betaHome.homeDir)
  }, TEST_BUDGET_MS)

  it('queues a second tenant behind the cap and evicts the idle one eagerly', async () => {
    const server = await startMockLlmServer({
      sequence: ['slow_success'],
      apiKey: 'orch-e2e-key',
      successText: 'QUEUED OK',
      repeatLast: true,
    })
    liveServers.push(server)
    const manager = managerFor(server, { maxConcurrent: 1 })

    const first = manager.withTenant('gamma', async rt => promptRoundTrip(rt, freshTenant('gamma').workspaceDir, 'gamma holds the slot'))
    const second = manager.withTenant('delta', async rt => promptRoundTrip(rt, freshTenant('delta').workspaceDir, 'delta waits'))
    await first

    // gamma's work finished; its idle entry is evicted to admit delta.
    await second
    expect(manager.stats().live).toBe(1)
    expect(manager.stats().liveTenants).toEqual(['delta'])
  }, TEST_BUDGET_MS)

  it('reaps an idle real process after the idle timeout and respawns on next use', async () => {
    const server = await startMockLlmServer({
      sequence: ['success'],
      apiKey: 'orch-e2e-key',
      successText: 'REAP OK',
      repeatLast: true,
    })
    liveServers.push(server)
    const manager = managerFor(server, { idleTimeoutMs: 2_000 })

    const epsilon = freshTenant('epsilon')
    await manager.withTenant('epsilon', async rt => promptRoundTrip(rt, epsilon.workspaceDir, 'epsilon first'))
    const firstRuntime = manager.peek('epsilon')
    expect(firstRuntime).toBeDefined()
    await firstRuntime!.exited()
    expect(manager.stats().live).toBe(0)

    await manager.withTenant('epsilon', async rt => promptRoundTrip(rt, epsilon.workspaceDir, 'epsilon again'))
    expect(manager.peek('epsilon')).toBeDefined()
    expect(manager.peek('epsilon')).not.toBe(firstRuntime)
  }, TEST_BUDGET_MS)
})
