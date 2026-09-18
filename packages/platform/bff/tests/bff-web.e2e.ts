import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { devTokenAuthenticator, type DevTokenIdentity } from '../src/auth.ts'
import { composeWebRuntimeFactory } from '../src/compose.ts'
import { startPlatformServer, type PlatformServer } from '../src/index.ts'

/**
 * E2E: the user-side original UI behind the platform — a real spawned
 * `dsh web` child per user (provisioned home, model-gateway token env),
 * reached through the `/u/<dept>/<user>/` subpath proxy with the platform
 * session, the child's launch-token cookie mint, and the base-rewrite.
 * Self-skips without the built CLI or web frontend dist.
 */

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/lib/bin.js')
const webDist = join(repoRoot, 'apps/web/dist/index.html')
const TEST_BUDGET_MS = 240_000
const ready = existsSync(dshBin) && existsSync(webDist)

const TOKEN_A = 'e2e-web-token-alpha'
const ident = (userId: string, deptId = 'core'): DevTokenIdentity => ({ deptId, userId, role: 'member' })

const cleanupFns: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanupFns.length > 0) await cleanupFns.pop()!()
})

afterAll(async () => {
  while (cleanupFns.length > 0) void cleanupFns.pop()!()
})

async function startWebPlatform(): Promise<PlatformServer> {
  const tenantsRoot = mkdtempSync(join(tmpdir(), 'dsh-bff-web-'))
  cleanupFns.push(() => { rmSync(tenantsRoot, { recursive: true, force: true }) })
  const platform = await startPlatformServer({
    authenticator: devTokenAuthenticator(new Map([[TOKEN_A, ident('alpha')]])),
    createRuntime: async () => { throw new Error('acp runtime not used in this suite') },
    webRuntimes: {
      // Real deployment glue: bwrap-less spawn (CI containers already
      // isolate), model-gateway token env, trusted authority = this host.
      factory: composeWebRuntimeFactory({
        tenantsRoot,
        dshBin,
        apiKey: 'unused-direct-key',
        dshVersion: 'web-e2e',
        settingsYaml: 'llm-deepseek:\n  protocol: chat-completions\n',
        trustedAuthority: '127.0.0.1',
      }),
      portMin: 19_700,
      portMax: 19_720,
    },
  })
  cleanupFns.push(() => platform.close())
  return platform
}

