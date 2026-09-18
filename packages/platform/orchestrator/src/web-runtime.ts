import { execa } from 'execa'

/**
 * On-demand `dsh web` runtime management: one sandboxed web child per
 * `(deptId, userId)` key, spawned on first request on a port from a fixed
 * pool, and reaped after an idle window with no open requests or tunnels.
 * The manager owns process lifecycle only; the spawn spec (command, bwrap
 * prefix, environment, model-gateway token) is composed by the platform's
 * compose layer, exactly as for ACP runtimes.
 * @module @deepseek-ai/dsh-orchestrator
 */

/** Full child-process specification for one user's web runtime. */
export interface WebRuntimeSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/** One live `dsh web` child listening on its assigned local port. */
export interface WebRuntime {
  /** Owning composite key `${deptId}/${userId}`. */
  readonly key: string
  /** Locally assigned listen port the proxy forwards to. */
  readonly port: number
  /**
   * Launch token parsed from the child's readiness line, or undefined when
   * the child printed none. One presentation of it mints the browser's
   * dsh-auth cookie through the proxy; the cookie itself survives restarts.
   */
  readonly launchToken: string | undefined
  /** Last activity time (ms epoch). */
  readonly lastUsedAt: number
  /** Graceful stop: SIGTERM drain escalating to a hard kill. */
  dispose(graceMs: number): Promise<void>
  /** Resolves when the underlying process is gone. */
  exited(): Promise<void>
}

/** Spawn and await readiness of one user's `dsh web` child. */
export type WebRuntimeFactory = (key: string, port: number) => Promise<WebRuntime>

export interface WebRuntimeManagerOptions {
  /** Materialize one user's web child (spawn + readiness wait). */
  createRuntime: WebRuntimeFactory
  /** Inclusive port-pool bounds for assigned listen ports. Default 18000. */
  readonly portMin?: number
  /** Inclusive port-pool bounds for assigned listen ports. Default 18999. */
  readonly portMax?: number
  /** Idle reaping delay after the last reference is released. Default 10 min. */
  readonly idleTimeoutMs?: number
  /** Drain grace for disposal. Default 5 s. */
  readonly disposeGraceMs?: number
}

export interface WebManagerStats {
  readonly live: number
  readonly liveKeys: readonly string[]
}

interface LiveEntry {
  runtime: WebRuntime
  refs: number
  idleTimer: NodeJS.Timeout | undefined
}

/** One in-flight same-key spawn; late acquirers await its outcome. */
interface SpawnSlot {
  readonly promise: Promise<LiveEntry>
  readonly port: number
}

const ANNOUNCE_LINE = /^dsh web: (https?:\/\/\S+)/

/** Extract the launch token from an announced readiness URL. */
function tokenOf(url: string): string | undefined {
  return /[?&]token=([A-Za-z0-9_-]+)/.exec(url)?.[1]
}

/**
 * Spawn a `dsh web` child per `spec` and resolve once it announces
 * readiness (`dsh web: <authenticated url>` on stdout — printed after the
 * child's Loader settles, so every route is mounted before the first
 * forwarded request). The URL's launch token is captured for the cookie
 * mint; a child that exits or stays silent past the timeout fails the spawn.
 */
export async function spawnWebRuntime(
  key: string,
  port: number,
  spec: WebRuntimeSpec,
  startupTimeoutMs = 120_000,
): Promise<WebRuntime> {
  // buffer:false: a long-lived web server must not accumulate stdout (nor
  // hit execa's default maxBuffer); this helper scans lines as they stream.
  const child = execa(spec.command, [...spec.args], {
    cwd: spec.cwd,
    reject: false,
    killSignal: 'SIGKILL',
    buffer: false,
    env: { ...spec.env },
    extendEnv: false,
  })
  let launchToken: string | undefined
  // Last stderr tail for spawn-failure diagnostics: a child that dies before
  // readiness must explain itself in the thrown error.
  let stderrTail = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = `${stderrTail}${chunk.toString('utf8')}`.slice(-2_000)
  })
  const announced = new Promise<string>((resolve, reject) => {
    let buffer = ''
    const scan = (chunk: string): void => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        // The readiness line prints only after the child's Loader settles —
        // later than the TCP listen, which is exactly the ordering the
        // proxy needs (routes mounted before the first forwarded request).
        const match = ANNOUNCE_LINE.exec(line.trim())
        const url = match?.[1]
        if (url !== undefined) resolve(url)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => { scan(chunk.toString('utf8')) })
    const timeout = setTimeout(
      () => { reject(new Error(`web-runtime: child for ${JSON.stringify(key)} printed no readiness line within ${String(startupTimeoutMs)}ms`)) },
      startupTimeoutMs,
    )
    timeout.unref()
  })
  const exited: Promise<void> = child.then(() => undefined, () => undefined)
  const runtime: WebRuntime = {
    key,
    port,
    get launchToken(): string | undefined {
      return launchToken
    },
    get lastUsedAt(): number {
      return Date.now()
    },
    async dispose(graceMs: number): Promise<void> {
      child.kill('SIGTERM')
      const escalate: Promise<void> = delay(graceMs).then(() => { child.kill('SIGKILL') })
      await Promise.race([exited, escalate])
      await exited
    },
    exited(): Promise<void> {
      return exited
    },
  }
  try {
    await Promise.race([
      announced.then((url) => { launchToken = tokenOf(url) }),
      exited.then(() => {
        throw new Error(`web-runtime: child for ${JSON.stringify(key)} exited before announcing readiness on port ${String(port)}${stderrTail === '' ? '' : `: ${stderrTail.trim()}`}`)
      }),
    ])
  } catch (error) {
    await runtime.dispose(1_000)
    throw error
  }
  return runtime
}

