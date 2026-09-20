import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  promptHandler: (() => Promise<unknown>) | undefined
  createdSessions: string[] = []
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
  const tempTenantsRoot = mkdtempSync(join(tmpdir(), 'dsh-portal-tenants-'))
  const server = await startPlatformServer({
    authenticator: devTokenAuthenticator(identities),
    tenantsRoot: tempTenantsRoot,
    createRuntime: async tenantId => ({
      tenantId,
      request: async <T>(method: string): Promise<T> => {
        if (method === 'session/new') {
          const sid = 'sess-portal-1'
          if (hub) hub.createdSessions.push(sid)
          return { sessionId: sid } as T
        }
        if (method === 'session/prompt') {
          if (hub?.promptHandler) {
            return await hub.promptHandler() as T
          }
          return { stopReason: 'end_turn' } as T
        }
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
  cleanupFns.push(() => {
    rmSync(tempTenantsRoot, { recursive: true, force: true })
    return server.close()
  })
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
      expect(doc.querySelector('.welcome-screen')).not.toBeNull()
    })

    // User submits their initial task prompt: session is created lazily
    const input = doc.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'Start analysis'
    const sendBtn = doc.getElementById('send-btn') as HTMLButtonElement
    sendBtn.click()

    await vi.waitFor(() => {
      expect(dom.window.__agentCockpit.state.activeSessionId).toBe('sess-portal-1')
    })

    // 1. Emit thought chunk from runtime
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Analyzing database records...' },
    })

    await vi.waitFor(() => {
      const thoughtCard = doc.querySelector('.thought-container')
      expect(thoughtCard).not.toBeNull()
      expect(thoughtCard!.textContent).toContain('Analyzing database records...')
    })

    // Test Cherry Studio thought fold/expand toggle
    const thoughtContainer = doc.querySelector('.thought-container')!
    const thoughtHeader = thoughtContainer.querySelector('.thought-header') as HTMLElement
    const toggleText = thoughtContainer.querySelector('.thought-toggle-text') as HTMLElement
    // While thinking, container is expanded by default to ensure real-time visibility
    expect(thoughtContainer.classList.contains('expanded')).toBe(true)
    expect(toggleText.textContent).toBe('收起')
    thoughtHeader.click()
    expect(thoughtContainer.classList.contains('expanded')).toBe(false)
    expect(toggleText.textContent).toBe('展开全部')
    thoughtHeader.click()
    expect(thoughtContainer.classList.contains('expanded')).toBe(true)
    expect(toggleText.textContent).toBe('收起')

    // Emit agent message chunk to verify thoughts auto-finalize with char count
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Analysis finished.\n```python\nprint("ok")\n```' },
    })

    await vi.waitFor(() => {
      const thoughtTitle = doc.querySelector('.thought-title')
      expect(thoughtTitle?.textContent).toContain('已深度思考 (29 字)')
      const agentMsg = doc.querySelector('.message-agent')
      expect(agentMsg).not.toBeNull()
      // Verify codeblock retains clean pre code without <br> inside pre
      const preCode = agentMsg?.querySelector('pre code')
      expect(preCode).not.toBeNull()
      expect(preCode?.textContent).toContain('print("ok")')
      expect(preCode?.innerHTML).not.toContain('<br>')
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

  it('supports draft mission mode and isolates multi-turn tool calls without thought leaking', async () => {
    const hub = new PortalFakeHub()
    const server = await startCockpitStack(hub)
    const dom = await openCockpit(server)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__agentCockpit).toBeDefined() })
    login(doc, MEMBER_TOKEN)

    await vi.waitFor(() => {
      expect(doc.getElementById('workspace-layout')!.hidden).toBe(false)
    })

    // Click New Task button: must enter draft mode without creating backend session
    const newBtn = doc.getElementById('new-task-btn') as HTMLButtonElement
    newBtn.click()

    expect(dom.window.__agentCockpit.state.activeSessionId).toBeNull()
    expect(doc.querySelector('.welcome-screen')).not.toBeNull()
    expect(hub.createdSessions.length).toBe(0)

    // Send first prompt: lazily creates session
    const input = doc.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'Investigate performance'
    const sendBtn = doc.getElementById('send-btn') as HTMLButtonElement
    sendBtn.click()

    await vi.waitFor(() => {
      expect(dom.window.__agentCockpit.state.activeSessionId).toBe('sess-portal-1')
      expect(hub.createdSessions.length).toBe(1)
    })

    // Turn 1: Thought -> Tool Call -> Tool Result
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'First phase thinking...' },
    })
    await vi.waitFor(() => {
      expect(doc.querySelector('.active-thought-container')).not.toBeNull()
    })

    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'grepSearch',
      parameters: { query: 'perf' },
    })

    await vi.waitFor(() => {
      // First thought must be finalized when tool starts
      expect(doc.querySelector('.active-thought-container')).toBeNull()
      expect(doc.querySelector('.tools-card')).not.toBeNull()
      expect(doc.getElementById('tool-call-1')).not.toBeNull()
    })

    // Turn 2: Second thought after tool -> Final Answer
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Second phase thinking...' },
    })

    await vi.waitFor(() => {
      const thoughtCards = doc.querySelectorAll('.thought-container')
      expect(thoughtCards.length).toBe(2)
      expect(thoughtCards[0]!.textContent).toContain('First phase thinking...')
      expect(thoughtCards[1]!.textContent).toContain('Second phase thinking...')
    })

    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'All issues resolved.' },
    })

    await vi.waitFor(() => {
      expect(doc.querySelector('.message-agent')?.textContent).toContain('All issues resolved.')
      // Both thoughts should now be finalized
      expect(doc.querySelectorAll('.active-thought-container').length).toBe(0)
    })
  }, 20_000)

  it('instantly mounts thought container upon prompt submit and clears empty placeholder on pure message', async () => {
    const hub = new PortalFakeHub()
    let resolvePrompt: ((val: unknown) => void) | undefined
    hub.promptHandler = () => new Promise((resolve) => { resolvePrompt = resolve })
    const server = await startCockpitStack(hub)
    const dom = await openCockpit(server)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__agentCockpit).toBeDefined() })
    login(doc, MEMBER_TOKEN)

    await vi.waitFor(() => {
      expect(doc.getElementById('workspace-layout')!.hidden).toBe(false)
    })

    const input = doc.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'Pure query without reasoning'
    const sendBtn = doc.getElementById('send-btn') as HTMLButtonElement
    sendBtn.click()

    // Prompt submitted (pending): verify session initialized and thought placeholder mounted
    await vi.waitFor(() => {
      expect(dom.window.__agentCockpit.state.activeSessionId).toBe('sess-portal-1')
      const activeThought = doc.querySelector('.active-thought-container')
      expect(activeThought).not.toBeNull()
      expect(activeThought?.textContent).toContain('DeepSeek 深度思考中...')
      expect(activeThought?.classList.contains('expanded')).toBe(true)
      expect(doc.querySelector('.thought-pulse')).not.toBeNull()
    })

    // Pure agent message chunk arrives without any thought chunk: placeholder must be cleanly removed
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Direct reply from model.' },
    })

    await vi.waitFor(() => {
      // Empty placeholder thought container should be safely removed without leaving empty shells
      expect(doc.querySelector('.thought-container')).toBeNull()
      expect(doc.querySelector('.message-agent')?.textContent).toContain('Direct reply from model.')
    })

    // Complete the prompt turn cleanly
    resolvePrompt!({ stopReason: 'end_turn' })
    await vi.waitFor(() => {
      expect(dom.window.__agentCockpit.state.isBusy).toBe(false)
    })
  }, 20_000)

  it('safely recycles placeholder on early end_turn without chunks and finalizes pure thought streams', async () => {
    const hub = new PortalFakeHub()
    const server = await startCockpitStack(hub)
    const dom = await openCockpit(server)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__agentCockpit).toBeDefined() })
    login(doc, MEMBER_TOKEN)

    await vi.waitFor(() => {
      expect(doc.getElementById('workspace-layout')!.hidden).toBe(false)
    })

    // Subcase 1: Prompt completes with 0 chunks (empty turn) -> placeholder must not leak as a zombie card
    const input = doc.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'Turn with empty return'
    const sendBtn = doc.getElementById('send-btn') as HTMLButtonElement
    sendBtn.click()

    // When the prompt finishes without chunks, finally block recycles placeholder
    await vi.waitFor(() => {
      expect(dom.window.__agentCockpit.state.isBusy).toBe(false)
      expect(doc.querySelector('.thought-container')).toBeNull()
    })

    // Subcase 2: Pure thought stream (model outputs thought chunks only, no message chunks)
    input.value = 'Pure reasoning only'
    sendBtn.click()

    await vi.waitFor(() => {
      expect(doc.querySelector('.active-thought-container')).not.toBeNull()
    })

    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Internal chain of thought planning...' },
    })

    await vi.waitFor(() => {
      const thoughtContent = doc.querySelector('.thought-content')
      expect(thoughtContent?.textContent).toContain('Internal chain of thought planning...')
    })

    // Prompt resolves with pure thought: container must be finalized to "已深度思考" and pulse removed
    await vi.waitFor(() => {
      expect(dom.window.__agentCockpit.state.isBusy).toBe(false)
      const thoughtTitle = doc.querySelector('.thought-title')
      expect(thoughtTitle?.textContent).toContain('已深度思考')
      expect(doc.querySelector('.thought-pulse')).toBeNull()
    })
  }, 20_000)
})
