import { afterEach, describe, expect, it, vi } from 'vitest'
import { TenantRuntimeManager, type TenantRuntime } from '../src/index.ts'

/**
 * Manager logic against fake runtimes: no processes, no I/O. Every fake keeps
 * its own state; nothing is shared between cases, so these stay stable under
 * CI concurrency. Real spawn coverage lives in the *.e2e.ts suite.
 */

function fakeRuntime(tenantId: string, log: string[]): TenantRuntime {
  return {
    tenantId,
    request: async <T>(method: string): Promise<T> => {
      log.push(`request:${tenantId}:${method}`)
      return undefined as T
    },
    onUpdate: () => () => {},
    onPermission: () => {},
    get lastUsedAt(): number {
      return Date.now()
    },
    dispose: async (graceMs: number) => {
      log.push(`dispose:${tenantId}:${graceMs}`)
    },
    exited: () => Promise.resolve(),
  }
}

function sleeperRuntime(tenantId: string, log: string[], ms: number): TenantRuntime {
  return {
    ...fakeRuntime(tenantId, log),
    request: async <T>(): Promise<T> => {
      log.push(`start:${tenantId}`)
      await new Promise(resolve => setTimeout(resolve, ms))
      log.push(`end:${tenantId}`)
      return undefined as T
    },
  }
}

const cleanup: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

describe('TenantRuntimeManager', () => {
  it('creates once and reuses for concurrent work on the same tenant', async () => {
    const log: string[] = []
    let created = 0
    const manager = new TenantRuntimeManager({
      createRuntime: async (tenantId) => {
        created += 1
        return sleeperRuntime(tenantId, log, 30)
      },
    })
    cleanup.push(() => manager.shutdown())

    await Promise.all([
      manager.withTenant('a', async rt => rt.request('x', {})),
      manager.withTenant('a', async rt => rt.request('x', {})),
    ])

    expect(created).toBe(1)
    expect(manager.stats().live).toBe(1)
  })

  it('enforces the concurrency cap and queues the overflow tenant', async () => {
    const log: string[] = []
    const manager = new TenantRuntimeManager({
      createRuntime: async tenantId => sleeperRuntime(tenantId, log, 40),
      maxConcurrent: 1,
    })
    cleanup.push(() => manager.shutdown())

    const first = manager.withTenant('a', async rt => rt.request('x', {}))
    const second = manager.withTenant('b', async rt => rt.request('x', {}))
    await first
    // While a held the slot, b could not start; under queue pressure a's
    // idle entry is evicted eagerly so b runs right after a's work ends.
    expect(log).not.toContain('start:b')

    await second
    expect(log.indexOf('end:a')).toBeLessThan(log.indexOf('start:b'))
  })

  it('fails a queued acquire after the queue timeout', async () => {
    vi.useFakeTimers()
    try {
      const manager = new TenantRuntimeManager({
        createRuntime: async tenantId => sleeperRuntime(tenantId, [], 60_000),
        maxConcurrent: 1,
        queueTimeoutMs: 50,
      })
      cleanup.push(() => manager.shutdown())

      const first = manager.withTenant('a', async rt => rt.request('x', {}))
      const second = manager.withTenant('b', async rt => rt.request('x', {}))
      // Attach the rejection handler before advancing the clock so the
      // timeout rejection is never momentarily unhandled.
      const secondExpectation = expect(second).rejects.toThrow(/queue timeout acquiring tenant "b"/)
      await vi.advanceTimersByTimeAsync(60)
      await secondExpectation

      await vi.advanceTimersByTimeAsync(60_000)
      await first
    } finally {
      vi.useRealTimers()
    }
  })

  it('reaps an idle runtime after the idle timeout and respawns on next use', async () => {
    vi.useFakeTimers()
    try {
      const log: string[] = []
      let created = 0
      const manager = new TenantRuntimeManager({
        createRuntime: async (tenantId) => {
          created += 1
          return fakeRuntime(tenantId, log)
        },
        idleTimeoutMs: 100,
      })
      cleanup.push(() => manager.shutdown())

      await manager.withTenant('a', async rt => rt.request('x', {}))
      expect(created).toBe(1)
      expect(manager.stats().live).toBe(1)

      await vi.advanceTimersByTimeAsync(150)
      expect(manager.stats().live).toBe(0)
      expect(log.some(entry => entry.startsWith('dispose:a'))).toBe(true)

      await manager.withTenant('a', async rt => rt.request('x', {}))
      expect(created).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a reused runtime alive across the idle window', async () => {
    vi.useFakeTimers()
    try {
      let created = 0
      const manager = new TenantRuntimeManager({
        createRuntime: async (tenantId) => {
          created += 1
          return fakeRuntime(tenantId, [])
        },
        idleTimeoutMs: 100,
      })
      cleanup.push(() => manager.shutdown())

      await manager.withTenant('a', async rt => rt.request('x', {}))
      await vi.advanceTimersByTimeAsync(50)
      await manager.withTenant('a', async rt => rt.request('x', {}))
      await vi.advanceTimersByTimeAsync(60)
      // Second use at t=50 cleared the timer; t=110 is within the new window.
      expect(manager.stats().live).toBe(1)
      expect(created).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shutdown drains everything and rejects later acquires', async () => {
    const log: string[] = []
    const manager = new TenantRuntimeManager({
      createRuntime: async tenantId => fakeRuntime(tenantId, log),
    })
    await manager.withTenant('a', async rt => rt.request('x', {}))
    await manager.shutdown()

    expect(manager.stats().live).toBe(0)
    expect(log.some(entry => entry.startsWith('dispose:a'))).toBe(true)
    await expect(manager.withTenant('a', async () => 1)).rejects.toThrow(/shut down/)
  })
})
