import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpEventHub, TenantRuntimeManager, type TenantRuntime } from '../src/index.ts'

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
    // A live process never settles exited(); matching that in fakes keeps the
    // manager's exit watcher meaningful instead of instantly dropping entries.
    exited: () => new Promise<void>(() => {}),
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

  it('rejects withTenant when the spawn fails and retries fresh', async () => {
    const failures: string[] = []
    let attempts = 0
    const manager = new TenantRuntimeManager({
      createRuntime: async (tenantId) => {
        attempts += 1
        if (attempts === 1) throw new Error('spawn exploded')
        return fakeRuntime(tenantId, failures)
      },
    })
    cleanup.push(() => manager.shutdown())

    await expect(manager.withTenant('a', async rt => rt.request('x', {})))
      .rejects.toThrow('spawn exploded')
    // The failed spawn left no live entry; the next attempt spawns fresh.
    await manager.withTenant('a', async rt => rt.request('x', {}))
    expect(attempts).toBe(2)
    expect(manager.stats().live).toBe(1)
  })

  it('rejects a queued acquire when the manager shuts down', async () => {
    const manager = new TenantRuntimeManager({
      createRuntime: async tenantId => sleeperRuntime(tenantId, [], 10_000),
      maxConcurrent: 1,
    })
    cleanup.push(() => manager.shutdown())

    const first = manager.withTenant('a', async rt => rt.request('x', {}))
    const secondExpectation = expect(manager.withTenant('b', async () => 1))
      .rejects.toThrow(/shut down/)
    await manager.shutdown()
    await secondExpectation
    // The shutdown above ran twice (cleanup holds another call); both idempotent.
    await first.catch(() => {})
  })

  it('eagerly evicts an idle entry when a new tenant enqueues against a full table', async () => {
    const log: string[] = []
    const manager = new TenantRuntimeManager({
      createRuntime: async tenantId => fakeRuntime(tenantId, log),
      maxConcurrent: 1,
      idleTimeoutMs: 60_000,
      queueTimeoutMs: 1_000,
    })
    cleanup.push(() => manager.shutdown())

    // 'a' finished its work: live but idle, holding the only slot.
    await manager.withTenant('a', async rt => rt.request('x', {}))
    expect(manager.stats().live).toBe(1)

    // A new tenant enqueues; without enqueue-driven eviction this would
    // queue-timeout long before the 60s idle window elapses.
    await manager.withTenant('b', async rt => rt.request('x', {}))
    expect(manager.stats().liveTenants).toEqual(['b'])
    expect(log.some(entry => entry.startsWith('dispose:a'))).toBe(true)
  })

  it('drops a runtime from the table once it exits, so reacquire spawns fresh', async () => {
    let created = 0
    let exitFirst: (() => void) | undefined
    const manager = new TenantRuntimeManager({
      createRuntime: async (tenantId) => {
        created += 1
        const exited = new Promise<void>((resolve) => { exitFirst = resolve })
        return {
          ...fakeRuntime(tenantId, []),
          exited: () => exited,
        }
      },
      idleTimeoutMs: 60_000,
    })
    cleanup.push(() => manager.shutdown())

    await manager.withTenant('a', async rt => rt.request('x', {}))
    expect(created).toBe(1)
    // The runtime dies while still live in the table.
    exitFirst!()
    await vi.waitFor(() => { expect(manager.stats().live).toBe(0) })

    await manager.withTenant('a', async rt => rt.request('x', {}))
    expect(created).toBe(2)
  })

  it('degrades a throwing permission answerer to cancelled', async () => {
    const hub = new AcpEventHub()
    hub.onPermission(async () => { throw new Error('BFF exploded') })
    await expect(hub.answerPermission({ options: [] })).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
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
