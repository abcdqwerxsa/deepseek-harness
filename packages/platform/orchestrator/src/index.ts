import { EventEmitter } from 'node:events'

/**
 * Tenant runtime manager for the multi-tenant platform.
 *
 * One ACP child process per tenant (`process = tenant`), spawned on first use,
 * reaped after an idle timeout, capped by a process-wide concurrency limit
 * with FIFO queueing. The manager owns process lifecycle only; the ACP client
 * wiring comes from an injectable factory so tests can substitute in-memory
 * connections and the BFF can compose the real stdio adapter.
 * @module @deepseek-ai/dsh-orchestrator
 */

/** One live tenant runtime connection, whatever transport it rides. */
export interface TenantRuntime {
  readonly tenantId: string
  /** ACP request passthrough (method path like `session/new`). */
  request<T>(method: string, params: unknown): Promise<T>
  /** Subscribe to `session/update` notifications; returns an unsubscribe. */
  onUpdate(listener: (sessionId: string, update: unknown) => void): () => void
  /**
   * Register the `session/request_permission` answerer. Exactly one answerer
   * may be live (the BFF's browser forwarder); replacing one drops it.
   */
  onPermission(handler: (request: unknown) => Promise<unknown>): void
  /** Last activity time (ms epoch), refreshed by every request. */
  readonly lastUsedAt: number
  /** Graceful stop: SIGTERM-shaped drain, escalating to a hard kill. */
  dispose(graceMs: number): Promise<void>
  /** Resolves when the underlying process/connection is gone. */
  exited(): Promise<void>
}

/** Factory the platform supplies to materialize one tenant runtime. */
export type TenantRuntimeFactory = (tenantId: string) => Promise<TenantRuntime>

export interface TenantRuntimeManagerOptions {
  /** Materialize one tenant's ACP connection (spawn + client wiring). */
  createRuntime: TenantRuntimeFactory
  /** Maximum simultaneously live tenant runtimes. Default 8. */
  maxConcurrent?: number
  /** Idle reaping delay after the last reference is released. Default 5 min. */
  idleTimeoutMs?: number
  /** How long a queued acquire waits before failing. Default 30 s. */
  queueTimeoutMs?: number
  /** Drain grace for SIGTERM-shaped disposal. Default 5 s. */
  disposeGraceMs?: number
}

export interface ManagerStats {
  readonly live: number
  readonly queued: number
  readonly liveTenants: readonly string[]
}

interface LiveEntry {
  runtime: TenantRuntime
  refs: number
  idleTimer: NodeJS.Timeout | undefined
}

interface SlotWaiter {
  readonly tenantId: string
  resolve: () => void
  timer: NodeJS.Timeout
}

/** One in-flight same-tenant spawn; late acquirers await its outcome. */
interface SpawnSlot {
  readonly promise: Promise<LiveEntry>
  resolve: (entry: LiveEntry) => void
  reject: (error: unknown) => void
}

/**
 * Manages the live-tenant table. Methods are safe to call concurrently; the
 * class is single-process by design — cross-host pooling is out of scope.
 */

export class TenantRuntimeManager {
  private readonly entries = new Map<string, LiveEntry>()
  private readonly waiters: SlotWaiter[] = []
  private readonly options: Required<Omit<TenantRuntimeManagerOptions, 'createRuntime'>> & { createRuntime: TenantRuntimeFactory }
  /** Spawns in flight reserve their capacity slot synchronously. */
  private pendingSpawns = 0
  /** Per-tenant in-flight spawns, so concurrent acquires never double-spawn. */
  private readonly spinning = new Map<string, SpawnSlot>()
  private shutDown = false

  constructor(options: TenantRuntimeManagerOptions) {
    this.options = {
      createRuntime: options.createRuntime,
      maxConcurrent: options.maxConcurrent ?? 8,
      idleTimeoutMs: options.idleTimeoutMs ?? 5 * 60_000,
      queueTimeoutMs: options.queueTimeoutMs ?? 30_000,
      disposeGraceMs: options.disposeGraceMs ?? 5_000,
    }
  }

  /**
   * Run `work` with the tenant's runtime, spawning on demand (queued behind
   * the concurrency cap). The runtime stays live until the last concurrent
   * `withTenant` for it settles and the idle timer elapses.
   */
  async withTenant<T>(tenantId: string, work: (runtime: TenantRuntime) => Promise<T>): Promise<T> {
    if (this.shutDown) throw new Error('orchestrator: manager is shut down')
    const runtime = await this.acquire(tenantId)
    try {
      return await work(runtime)
    } finally {
      this.release(tenantId)
    }
  }

  /** Live runtime for a tenant, or undefined. Tests and BFF introspection. */
  peek(tenantId: string): TenantRuntime | undefined {
    return this.entries.get(tenantId)?.runtime
  }

  stats(): ManagerStats {
    return { live: this.entries.size, queued: this.waiters.length, liveTenants: [...this.entries.keys()] }
  }