describe.skipIf(!ready)('user-side original UI over a real dsh web child', () => {
  it(
    'serves the index through the session + launch-token dance with the base rewritten',
    async () => {
      const platform = await startWebPlatform()
      const origin = `http://127.0.0.1:${String(platform.port)}`

      // Platform session mint from the console link.
      const mint = await fetch(`${origin}/u/core/alpha/?ptoken=${TOKEN_A}`, { redirect: 'manual' })
      expect(mint.status).toBe(303)
      const session = mint.headers.getSetCookie().find(c => c.startsWith('dsh-platform-session='))!.split(';')[0] ?? ''
      expect(session).toBeDefined()
      await mint.text()

      // Index without the child cookie: the proxy offers the child's launch
      // token (proving the child booted and printed its readiness line).
      const first = await fetch(`${origin}/u/core/alpha/`, { headers: { cookie: session! }, redirect: 'manual' })
      expect(first.status).toBe(303)
      const launchUrl = first.headers.get('location') ?? ''
      expect(launchUrl).toMatch(/^\/u\/core\/alpha\/\?token=/)
      await first.text()

      // Presenting the launch token: the child mints its cookie; the proxy
      // scopes it to the subpath and clean-redirects.
      const authed = await fetch(`${origin}${launchUrl}`, { headers: { cookie: session! }, redirect: 'manual' })
      expect(authed.status).toBe(303)
      expect(authed.headers.get('location')).toBe('/u/core/alpha/')
      const childCookie = authed.headers.getSetCookie().find(c => c.startsWith('dsh-auth-'))
      expect(childCookie).toContain('Path=/u/core/alpha/')
      await authed.text()

      // With both cookies the index HTML arrives with the base anchored at
      // the subpath mount — the contract the SPA's relative API/WS URLs
      // depend on — and the webserver-injected root-absolute /plugins script
      // row rebased under it.
      const index = await fetch(`${origin}/u/core/alpha/`, { headers: { cookie: `${session}; ${childCookie}` } })
      expect(index.status).toBe(200)
      const html = await index.text()
      expect(html).toContain('<base href="/u/core/alpha/">')
      const pluginSrc = /src="([^"]*\/plugins\/[^"]*)"/.exec(html)?.[1]?.replaceAll('&amp;', '&')
      expect(pluginSrc).toMatch(/^\/u\/core\/alpha\/plugins\//)
      // The boot graph's plugin URLs are rebased as well — the module system
      // dynamically scripts them and root-absolute URLs ignore <base>.
      expect(html).toContain('"initialUrl":"/u/core/alpha/plugins/')
      // The rebased plugin bundle streams through the subpath (prefix
      // stripped) from the real child's /plugins route.
      const bundle = await fetch(`${origin}${pluginSrc ?? ''}`, { headers: { cookie: session } })
      expect(bundle.status).toBe(200)
      expect((await bundle.text()).length).toBeGreaterThan(0)

      // Static assets stream through with the prefix stripped.
      const assetPath = new URL('assets/whatever.js', `${origin}/u/core/alpha/`).pathname
      const asset = await fetch(`${origin}${assetPath}`, { headers: { cookie: session! } })
      expect([200, 404]).toContain(asset.status)
      await asset.text()
    },
    TEST_BUDGET_MS,
  )

  it(
    'tunnels the remote.mux websocket upgrade to the child',
    async () => {
      const platform = await startWebPlatform()
      const origin = `http://127.0.0.1:${String(platform.port)}`
      // The child's gateway socket requires the dsh-auth browser cookie, so
      // walk the session + launch-token dance first — exactly what the real
      // browser does before opening remote.mux.
      const mint = await fetch(`${origin}/u/core/alpha/?ptoken=${TOKEN_A}`, { redirect: 'manual' })
      const session = mint.headers.getSetCookie().find(c => c.startsWith('dsh-platform-session='))!.split(';')[0] ?? ''
      await mint.text()
      const first = await fetch(`${origin}/u/core/alpha/`, { headers: { cookie: session }, redirect: 'manual' })
      const launchUrl = first.headers.get('location') ?? ''
      await first.text()
      const authed = await fetch(`${origin}${launchUrl}`, { headers: { cookie: session }, redirect: 'manual' })
      const childCookie = authed.headers.getSetCookie().find(c => c.startsWith('dsh-auth-'))!.split(';')[0] ?? ''
      await authed.text()
      await new Promise<void>((resolve, reject) => {
        const socket = connect(platform.port, '127.0.0.1')
        let seen = ''
        socket.on('connect', () => {
          socket.write([
            'GET /u/core/alpha/api/remote.mux HTTP/1.1',
            `host: 127.0.0.1:${String(platform.port)}`,
            'upgrade: websocket',
            'connection: Upgrade',
            'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
            'sec-websocket-version: 13',
            `cookie: ${session}; ${childCookie}`,
            '', '',
          ].join('\r\n'))
        })
        socket.on('data', (chunk: Buffer) => {
          seen += chunk.toString('utf8')
          if (seen.includes('\r\n')) {
            socket.destroy()
            expect(seen).toContain('101')
            resolve()
          }
        })
        socket.on('error', reject)
        setTimeout(() => {
          socket.destroy()
          reject(new Error(`remote.mux tunnel did not upgrade in time: ${seen.slice(0, 200)}`))
        }, 120_000).unref()
      })
    },
    TEST_BUDGET_MS,
  )
})
