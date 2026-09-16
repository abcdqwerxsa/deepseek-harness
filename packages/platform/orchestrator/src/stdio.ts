import { Readable, Writable } from 'node:stream'
import {
  client as createAcpClientApp,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk'
import { execa } from 'execa'
import { AcpEventHub, type TenantRuntime } from './index.ts'

/**
 * Spawn adapter: one real `dsh --profile acp` child wired to an ACP client
 * over ndJson stdio. The platform supplies the full child spec — command,
 * args, cwd, and a complete environment — so model-key injection stays in the
 * composition layer and never lands in this package.
 * @module
 */

/** Full child-process specification for one tenant runtime. */
export interface StdioRuntimeSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

/**
 * Spawn and initialize one tenant ACP runtime. Resolves after the ACP
 * `initialize` handshake; rejects if the child dies or the handshake fails.
 */
export async function spawnAcpStdioRuntime(tenantId: string, spec: StdioRuntimeSpec): Promise<TenantRuntime> {
  // buffer:false keeps execa from collecting the child's whole stdout in
  // memory (and from killing the child at its default 100 MB maxBuffer on a
  // long-lived streaming runtime); this adapter owns stdout reading itself.
  const child = execa(spec.command, [...spec.args], {
    cwd: spec.cwd,
    reject: false,
    killSignal: 'SIGKILL',
    buffer: false,
    env: { ...spec.env },
    extendEnv: false,
  })
  const hub = new AcpEventHub()
  const passthrough = new Readable({ read() {} })
  child.stdout.on('data', (chunk: Buffer) => {
    passthrough.push(chunk)
  })
  child.stdout.on('end', () => { passthrough.push(null) })
  const clientApp = createAcpClientApp({ name: 'dsh-platform-orchestrator' })
    .onNotification(methods.client.session.update, ({ params }) => {
      hub.emitUpdate(params.sessionId, params.update)
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission,
      ({ params }) => hub.answerPermission(params) as unknown as RequestPermissionResponse)
  const client = clientApp.connect(ndJsonStream(
    Writable.toWeb(child.stdin),
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- tsc 5 requires this cast; typescript-go disagrees
    Readable.toWeb(passthrough) as ReadableStream<Uint8Array>,
  )).agent

  const exited: Promise<void> = child.then(() => undefined, () => undefined)
  let lastUsedAt = Date.now()
  let disposed = false
  const runtime: TenantRuntime = {
    tenantId,
    get lastUsedAt(): number {
      return lastUsedAt
    },
    request<T>(method: string, params: unknown): Promise<T> {
      if (disposed) return Promise.reject(new Error(`orchestrator: tenant ${JSON.stringify(tenantId)} runtime is disposed`))
      lastUsedAt = Date.now()
      // oxlint-disable-next-line typescript/no-unnecessary-type-assertion -- tsc 5 requires this cast; typescript-go disagrees
      return client.request(method, params) as Promise<T>
    },
    onUpdate(listener): () => void {
      return hub.onUpdate(listener)
    },
    onPermission(handler): void {
      hub.onPermission(handler)
    },
    async dispose(graceMs: number): Promise<void> {
      if (disposed) return
      disposed = true
      // stdin EOF is dsh's primary quiesce path; escalate if the drain stalls.
      child.stdin.end()
      const escalate: Promise<void> = delay(graceMs)
        .then(() => { child.kill('SIGTERM'); return delay(graceMs) })
        .then(() => { child.kill('SIGKILL') })
      await Promise.race([exited, escalate])
      await exited
    },
    exited(): Promise<void> {
      return exited
    },
  }

  try {
    await runtime.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })
  } catch (error) {
    await runtime.dispose(1_000)
    throw error
  }
  return runtime
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve() }, ms)
    timer.unref()
  })
}