/** Manages the live web-runtime table; concurrent calls are safe. */
export class WebRuntimeManager {
  private readonly entries = new Map<string, LiveEntry>()
  private readonly spinning = new Map<string, SpawnSlot>()
  private readonly options: Required<Omit<WebRuntimeManagerOptions, 'createRuntime'>> & { createRuntime: WebRuntimeFactory }
  private shutDown = false

  constructor(options: WebRuntimeManagerOptions) {
    this.options = {
      createRuntime: options.createRuntime,
      portMin: options.portMin ?? 18_000,
      portMax: options.portMax ?? 18_999,
      idleTimeoutMs: options.idleTimeoutMs ?? 10 * 60_000,
      disposeGraceMs: options.disposeGraceMs ?? 5_000,
    }
  }

  /**
   * Get (spawning on demand) the user's web runtime. The runtime stays live
   * until the matching {@link release} and the idle window elapse; callers
   * hold one reference per in-flight request or open tunnel.
   */
  async acquire(key: string): Promise<WebRuntime> {
    if (this.shutDown) throw new Error('web-runtime: manager is shut down')
    const existing = this.entries.get(key)
    if (existing !== undefined) {
      this.attach(existing)
      return existing.runtime
    }
    const inflight = this.spinning.get(key)
    if (inflight !== undefined) {
      const entry = await inflight.promise
      this.attach(entry)
      return entry.runtime
    }
    const port = this.nextPort()
    const promise = (async () => {
      try {
        const runtime = await this.options.createRuntime(key, port)
        const entry: LiveEntry = { runtime, refs: 0, idleTimer: undefined }
        if (this.shutDown) {
          await this.disposeEntry(entry)
          throw new Error('web-runtime: manager is shut down')
        }
        this.entries.set(key, entry)
        void runtime.exited().then(() => {
          if (this.entries.get(key) === entry) this.entries.delete(key)
        })
        return entry
      } finally {
        this.spinning.delete(key)
      }
    })()
    // The creator never awaits this promise; without the no-op handler a
    // spawn failure with no same-key joiner would crash the host process.
    promise.catch(() => {})
    this.spinning.set(key, { promise, port })
    const entry = await promise
    this.attach(entry)
    return entry.runtime
  }

  /** Release one {@link acquire} reference. */
  release(key: string): void {
    const entry = this.entries.get(key)
    if (entry === undefined) return
    entry.refs = Math.max(0, entry.refs - 1)
    if (entry.refs === 0 && entry.idleTimer === undefined) {
      entry.idleTimer = setTimeout(() => { this.evict(key, entry) }, this.options.idleTimeoutMs)
      entry.idleTimer.unref()
    }
  }

  /** Live runtime for a user, or undefined. Introspection and diagnostics. */
  peek(key: string): WebRuntime | undefined {
    return this.entries.get(key)?.runtime
  }

  stats(): WebManagerStats {
    return { live: this.entries.size, liveKeys: [...this.entries.keys()] }
  }

  /** Stop everything: clear timers, dispose live runtimes. */
  async shutdown(): Promise<void> {
    this.shutDown = true
    const entries = [...this.entries.values()]
    this.entries.clear()
    await Promise.all(entries.map(entry => this.disposeEntry(entry)))
  }

  private attach(entry: LiveEntry): void {
    entry.refs += 1
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer)
      entry.idleTimer = undefined
    }
  }

  private evict(key: string, entry: LiveEntry): void {
    if (entry.refs > 0 || this.entries.get(key) !== entry) return
    this.entries.delete(key)
    void this.disposeEntry(entry)
  }

  private async disposeEntry(entry: LiveEntry): Promise<void> {
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer)
    try {
      await entry.runtime.dispose(this.options.disposeGraceMs)
    } catch {
      // Disposal best effort; the runtime's own exited() promise is the truth.
    }
  }

  /**
   * Next free pool port. ponytail: linear scan over live and in-flight
   * ports per spawn — fine for internal scale; a bitmap becomes worthwhile
   * when spawn rates hurt. A later collision (another service grabbed the
   * port first) fails the child's readiness wait loudly.
   */
  private nextPort(): number {
    const span = this.options.portMax - this.options.portMin + 1
    if (span <= 0) throw new Error('web-runtime: empty port pool')
    const taken = new Set<number>([...this.entries.values()].map(entry => entry.runtime.port))
    for (const slot of this.spinning.values()) taken.add(slot.port)
    for (let offset = 0; offset < span; offset += 1) {
      const port = this.options.portMin + (offset * 7919) % span
      if (!taken.has(port)) return port
    }
    throw new Error(`web-runtime: port pool exhausted (${String(this.options.portMin)}-${String(this.options.portMax)})`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve() }, ms)
    timer.unref()
  })
}
