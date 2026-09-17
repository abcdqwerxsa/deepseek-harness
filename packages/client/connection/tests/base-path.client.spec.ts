import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebConnectionRpc } from '../src/client/rpc.ts'

/**
 * URL resolution of the browser RPC caller: served pages carry `<base
 * href>`, so a subpath mount (`/u/<dept>/<user>/`) must resolve API posts
 * under its prefix while the standalone root mount keeps `/api/...`.
 */

interface FetchGlobal { document?: { baseURI: string } }

afterEach(() => {
  delete (globalThis as FetchGlobal).document
})

function echoFetch(): { mock: ReturnType<typeof vi.fn>; rpc: ReturnType<typeof createWebConnectionRpc> } {
  const fn = vi.fn(async (input: URL, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { rpcId: string }
    return {
      ok: true,
      json: async () => ({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: 7 } }),
    }
  })
  const rpc = createWebConnectionRpc(fn as unknown as Parameters<typeof createWebConnectionRpc>[0])
  return { mock: fn, rpc }
}

describe('subpath-aware API resolution', () => {
  it('resolves calls against document.baseURI on a subpath mount', async () => {
    ;(globalThis as FetchGlobal).document = { baseURI: 'https://corp.example:8443/u/deptA/user1/' }
    const { mock, rpc } = echoFetch()
    await rpc.call('/api', 'goals/create', { label: 'x' })
    expect(mock.mock.calls[0]?.[0]).toEqual(new URL('https://corp.example:8443/u/deptA/user1/api/goals/create'))
  })

  it('keeps the standalone root mount on /api', async () => {
    ;(globalThis as FetchGlobal).document = { baseURI: 'http://localhost:5173/' }
    const { mock, rpc } = echoFetch()
    await rpc.call('/api', 'goals/create', { label: 'x' })
    expect(mock.mock.calls[0]?.[0]).toEqual(new URL('http://localhost:5173/api/goals/create'))
  })
})
