import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM, VirtualConsole } from 'jsdom'
import { WebSocket as WsWebSocket } from 'ws'
import { devTokenAuthenticator, type DevTokenIdentity } from '../src/auth.ts'
import { startPlatformServer, type PlatformServer } from '../src/index.ts'

/**
 * Enterprise Agent Mission Cockpit (Option B) end to end inside JSDOM:
 * Verifies that the new three-column workspace loads cleanly,
 * authenticates seamlessly, displays role-specific controls,
 * receives streaming updates over WebSocket, handles permissions,
 * and mounts the admin console drawer for managers.
 */

const MEMBER_TOKEN = 'cockpit-member'
const DEPT_ADMIN_TOKEN = 'cockpit-dept-admin'
const PLATFORM_ADMIN_TOKEN = 'cockpit-platform-admin'

const cleanupFns: Array<() => Promise<void> | void> = []
const liveDoms: JSDOM[] = []

afterEach(async () => {
  while (liveDoms.length > 0) {
    const dom = liveDoms.pop()!
    try {
      dom.window.__agentCockpit?.logout()
    } catch {}
    dom.window.close()
  }
  while (cleanupFns.length > 0) await cleanupFns.pop()!()
})

class PortalFakeHub {
  permissionHandler: ((request: unknown) => Promise<unknown>) | undefined
  updateListener: ((sessionId: string, update: unknown) => void) | undefined
  emitUpdate(sessionId: string, update: unknown): void {
    this.updateListener?.(sessionId, update)
  }
}

async function startCockpitStack(hub?: PortalFakeHub): Promise<PlatformServer> {
  const identities = new Map<string, DevTokenIdentity>([
    [MEMBER_TOKEN, { deptId: 'deptA', userId: 'user1', role: 'member' }],
    [DEPT_ADMIN_TOKEN, { deptId: 'deptA', userId: 'lead', role: 'dept-admin' }],
    [PLATFORM_ADMIN_TOKEN, { deptId: '_platform', userId: 'admin-1', role: 'platform-admin' }],
  ])
  const server = await startPlatformServer({
    authenticator: devTokenAuthenticator(identities),
    createRuntime: async tenantId => ({
      tenantId,
      request: async <T>(method: string): Promise<T> => {
        if (method === 'session/new') return { sessionId: 'sess-portal-1' } as T
        if (method === 'session/prompt') return { stopReason: 'end_turn' } as T
        return {} as T
      },
      onUpdate: (listener) => {
        if (hub) hub.updateListener = listener
        return () => { if (hub) hub.updateListener = undefined }
      },
      onPermission: (handler) => {
        if (hub) hub.permissionHandler = handler
      },
      get lastUsedAt(): number { return Date.now() },
      dispose: async () => {},
      exited: () => new Promise<void>(() => {}),
    }),
  })
  cleanupFns.push(() => server.close())
  return server
}

async function openCockpit(server: PlatformServer, query = ''): Promise<JSDOM> {
  const base = `http://127.0.0.1:${server.port}`
  const html = await (await fetch(`${base}/${query}`)).text()
  const pageErrors: unknown[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => { pageErrors.push(error) })
  const dom = new JSDOM(html, {
    url: `${base}/${query}`,
    runScripts: 'dangerously',
    resources: 'usable',
    virtualConsole,
    beforeParse: (window) => {
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url, `${base}/`).toString(), init)
      // Real WebSocket client backed by 'ws'
      window.WebSocket = WsWebSocket as unknown as typeof WebSocket
    },
  })
  ;(dom as JSDOM & { pageErrors: unknown[] }).pageErrors = pageErrors
  liveDoms.push(dom)
  return dom
}

function login(doc: Document, token: string): void {
  const tokenInput = doc.getElementById('token-input') as HTMLInputElement
  tokenInput.value = token
  doc.getElementById('login-btn')!.click()
}

