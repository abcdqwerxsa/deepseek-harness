import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM, VirtualConsole } from 'jsdom'
import { EventEmitter } from 'node:events'
import { devTokenAuthenticator } from '../src/auth.ts'
import { startPlatformServer, type PlatformServer } from '../src/index.ts'
import type { TenantRuntime } from '@deepseek-ai/dsh-orchestrator'

/**
 * Portal page end to end inside JSDOM: the real HTML and portal.js are
 * fetched from a live BFF with a fake tenant runtime, so the wiring under
 * test is exactly what a browser runs — token connect, session list, new
 * session, prompt echo plus streamed reply, and a clickable permission card.
 */

const TOKEN = 'portal-token'

class FakeRuntimeHub extends EventEmitter {
  permissionHandler: ((request: unknown) => Promise<unknown>) | undefined
  updateListener: ((sessionId: string, update: unknown) => void) | undefined

  emitUpdate(sessionId: string, update: unknown): void {
    this.updateListener?.(sessionId, update)
  }
}

const cleanupFns: Array<() => Promise<void> | void> = []
const liveDoms: JSDOM[] = []

afterEach(async () => {
  while (liveDoms.length > 0) liveDoms.pop()!.window.close()
  while (cleanupFns.length > 0) await cleanupFns.pop()!()
})

async function startPortalStack(hub: FakeRuntimeHub): Promise<PlatformServer> {
  const server = await startPlatformServer({
    authenticator: devTokenAuthenticator(new Map([[TOKEN, 'alpha']])),
    createRuntime: async (tenantId) => {
      const runtime: TenantRuntime = {
        tenantId,
        request: async <T>(method: string): Promise<T> => {
          if (method === 'session/new') return { sessionId: 'sess-portal' } as T
          if (method === 'session/prompt') {
            hub.emitUpdate('sess-portal', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'PORTAL ' } })
            hub.emitUpdate('sess-portal', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLY' } })
            return { stopReason: 'end_turn' } as T
          }
          if (method === 'session/list') return { sessions: [{ sessionId: 'sess-portal', cwd: '/ws/alpha' }] } as T
          if (method === 'session/close' || method === 'session/resume') return {} as T
          throw new Error(`portal fake: unsupported method ${method}`)
        },
        onUpdate: (listener) => {
          hub.updateListener = listener
          return () => { hub.updateListener = undefined }
        },
        onPermission: (handler) => { hub.permissionHandler = handler },
        get lastUsedAt(): number {
          return Date.now()
        },
        dispose: async () => {},
        exited: () => new Promise<void>(() => {}),
      }
      return runtime
    },
  })
  cleanupFns.push(() => server.close())
  return server
}

async function openPortal(server: PlatformServer): Promise<JSDOM> {
  const base = `http://127.0.0.1:${server.port}`
  const html = await (await fetch(`${base}/`)).text()
  const pageErrors: unknown[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => { pageErrors.push(error) })
  const dom = new JSDOM(html, {
    url: `${base}/`,
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole,
    beforeParse: (window) => {
      // jsdom ships no fetch; route the portal's relative calls to the live
      // server through Node's fetch.
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url, `${base}/`).toString(), init)
    },
  })
  ;(dom as JSDOM & { pageErrors: unknown[] }).pageErrors = pageErrors
  liveDoms.push(dom)
  return dom
}

describe('tenant portal page', () => {
  it('connects, drives a session, streams a reply, and answers a permission card', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startPortalStack(hub)
    const dom = await openPortal(server)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__tenantPortal).toBeDefined() })
    expect(doc.getElementById('composer')!.hidden).toBe(true)

    const tokenInput = doc.getElementById('token') as HTMLInputElement
    tokenInput.value = TOKEN
    doc.getElementById('connect')!.click()
    await vi.waitFor(() => { expect(doc.getElementById('status')!.textContent).toBe('已连接') })

    ;(doc.getElementById('cwd') as HTMLInputElement).value = '/ws/alpha'
    doc.getElementById('new-session')!.click()
    await vi.waitFor(() => { expect(doc.getElementById('composer')!.hidden).toBe(false) })
    // The registry lists the fresh session immediately (live runtime included).
    await vi.waitFor(() => { expect(doc.querySelector('[data-session-id="sess-portal"]')).not.toBeNull() })

    ;(doc.getElementById('prompt') as HTMLTextAreaElement).value = 'hello portal'
    doc.getElementById('composer')!.dispatchEvent(new dom.window.Event('submit', { cancelable: true }))
    await vi.waitFor(() => {
      const texts = [...doc.querySelectorAll('.msg')].map(node => node.textContent)
      expect(texts).toContain('hello portal')
      expect(texts).toContain('PORTAL REPLY')
    })
    await vi.waitFor(() => { expect(doc.getElementById('status')!.textContent).toBe('回合结束（end_turn）') })

    const answer = hub.permissionHandler!({ options: [{ optionId: 'allow-once' }] })
    try {
      await vi.waitFor(() => { expect(doc.querySelector('.permission button')).not.toBeNull() })
    } catch (error) {
      const errors = (dom as JSDOM & { pageErrors?: unknown[] }).pageErrors ?? []
      const turns = JSON.stringify((dom.window.__tenantPortal as { state: { turns: unknown[] } } | undefined)?.state?.turns ?? 'no-portal')
      throw new Error(`permission card never rendered; turns=${turns}; pageErrors=${JSON.stringify(errors.map(String))}: ${String(error)}`)
    }
    doc.querySelector<HTMLButtonElement>('.permission button')!.click()
    await expect(answer).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })

    // The answered card must not resurrect when the next update re-renders.
    hub.emitUpdate('sess-portal', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' after' } })
    await vi.waitFor(() => {
      expect([...doc.querySelectorAll('.msg')].map(node => node.textContent)).toContain('PORTAL REPLY after')
    })
    expect(doc.querySelector('.permission')).toBeNull()
  }, 20_000)

  it('keeps a second viewer blind to a tenant that never shared its token', async () => {
    const hub = new FakeRuntimeHub()
    const server = await startPortalStack(hub)
    const active = await openPortal(server)
    const bystander = await openPortal(server)
    const activeDoc = active.window.document
    const bystanderDoc = bystander.window.document

    await vi.waitFor(() => { expect(active.window.__tenantPortal).toBeDefined() })
    await vi.waitFor(() => { expect(bystander.window.__tenantPortal).toBeDefined() })

    const tokenInput = activeDoc.getElementById('token') as unknown as HTMLInputElement
    tokenInput.value = TOKEN
    activeDoc.getElementById('connect')!.click()
    await vi.waitFor(() => { expect(activeDoc.getElementById('status')!.textContent).toBe('已连接') })
    ;(activeDoc.getElementById('cwd') as unknown as HTMLInputElement).value = '/ws/alpha'
    activeDoc.getElementById('new-session')!.click()
    await vi.waitFor(() => { expect(activeDoc.getElementById('composer')!.hidden).toBe(false) })

    // A page that never entered alpha's token sees nothing of alpha: no
    // session list entries, no streamed messages, no permission cards.
    expect(bystanderDoc.querySelectorAll('[data-session-id]')).toHaveLength(0)
    expect(bystanderDoc.querySelectorAll('.msg')).toHaveLength(0)
    expect(bystanderDoc.querySelectorAll('.permission')).toHaveLength(0)
    expect(bystanderDoc.getElementById('status')!.textContent).toBe('')
  }, 20_000)
})
