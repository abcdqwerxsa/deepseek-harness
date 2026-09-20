import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { devTokenAuthenticator } from '../src/auth.ts'
import { startPlatformServer, type PlatformServer } from '../src/index.ts'

/**
 * Portal static-serving contract: the SPA build drops exactly
 * index.html / portal.js / portal.css into ../portal, and the BFF serves
 * them same-origin with no-store. The old JSDOM full-page suite was
 * replaced together with the vanilla portal; streaming logic lives in
 * portal-web's reducer spec, and full-page e2e returns with the SPA
 * migration's deploy milestone.
 */

const portalDir = join(fileURLToPath(new URL('../portal', import.meta.url)))

let server: PlatformServer | undefined
let base = ''

beforeAll(async () => {
  if (!existsSync(join(portalDir, 'portal.js')) || !existsSync(join(portalDir, 'index.html'))) {
    throw new Error(`portal artifacts missing in ${portalDir}: run "pnpm --filter @deepseek-ai/dsh-platform-portal-web run build" first`)
  }
  server = await startPlatformServer({
    authenticator: devTokenAuthenticator(new Map([
      ['portal-member', { deptId: 'deptA', userId: 'user1', role: 'user' }],
    ])),
    createRuntime: async tenantId => ({
      tenantId,
      request: async <T>(method: string): Promise<T> => {
        throw new Error(`unexpected ACP call in portal smoke spec: ${method}`)
      },
      onUpdate: () => () => {},
      onPermission: () => {},
      get lastUsedAt(): number {
        return Date.now()
      },
      dispose: async () => {},
      exited: () => new Promise<void>(() => {}),
    }),
  })
  base = `http://127.0.0.1:${String(server.port)}`
})

afterAll(async () => {
  await server?.close()
})

describe('portal static serving', () => {
  it('serves the SPA shell at /', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const html = await res.text()
    expect(html).toContain('id="root"')
    expect(html).toContain('portal.js')
  })

  it('serves the bundle and stylesheet under their fixed names', async () => {
    const js = await fetch(`${base}/portal.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('text/javascript')
    expect((await js.text()).length).toBeGreaterThan(1000)

    const css = await fetch(`${base}/portal.css`)
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
    expect((await css.text()).length).toBeGreaterThan(1000)
  })

  it('keeps the API bearer-gated beside the static shell', async () => {
    const anon = await fetch(`${base}/api/whoami`)
    expect(anon.status).toBe(401)

    const authed = await fetch(`${base}/api/whoami`, {
      headers: { authorization: 'Bearer portal-member' },
    })
    expect(authed.status).toBe(200)
    expect(await authed.json()).toMatchObject({ deptId: 'deptA', userId: 'user1' })
  })

  it('404s unknown non-API paths', async () => {
    const res = await fetch(`${base}/nope`)
    expect(res.status).toBe(404)
  })
})
