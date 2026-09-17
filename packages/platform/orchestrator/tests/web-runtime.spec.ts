import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { spawnWebRuntime, WebRuntimeManager, type WebRuntime } from '../src/web-runtime.ts'

/**
 * WebRuntimeManager behavior with real TCP children (a throwaway node:http
 * server standing in for `dsh web`): on-demand spawn, reference counting,
 * idle reaping, and pool accounting. No bwrap or CLI here — spawn-shape
 * coverage of the real `dsh web` child lives in the BFF e2e.

 */

const cleanupFns: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanupFns.length > 0) await cleanupFns.pop()!()
  vi.useRealTimers()
})

afterAll(() => {
  while (cleanupFns.length > 0) void cleanupFns.pop()!()
})

/** A minimal "dsh web" child: listens, prints a readiness line with token. */
async function fakeWebChild(port: number, launchToken: string | undefined): Promise<WebRuntime> {
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/plain' }); response.end('ok') })
  await new Promise<void>((resolve) => { server.listen(port, '127.0.0.1', () => { resolve() }) })
  if (launchToken !== undefined) process.stdout.write(`dsh web: http://127.0.0.1:${String(port)}/?token=${launchToken}\n`)
  const address = server.address() as AddressInfo
  let disposed = false
  return {
    key: '',
    port: address.port,
    launchToken,
    lastUsedAt: Date.now(),
    dispose: async () => {
      if (disposed) return
      disposed = true
      await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    },
    exited: () => new Promise<void>(() => {}),
  }
}

describe('WebRuntimeManager', () => {
  it('spawns on demand and reuses the live runtime for concurrent acquires', async () => {
    const spawns: string[] = []
    const manager = new WebRuntimeManager({
      createRuntime: async (key, port) => {
        spawns.push(key)
        return fakeWebChild(port, 'tok-1')
      },
      portMin: 19_000,
      portMax: 19_010,
      idleTimeoutMs: 60 * 60_000,
    })
    cleanupFns.push(() => manager.shutdown())

    const first = await manager.acquire('deptA/user1')
    const second = await manager.acquire('deptA/user1')
    expect(second).toBe(first)
    expect(spawns).toEqual(['deptA/user1'])
    expect(manager.stats()).toEqual({ live: 1, liveKeys: ['deptA/user1'] })

    manager.release('deptA/user1')
    manager.release('deptA/user1')
    // Both references released but idle window not elapsed: still live.
    expect(manager.peek('deptA/user1')).toBeDefined()
  })

  it('reaps a runtime after the idle window once every reference is released', async () => {
    vi.useFakeTimers()
    const disposes: string[] = []
    const manager = new WebRuntimeManager({
      createRuntime: async (key, port) => {
        const runtime = await fakeWebChild(port, undefined)
        return { ...runtime, dispose: async (graceMs: number) => { disposes.push(key); await runtime.dispose(graceMs) } }
      },
      portMin: 19_020,
      portMax: 19_030,
      idleTimeoutMs: 1_000,
    })
    cleanupFns.push(() => manager.shutdown())

    await manager.acquire('deptB/user2')
    manager.release('deptB/user2')
    expect(disposes).toEqual([])
    vi.advanceTimersByTime(1_100)
    await vi.waitFor(() => { expect(disposes).toEqual(['deptB/user2']) })
    expect(manager.peek('deptB/user2')).toBeUndefined()
  })

  it('does not reuse a port while its runtime is live or spawning', async () => {
    const ports: number[] = []
    const manager = new WebRuntimeManager({
      createRuntime: async (_key, port) => {
        ports.push(port)
        return fakeWebChild(port, undefined)
      },
      portMin: 19_040,
      portMax: 19_041,
      idleTimeoutMs: 60 * 60_000,
    })
    cleanupFns.push(() => manager.shutdown())
    const a = await manager.acquire('d/u1')
    const b = await manager.acquire('d/u2')
    expect(new Set([a.port, b.port]).size).toBe(2)
    expect(ports).toHaveLength(2)
  })
})

describe('spawnWebRuntime', () => {
  it('waits for the port and captures the launch token from stdout', async () => {
    // A real child process whose stdout carries the token line only after
    // the server listens (mirrors dsh web's readiness ordering).
    const child = `const { createServer } = require('node:http')
const server = createServer((_q, res) => { res.end('ok') })
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  process.stdout.write('dsh web: http://127.0.0.1/' + port + '/?token=abc123_-\\n')
})`
    const port = 19_100
    const runtime = await spawnWebRuntime('dept/user', port, {
      command: process.execPath,
      args: ['-e', `const s = require('node:http').createServer((_q, res) => res.end('ok')); s.listen(${String(port)}, '127.0.0.1', () => process.stdout.write('dsh web: http://127.0.0.1/?token=abc123_-\\n'))`],
      cwd: process.cwd(),
      env: {},
    })
    cleanupFns.push(() => runtime.dispose(500))
    expect(runtime.port).toBe(port)
    await vi.waitFor(() => { expect(runtime.launchToken).toBe('abc123_-') })
    void child
  })

  it('rejects when the child never announces readiness', async () => {
    await expect(spawnWebRuntime('dept/user', 19_101, {
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
      env: {},
    }, 800)).rejects.toThrow('printed no readiness line')
  })
})
