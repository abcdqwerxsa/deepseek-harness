import { afterEach, describe, expect, it, vi } from 'vitest'
import { JSDOM, VirtualConsole } from 'jsdom'
import { devTokenAuthenticator, type DevTokenIdentity } from '../src/auth.ts'
import { startPlatformServer, type PlatformServer } from '../src/index.ts'

/**
 * Admin console page end to end inside JSDOM: the real HTML and portal.js
 * are fetched from a live BFF, so the wiring under test is exactly what a
 * browser runs — token connect, role-aware views (member redirect link,
 * dept-admin department reports, platform-admin overview plus drill-down),
 * and role-scoped 403s for members reaching for department data.
 */

const MEMBER_TOKEN = 'console-member'
const DEPT_ADMIN_TOKEN = 'console-dept-admin'
const PLATFORM_ADMIN_TOKEN = 'console-platform-admin'

const cleanupFns: Array<() => Promise<void> | void> = []
const liveDoms: JSDOM[] = []

afterEach(async () => {
  while (liveDoms.length > 0) liveDoms.pop()!.window.close()
  while (cleanupFns.length > 0) await cleanupFns.pop()!()
})

async function startConsoleStack(): Promise<PlatformServer> {
  const identities = new Map<string, DevTokenIdentity>([
    [MEMBER_TOKEN, { deptId: 'deptA', userId: 'user1', role: 'member' }],
    [DEPT_ADMIN_TOKEN, { deptId: 'deptA', userId: 'lead', role: 'dept-admin' }],
    [PLATFORM_ADMIN_TOKEN, { deptId: '_platform', userId: 'admin-1', role: 'platform-admin' }],
  ])
  const server = await startPlatformServer({
    authenticator: devTokenAuthenticator(identities),
    createRuntime: async () => { throw new Error('no runtime needed for console views') },
  })
  cleanupFns.push(() => server.close())
  return server
}

async function openConsole(server: PlatformServer): Promise<JSDOM> {
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
      // jsdom ships no fetch; route the console's relative calls to the live
      // server through Node's fetch.
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(new URL(input instanceof URL ? input.href : typeof input === 'string' ? input : input.url, `${base}/`).toString(), init)
    },
  })
  ;(dom as JSDOM & { pageErrors: unknown[] }).pageErrors = pageErrors
  liveDoms.push(dom)
  return dom
}

function connect(doc: Document, token: string): void {
  const tokenInput = doc.getElementById('token') as HTMLInputElement
  tokenInput.value = token
  doc.getElementById('connect')!.click()
}

describe('admin console page', () => {
  it('routes a member straight to their original-UI link', async () => {
    const server = await startConsoleStack()
    const dom = await openConsole(server)
    const doc = dom.window.document

    await vi.waitFor(() => { expect(dom.window.__adminConsole).toBeDefined() })
    connect(doc, MEMBER_TOKEN)
    await vi.waitFor(() => { expect(doc.getElementById('status')!.textContent).toContain('deptA/user1 · member') })
    const link = doc.querySelector<HTMLAnchorElement>('a.open-ui')
    expect(link).not.toBeNull()
    expect(link!.getAttribute('href')).toBe(`/u/deptA/user1/?ptoken=${MEMBER_TOKEN}`)
    // No governance sections for a member.
    expect(doc.querySelectorAll('table').length).toBe(0)
  }, 20_000)

  it('renders the department directory, usage, and audit for a dept admin', async () => {
    const server = await startConsoleStack()
    const dom = await openConsole(server)
    const doc = dom.window.document
    await vi.waitFor(() => { expect(dom.window.__adminConsole).toBeDefined() })
    connect(doc, DEPT_ADMIN_TOKEN)
    await vi.waitFor(() => { expect(doc.getElementById('status')!.textContent).toContain('dept-admin') })
    // Directory lists every deptA identity (member, lead) with roles.
    await vi.waitFor(() => {
      const rows = [...doc.querySelectorAll('table td')].map(td => td.textContent)
      expect(rows).toContain('user1')
      expect(rows).toContain('lead')
    })
    // Usage and audit sections render.
    await vi.waitFor(() => { expect([...doc.querySelectorAll('h2')].some(h => h.textContent === '用量')).toBe(true) })
    expect([...doc.querySelectorAll('h2')].some(h => h.textContent === '审计')).toBe(true)
  }, 20_000)

  it('refuses department data to members and shows the error', async () => {
    const server = await startConsoleStack()
    const response = await fetch(`http://127.0.0.1:${server.port}/api/dept/usage?dept=deptA`, {
      headers: { authorization: `Bearer ${MEMBER_TOKEN}` },
    })
    expect(response.status).toBe(403)
  })

  it('gives the platform admin the instance overview and department drill-down', async () => {
    const server = await startConsoleStack()
    const dom = await openConsole(server)
    const doc = dom.window.document
    await vi.waitFor(() => { expect(dom.window.__adminConsole).toBeDefined() })
    connect(doc, PLATFORM_ADMIN_TOKEN)
    await vi.waitFor(() => { expect(doc.getElementById('status')!.textContent).toContain('platform-admin') })
    // Overview table lists departments with user counts.
    await vi.waitFor(() => {
      const rows = [...doc.querySelectorAll('table td')].map(td => td.textContent)
      expect(rows).toContain('deptA')
      expect(rows).toContain('_platform')
    })
    // Drill-down into deptA loads its member table into the drill pane.
    const picker = doc.querySelector<HTMLSelectElement>('select')
    expect(picker).not.toBeNull()
    picker!.value = 'deptA'
    picker!.dispatchEvent(new dom.window.Event('change'))
    await vi.waitFor(() => {
      const drill = doc.querySelector('#drill')
      expect([...drill!.querySelectorAll('table td')].map(td => td.textContent)).toContain('user1')
    })
  }, 20_000)
})