  /** Stop everything: clear timers, drain waiters, dispose live runtimes. */
  async shutdown(): Promise<void> {
    this.shutDown = true
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
    }
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map(entry => this.disposeEntry(entry)))
  }

  private async acquire(tenantId: string): Promise<TenantRuntime> {
    const attachExisting = (entry: LiveEntry): TenantRuntime => {
      this.attach(entry)
      return entry.runtime
    }

    const existing = this.entries.get(tenantId)
    if (existing !== undefined) return attachExisting(existing)

    const inflight = this.spinning.get(tenantId)
    if (inflight !== undefined) {
      const entry = await inflight.promise
      return attachExisting(entry)
    }

    while (!this.hasCapacity()) await this.waitForSlot(tenantId)
    // The wait may have admitted a same-tenant spawn or entry; recheck both.
    const reEntry = this.entries.get(tenantId)
    if (reEntry !== undefined) return attachExisting(reEntry)
    const reflight = this.spinning.get(tenantId)
    if (reflight !== undefined) {
      const entry = await reflight.promise
      return attachExisting(entry)
    }

    const slot = this.emptySlot(tenantId)
    this.pendingSpawns += 1
    try {
      const runtime = await this.options.createRuntime(tenantId)
      const entry: LiveEntry = { runtime, refs: 0, idleTimer: undefined }
      if (this.shutDown) {
        await this.disposeEntry(entry)
        throw new Error('orchestrator: manager is shut down')
      }
      this.entries.set(tenantId, entry)
      slot.resolve(entry)
      return attachExisting(entry)
    } catch (error) {
      slot.reject(error)
      throw error
    } finally {
      this.pendingSpawns -= 1
      this.spinning.delete(tenantId)
      this.drainWaiters()
    }
  }

  private emptySlot(tenantId: string): SpawnSlot {
    let resolve!: (entry: LiveEntry) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<LiveEntry>((res, rej) => {
      resolve = res
      reject = rej
    })
    const slot: SpawnSlot = { promise, resolve, reject }
    this.spinning.set(tenantId, slot)
    return slot
  }

  private attach(entry: LiveEntry): void {
    entry.refs += 1
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
  }

  private release(tenantId: string): void {
    const entry = this.entries.get(tenantId)
    if (entry === undefined) return
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs === 0 && entry.idleTimer === undefined) {
      entry.idleTimer = setTimeout(() => { this.evict(tenantId, entry) }, this.options.idleTimeoutMs)
      entry.idleTimer.unref()
    }
    this.drainWaiters()
  }

  private evict(tenantId: string, entry: LiveEntry): void {
    if (entry.refs > 0 || this.entries.get(tenantId) !== entry) return
    this.entries.delete(tenantId)
    void this.disposeEntry(entry).then(() => { this.drainWaiters() }, () => { this.drainWaiters() })
  }

  private findIdleTenant(): string | undefined {
    for (const [tenantId, entry] of this.entries) {
      if (entry.refs === 0) return tenantId
    }
    return undefined
  }

  private hasCapacity(): boolean {
    return this.entries.size + this.pendingSpawns < this.options.maxConcurrent
  }

  private waitForSlot(tenantId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: SlotWaiter = {
        tenantId,
        resolve: () => {
          clearTimeout(waiter.timer)
          resolve()
        },
        timer: undefined as unknown as NodeJS.Timeout,
      }
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new Error(`orchestrator: queue timeout acquiring tenant ${JSON.stringify(tenantId)}`))
      }, this.options.queueTimeoutMs)
      waiter.timer.unref()
      this.waiters.push(waiter)
    })
  }

  private drainWaiters(): void {
    while (this.waiters.length > 0) {
      if (this.hasCapacity()) {
        const waiter = this.waiters.shift()
        if (waiter !== undefined) waiter.resolve()
        continue
      }
      // Full: idle-but-live processes still consume real capacity. Under
      // queue pressure, evict one eagerly instead of making the waiter sit
      // through the whole idle-timeout window; the idle cache only matters
      // when nobody is queued.
      const idleTenant = this.findIdleTenant()
      if (idleTenant === undefined) break
      const idleEntry = this.entries.get(idleTenant)
      if (idleEntry !== undefined) this.evict(idleTenant, idleEntry)
    }
  }

  private async disposeEntry(entry: LiveEntry): Promise<void> {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    try {
      await entry.runtime.dispose(this.options.disposeGraceMs)
    } catch {
      // Disposal best effort; the runtime's own exited() promise is the truth.
    }
  }
}

/**
 * Fan-out hub shared by the stdio adapter implementation: listeners for
 * session updates plus at most one permission answerer. Fail-closed default:
 * an unanswered permission request resolves to `cancelled`.
 */
export class AcpEventHub extends EventEmitter {
  private permissionHandler: ((request: unknown) => Promise<unknown>) | undefined

  constructor() {
    super()
    // One browser socket per platform view subscribes to updates; warn
    // ceilings tuned for per-session fan-out, not per-listener runaway.
    this.setMaxListeners(64)
  }

  onUpdate(listener: (sessionId: string, update: unknown) => void): () => void {
    const wrapped = (sessionId: string, update: unknown): void => { listener(sessionId, update) }
    this.on('update', wrapped)
    return () => { this.off('update', wrapped) }
  }

  onPermission(handler: (request: unknown) => Promise<unknown>): void {
    this.permissionHandler = handler
  }

  emitUpdate(sessionId: string, update: unknown): void {
    this.emit('update', sessionId, update)
  }

  async answerPermission(request: unknown): Promise<unknown> {
    if (this.permissionHandler === undefined) return { outcome: { outcome: 'cancelled' } }
    return this.permissionHandler(request)
  }
}

export { spawnAcpStdioRuntime, type StdioRuntimeSpec } from './stdio.ts'