describe('enterprise agent cockpit portal (Option B)', () => {
  it('authenticates a member into the three-column workspace directly without external redirects', async () => {
    const server = await startCockpitStack()
    const dom = await openCockpit(server)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__agentCockpit).toBeDefined() })
    login(doc, MEMBER_TOKEN)

    // Workspace layout becomes visible, banner hidden
    await vi.waitFor(() => {
      expect(doc.getElementById('workspace-layout')!.hidden).toBe(false)
      expect(doc.getElementById('auth-banner')!.hidden).toBe(true)
    })

    // Badges updated
    expect(doc.getElementById('dept-name')!.textContent).toBe('deptA')
    expect(doc.getElementById('user-name')!.textContent).toContain('user1 (member)')

    // Member has no admin console button
    expect(doc.getElementById('admin-btn')!.hidden).toBe(true)
  }, 20_000)

  it('auto-logs in from URL query ?ptoken=', async () => {
    const server = await startCockpitStack()
    const dom = await openCockpit(server, `?ptoken=${MEMBER_TOKEN}`)
    const doc = dom.window.document

    await vi.waitFor(() => {
      expect(doc.getElementById('workspace-layout')!.hidden).toBe(false)
      expect(doc.getElementById('user-name')!.textContent).toContain('user1')
    })
  }, 20_000)

  it('renders admin console button for dept-admin and opens modal', async () => {
    const server = await startCockpitStack()
    const dom = await openCockpit(server)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__agentCockpit).toBeDefined() })
    login(doc, DEPT_ADMIN_TOKEN)

    await vi.waitFor(() => {
      expect(doc.getElementById('workspace-layout')!.hidden).toBe(false)
      expect(doc.getElementById('admin-btn')!.hidden).toBe(false)
    })

    // Click admin button opens modal
    doc.getElementById('admin-btn')!.click()
    expect(doc.getElementById('admin-modal')!.hidden).toBe(false)

    // Modal loads dept members
    await vi.waitFor(() => {
      expect(doc.getElementById('admin-modal-body')!.textContent).toContain('user1')
      expect(doc.getElementById('admin-modal-body')!.textContent).toContain('lead')
    })
  }, 20_000)

  it('renders admin overview for platform-admin', async () => {
    const server = await startCockpitStack()
    const dom = await openCockpit(server)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__agentCockpit).toBeDefined() })
    login(doc, PLATFORM_ADMIN_TOKEN)

    await vi.waitFor(() => {
      expect(doc.getElementById('workspace-layout')!.hidden).toBe(false)
      expect(doc.getElementById('admin-btn')!.hidden).toBe(false)
    })

    doc.getElementById('admin-btn')!.click()
    await vi.waitFor(() => {
      expect(doc.getElementById('admin-modal-body')!.textContent).toContain('实例总体概览')
      expect(doc.getElementById('admin-modal-body')!.textContent).toContain('deptA')
    })
  }, 20_000)

  it('renders streaming thoughts and resolves human-in-the-loop permission approvals via real WebSocket', async () => {
    const hub = new PortalFakeHub()
    const server = await startCockpitStack(hub)
    const dom = await openCockpit(server)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__agentCockpit).toBeDefined() })
    login(doc, MEMBER_TOKEN)

    await vi.waitFor(() => {
      expect(doc.getElementById('workspace-layout')!.hidden).toBe(false)
      expect(dom.window.__agentCockpit.state.activeSessionId).toBe('sess-portal-1')
    })

    // 1. Emit thought chunk from runtime
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Analyzing database records...' },
    })

    await vi.waitFor(() => {
      const thoughtCard = doc.querySelector('.active-thought-card')
      expect(thoughtCard).not.toBeNull()
      expect(thoughtCard!.textContent).toContain('Analyzing database records...')
    })

    // 2. Trigger permission request
    let permissionAnswer: unknown
    const permPromise = hub.permissionHandler!({
      title: 'Run bash script',
      options: [{ id: 'allow-once', title: 'Allow once' }],
    }).then((ans) => { permissionAnswer = ans })

    await vi.waitFor(() => {
      const permCard = doc.querySelector('.permission-card')
      expect(permCard).not.toBeNull()
      expect(permCard!.textContent).toContain('Run bash script')
    })

    // Click allow button
    const allowBtn = doc.querySelector('.allow-btn') as HTMLButtonElement
    expect(allowBtn).not.toBeNull()
    allowBtn.click()

    // Verify permission card removed and answer received with optionId
    await vi.waitFor(() => {
      expect(doc.querySelector('.permission-card')).toBeNull()
      expect(permissionAnswer).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      })
    })
    await permPromise
  }, 20_000)
})
