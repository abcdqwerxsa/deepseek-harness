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
  mockTranscripts = new Map<string, unknown[]>()
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

async function openCockpit(server: PlatformServer, query = '', hub?: PortalFakeHub): Promise<JSDOM> {
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
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const urlStr = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url
        for (const [sid, rows] of (hub?.mockTranscripts || new Map())) {
          if (urlStr.includes(`/api/session/${encodeURIComponent(sid)}/transcript`) || urlStr.includes(`/api/session/${sid}/transcript`)) {
            return Promise.resolve(new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } }))
          }
        }
        return fetch(new URL(urlStr, `${base}/`).toString(), init)
      }
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
      // Since user explicitly expanded the container, it must remain expanded after finalization
      expect(thoughtContainer.classList.contains('expanded')).toBe(true)
      expect(toggleText.textContent).toBe('收起')
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

  it('streams multi-chunk message into a single unified bubble without tearing and preserves inner thought scroll position', async () => {
    const hub = new PortalFakeHub()
    let resolvePrompt: ((val: unknown) => void) | undefined
    hub.promptHandler = () => new Promise((resolve) => { resolvePrompt = resolve })
    const server = await startCockpitStack(hub)
    const dom = await openCockpit(server, '', hub)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__agentCockpit).toBeDefined() })
    login(doc, MEMBER_TOKEN)

    await vi.waitFor(() => {
      expect(doc.getElementById('workspace-layout')!.hidden).toBe(false)
    })

    const input = doc.getElementById('chat-input') as HTMLTextAreaElement
    input.value = 'Stream test across multiple chunks'
    const sendBtn = doc.getElementById('send-btn') as HTMLButtonElement
    sendBtn.click()

    await vi.waitFor(() => {
      expect(dom.window.__agentCockpit.state.activeSessionId).toBe('sess-portal-1')
    })

    // 1. Thought stream without user toggle -> should auto-collapse on finalization
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Step 1 thought: planning data format...\nLong thought paragraph.' },
    })

    await vi.waitFor(() => {
      expect(doc.querySelector('.thought-content')?.textContent).toContain('Step 1 thought')
    })

    // Simulate user scrolled up to read earlier lines: scrollHeight=1000, clientHeight=400, scrollTop=100 (distance to bottom = 500 > 40)
    const thoughtContent = doc.querySelector('.thought-content') as HTMLElement
    Object.defineProperty(thoughtContent, 'scrollHeight', { value: 1000, configurable: true, writable: true })
    Object.defineProperty(thoughtContent, 'clientHeight', { value: 400, configurable: true, writable: true })
    thoughtContent.scrollTop = 100

    // Emit another thought chunk: must NOT snatch user scroll back to bottom
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: '\nStep 2 thought: adding more planning steps.' },
    })

    await vi.waitFor(() => {
      expect(thoughtContent.textContent).toContain('Step 2 thought')
      // Scroll position must remain preserved at 100
      expect(thoughtContent.scrollTop).toBe(100)
    })

    // 2. Stream chunk 1 of message
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello! ' },
    })

    await vi.waitFor(() => {
      expect(doc.querySelectorAll('.message-agent').length).toBe(1)
      expect(doc.querySelector('.thought-title')?.textContent).toContain('已深度思考')
      // Container was NOT user-toggled: must auto-collapse to "展开全部"
      const tc = doc.querySelector('.thought-container')
      expect(tc?.classList.contains('expanded')).toBe(false)
      expect(tc?.querySelector('.thought-toggle-text')?.textContent).toBe('展开全部')
    })

    // 3. Stream chunk 2 of message
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Here is your `code`: ' },
    })

    await vi.waitFor(() => {
      // Must NOT fragment into multiple agent bubbles
      expect(doc.querySelectorAll('.message-agent').length).toBe(1)
    })

    // 4. Stream chunk 3 containing dollar sign variables in markdown (testing Issue 4)
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '```bash\necho "$1"\n```' },
    })

    await vi.waitFor(() => {
      expect(doc.querySelectorAll('.message-agent').length).toBe(1)
    })

    // Complete the turn
    resolvePrompt!({ stopReason: 'end_turn' })
    await vi.waitFor(() => {
      expect(dom.window.__agentCockpit.state.isBusy).toBe(false)
      // Verify final content is seamlessly aggregated in one single bubble with intact code block
      const agentMsg = doc.querySelector('.message-agent')
      expect(doc.querySelectorAll('.message-agent').length).toBe(1)
      expect(agentMsg?.textContent).toContain('Hello! Here is your code: echo "$1"')
      expect(agentMsg?.querySelector('pre code')?.textContent).toBe('echo "$1"\n')
    })
  }, 20_000)

  it('aggregates multi-chunk agent messages into a single bubble during transcript replay', async () => {
    const hub = new PortalFakeHub()
    hub.mockTranscripts.set('sess-replay-multi', [
      { update: { sessionUpdate: 'user_message_chunk', content: { text: 'Summarize report' } } },
      { update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'Analyzing multi-part report data...' } } },
      { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Section 1: Summary. ' } } },
      { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Section 2: Details. ' } } },
      { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Conclusion: All good.' } } },
    ])
    const server = await startCockpitStack(hub)
    const dom = await openCockpit(server, '', hub)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__agentCockpit).toBeDefined() })
    login(doc, MEMBER_TOKEN)

    await vi.waitFor(() => {
      expect(doc.getElementById('workspace-layout')!.hidden).toBe(false)
    })

    // Trigger selectSession with multi-chunk transcript
    await dom.window.__agentCockpit.selectSession('sess-replay-multi')

    await vi.waitFor(() => {
      // Must contain exactly 1 user message and 1 agent message bubble
      expect(doc.querySelectorAll('.message-user').length).toBe(1)
      expect(doc.querySelectorAll('.message-agent').length).toBe(1)
      const agentBubble = doc.querySelector('.message-agent')
      expect(agentBubble?.textContent).toContain('Section 1: Summary. Section 2: Details. Conclusion: All good.')
      // Thought flow should also be rendered and finalized cleanly
      expect(doc.querySelectorAll('.thought-container').length).toBe(1)
      expect(doc.querySelector('.thought-title')?.textContent).toContain('已深度思考 (35 字)')
    })
  }, 20_000)

  it('preserves previous turn thoughts and isolates new thought stream across multiple conversation turns', async () => {
    const hub = new PortalFakeHub()
    let resolvePrompt: ((res: { stopReason: string }) => void) | undefined
    hub.promptHandler = () => new Promise<{ stopReason: string }>((resolve) => {
      resolvePrompt = resolve
    })

    const server = await startCockpitStack(hub)
    const dom = await openCockpit(server, '', hub)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__agentCockpit).toBeDefined() })
    login(doc, MEMBER_TOKEN)
    await vi.waitFor(() => { expect(doc.getElementById('workspace-layout')!.hidden).toBe(false) })

    // === TURN 1 ===
    ;(doc.getElementById('chat-input') as HTMLTextAreaElement).value = 'Question 1: analyze data'
    doc.getElementById('send-btn')!.click()

    await vi.waitFor(() => {
      expect(dom.window.__agentCockpit.state.activeSessionId).toBe('sess-portal-1')
      expect(resolvePrompt).toBeDefined()
      expect(doc.querySelectorAll('.thought-container').length).toBe(1)
    })
    const resolve1 = resolvePrompt!
    resolvePrompt = undefined

    // Turn 1 Thought stream
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking about question 1...' },
    })

    // Turn 1 Message stream
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Answer 1 completed.' },
    })

    resolve1({ stopReason: 'end_turn' })
    await vi.waitFor(() => {
      expect(dom.window.__agentCockpit.state.isBusy).toBe(false)
      const thoughts = doc.querySelectorAll('.thought-container')
      expect(thoughts.length).toBe(1)
      expect(thoughts[0]?.querySelector('.thought-title')?.textContent).toContain('已深度思考')
      expect(thoughts[0]?.querySelector('.thought-content')?.textContent).toBe('Thinking about question 1...')
    })

    // === TURN 2 (The exact user bug: asking a second question must NOT wipe out Turn 1 thought) ===
    ;(doc.getElementById('chat-input') as HTMLTextAreaElement).value = 'Question 2: follow up logic'
    doc.getElementById('send-btn')!.click()

    await vi.waitFor(() => {
      expect(resolvePrompt).toBeDefined()
      // Turn 1 thought must be strictly preserved, Turn 2 thought container mounted
      const thoughts = doc.querySelectorAll('.thought-container')
      expect(thoughts.length).toBe(2)
      // Turn 1 remains archived
      expect(thoughts[0]?.querySelector('.thought-title')?.textContent).toContain('已深度思考')
      expect(thoughts[0]?.querySelector('.thought-content')?.textContent).toBe('Thinking about question 1...')
      // Turn 2 is active with placeholder / pulse
      expect(thoughts[1]?.classList.contains('active-thought-container')).toBe(true)
      expect(thoughts[1]?.querySelector('.thought-pulse')).not.toBeNull()
    })
    const resolve2 = resolvePrompt!
    resolvePrompt = undefined

    // Turn 2 Thought stream
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Thinking about question 2 in real-time...' },
    })

    await vi.waitFor(() => {
      const thoughts = doc.querySelectorAll('.thought-container')
      expect(thoughts[1]?.querySelector('.thought-content')?.textContent).toBe('Thinking about question 2 in real-time...')
    })

    // Turn 2 Message stream
    hub.emitUpdate('sess-portal-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Answer 2 completed.' },
    })

    resolve2({ stopReason: 'end_turn' })
    await vi.waitFor(() => {
      expect(dom.window.__agentCockpit.state.isBusy).toBe(false)
      const thoughts = doc.querySelectorAll('.thought-container')
      expect(thoughts.length).toBe(2)
      // Both thoughts must be intact and finalized!
      expect(thoughts[0]?.querySelector('.thought-content')?.textContent).toBe('Thinking about question 1...')
      expect(thoughts[1]?.querySelector('.thought-content')?.textContent).toBe('Thinking about question 2 in real-time...')
      expect(thoughts[0]?.querySelector('.thought-title')?.textContent).toContain('已深度思考')
      expect(thoughts[1]?.querySelector('.thought-title')?.textContent).toContain('已深度思考')
      // Turn 1 can be toggled by user to view details
      const t1Toggle = thoughts[0]?.querySelector('.thought-header') as HTMLElement
      t1Toggle.click()
      expect(thoughts[0]?.classList.contains('expanded')).toBe(true)
    })
  }, 20_000)

  it('correctly reconstructs and isolates multi-turn conversation and thought flows during transcript replay', async () => {
    const hub = new PortalFakeHub()
    hub.mockTranscripts.set('sess-replay-multiturn', [
      // Turn 1
      { update: { sessionUpdate: 'user_message_chunk', content: { text: 'First query: check data' } } },
      { update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'Turn 1 deep reasoning details...' } } },
      { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Turn 1 answer part 1. ' } } },
      { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Turn 1 answer part 2.' } } },
      // Turn 2
      { update: { sessionUpdate: 'user_message_chunk', content: { text: 'Second query: optimize logic' } } },
      { update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'Turn 2 deep reasoning details...' } } },
      { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Turn 2 answer part 1. ' } } },
      { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Turn 2 answer part 2.' } } },
    ])
    const server = await startCockpitStack(hub)
    const dom = await openCockpit(server, '', hub)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__agentCockpit).toBeDefined() })
    login(doc, MEMBER_TOKEN)

    await vi.waitFor(() => {
      expect(doc.getElementById('workspace-layout')!.hidden).toBe(false)
    })

    // Replay multi-turn transcript
    await dom.window.__agentCockpit.selectSession('sess-replay-multiturn')

    await vi.waitFor(() => {
      // Must contain exactly 2 user messages and 2 agent message bubbles
      const userBubbles = doc.querySelectorAll('.message-user')
      const agentBubbles = doc.querySelectorAll('.message-agent')
      expect(userBubbles.length).toBe(2)
      expect(agentBubbles.length).toBe(2)

      expect(userBubbles[0]?.textContent).toContain('First query: check data')
      expect(userBubbles[1]?.textContent).toContain('Second query: optimize logic')

      expect(agentBubbles[0]?.textContent).toContain('Turn 1 answer part 1. Turn 1 answer part 2.')
      expect(agentBubbles[1]?.textContent).toContain('Turn 2 answer part 1. Turn 2 answer part 2.')

      // Exactly 2 thought containers, each finalized and isolated
      const thoughtCards = doc.querySelectorAll('.thought-container')
      expect(thoughtCards.length).toBe(2)
      expect(thoughtCards[0]?.querySelector('.thought-content')?.textContent).toBe('Turn 1 deep reasoning details...')
      expect(thoughtCards[1]?.querySelector('.thought-content')?.textContent).toBe('Turn 2 deep reasoning details...')
      expect(thoughtCards[0]?.querySelector('.thought-title')?.textContent).toContain('已深度思考')
      expect(thoughtCards[1]?.querySelector('.thought-title')?.textContent).toContain('已深度思考')

      // Ensure active indicators are cleared
      expect(doc.querySelectorAll('.active-thought-container').length).toBe(0)
      expect(doc.querySelectorAll('.thought-pulse').length).toBe(0)
    })
  }, 20_000)
})
