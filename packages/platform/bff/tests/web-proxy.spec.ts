import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect } from 'node:net'
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { devTokenAuthenticator, type DevTokenIdentity } from '../src/auth.ts'
import { startPlatformServer, type PlatformServer } from '../src/index.ts'
import type { WebRuntime } from '@deepseek-ai/dsh-orchestrator'

/**
 * Web proxy behavior against an in-process fake `dsh web` child with the
 * child's real auth semantics (launch-token mint, dsh-auth cookie, 401
 * without one, `<base href="/">` index, Host-checked /api, ws upgrades).
 * Coverage of the real CLI child lives in bff-web.e2e.ts.

 */

const ident = (userId: string, deptId = 'core'): DevTokenIdentity => ({ deptId, userId, role: 'member' })
const TOKEN_A = 'token-alpha'

const cleanupFns: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanupFns.length > 0) await cleanupFns.pop()!()
})

afterAll(async () => {
  while (cleanupFns.length > 0) await cleanupFns.pop()!()
})

/**
 * A fake dsh web child: index auth exactly like the real one (valid
 * `?token=` mints a `Path=/` dsh-auth cookie with a 303 to `/`; a valid
 * cookie serves the `<base href="/">` shell; anything else 401s), /api
 * echoes method/path/host/body, upgrades echo the stripped target path then
 * bytes.
 */
class FakeDshWeb {
  readonly launchToken = `lt-${randomBytes(8).toString('base64url')}`
  readonly server: Server
  seenHosts: string[] = []

  constructor() {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      this.seenHosts.push(request.headers.host ?? '')
      if (url.pathname === '/') {
        if (url.searchParams.get('token') === this.launchToken) {
          response.writeHead(303, {
            location: '/',
            'set-cookie': 'dsh-auth-demo=v1.xyz; Max-Age=2592000; Path=/; Expires=Fri, 01 Jan 2100 00:00:00 GMT; HttpOnly; SameSite=Strict',
          })
          response.end()
          return
        }
        if ((request.headers.cookie ?? '').includes('dsh-auth-demo=')) {
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          response.end('<!doctype html><html lang="en"><head><base href="/"><title>DSH</title></head><body><div id="root"></div></body></html>')
          return
        }
        response.writeHead(401)
        response.end('unauthorized')
        return
      }
      if (url.pathname.startsWith('/api/')) {
        const chunks: Buffer[] = []
        request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        request.on('end', () => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ path: url.pathname, method: request.method, body: Buffer.concat(chunks).toString('utf8') }))
        })
        return
      }
      response.writeHead(200, { 'content-type': 'text/javascript' })
      response.end(`console.log(${JSON.stringify(url.pathname)})`)
    })
    this.server.on('upgrade', (request, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      socket.write(`${url.pathname}\n`)
      if (head.length > 0) socket.write(head)
      socket.pipe(socket)
    })
  }

  async listen(port: number): Promise<void> {
    await new Promise<void>((resolve) => { this.server.listen(port, '127.0.0.1', () => { resolve() }) })
  }
}

async function startFakePlatform(): Promise<{ platform: PlatformServer; child: FakeDshWeb }> {
  const child = new FakeDshWeb()
  const platform = await startPlatformServer({
    authenticator: devTokenAuthenticator(new Map([[TOKEN_A, ident('alpha')]])),
    createRuntime: async () => { throw new Error('no acp runtime needed') },
    webRuntimes: {
      factory: async (key, port): Promise<WebRuntime> => {
        await child.listen(port)
        const address = child.server.address() as AddressInfo
        return {
          key,
          port: address.port,
          launchToken: child.launchToken,
          lastUsedAt: Date.now(),
          dispose: async () => { await new Promise<void>((resolve) => { child.server.close(() => { resolve() }) }) },
          exited: () => new Promise<void>(() => {}),
        }
      },
      portMin: 19_600,
      portMax: 19_610,
    },
  })
  cleanupFns.push(() => platform.close())
  return { platform, child }
}

function base(platform: PlatformServer): string {
  return `http://127.0.0.1:${String(platform.port)}`
}

function cookieJar(response: Response): string[] {
  return response.headers.getSetCookie()
}

function cookieValue(setCookies: string[], name: string): string | undefined {
  for (const cookie of setCookies) {
    if (cookie.startsWith(`${name}=`)) return cookie.split(';')[0]!
  }
  return undefined
}

describe('web proxy platform session', () => {
  it('rejects unauthenticated mounts with 401', async () => {
    const { platform } = await startFakePlatform()
    const response = await fetch(`${base(platform)}/u/core/alpha/`)
    expect(response.status).toBe(401)
    await response.text()
  })

  it('mints the platform session from ptoken and lands clean', async () => {
    const { platform } = await startFakePlatform()
    const response = await fetch(`${base(platform)}/u/core/alpha/?ptoken=${TOKEN_A}`, { redirect: 'manual' })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/u/core/alpha/')
    const session = cookieValue(cookieJar(response), 'dsh-platform-session')
    expect(session).toBe('dsh-platform-session=token-alpha')
    expect(cookieJar(response)[0]).toContain('Path=/u/')
    await response.text()
  })

  it('forbids cross-user and cross-department mounts', async () => {
    const { platform } = await startFakePlatform()
    for (const path of ['/u/core/beta/', '/u/other/alpha/']) {
      // Mint the session first (identity-level), then hit the mount.
      const mint = await fetch(`${base(platform)}${path}?ptoken=${TOKEN_A}`, { redirect: 'manual' })
      const session = cookieValue(cookieJar(mint), 'dsh-platform-session')
      expect(session).toBeDefined()
      await mint.text()
      const response = await fetch(`${base(platform)}${path}`, {
        headers: { cookie: session ?? '' },
        redirect: 'manual',
      })
      expect(response.status).toBe(403)
      await response.text()
    }
  })
})

describe('web proxy child auth dance and base rewrite', () => {
  it('redirects through the launch token to a minted, subpath-scoped cookie', async () => {
    const { platform, child } = await startFakePlatform()
    const session = 'dsh-platform-session=token-alpha'

    // Authenticated session, no child cookie: proxy offers the launch token.
    const first = await fetch(`${base(platform)}/u/core/alpha/`, { headers: { cookie: session }, redirect: 'manual' })
    expect(first.status).toBe(303)
    expect(first.headers.get('location')).toBe(`/u/core/alpha/?token=${child.launchToken}`)
    await first.text()

    // The token presentation: child mints, proxy rewrites cookie path and
    // redirect location into the subpath.
    const minted = await fetch(`${base(platform)}/u/core/alpha/?token=${child.launchToken}`, { headers: { cookie: session }, redirect: 'manual' })
    expect(minted.status).toBe(303)
    expect(minted.headers.get('location')).toBe('/u/core/alpha/')
    const childCookie = cookieValue(cookieJar(minted), 'dsh-auth-demo')
    expect(childCookie).toBeDefined()
    expect(cookieJar(minted).find(c => c.startsWith('dsh-auth-demo='))).toContain('Path=/u/core/alpha/')
    await minted.text()

    // Both cookies: index served with the base rewritten to the mount.
    const index = await fetch(`${base(platform)}/u/core/alpha/`, { headers: { cookie: `${session}; ${childCookie}` } })
    expect(index.status).toBe(200)
    const html = await index.text()
    expect(html).toContain('<base href="/u/core/alpha/">')
  })
})

describe('web proxy passthrough', () => {
  it('forwards api posts with the prefix stripped and Host preserved', async () => {
    const { platform, child } = await startFakePlatform()
    const response = await fetch(`${base(platform)}/u/core/alpha/api/goals/create`, {
      method: 'POST',
      headers: { cookie: 'dsh-platform-session=token-alpha', 'content-type': 'application/json', host: `127.0.0.1:${String(platform.port)}` },
      body: JSON.stringify({ hello: 'world' }),
    })
    expect(response.status).toBe(200)
    const echoed = await response.json() as { path: string; method: string; body: string }
    expect(echoed.path).toBe('/api/goals/create')
    expect(echoed.method).toBe('POST')
    expect(JSON.parse(echoed.body)).toEqual({ hello: 'world' })
    // Host preservation is the child's trust-fence contract.
    expect(child.seenHosts.at(-1)).toBe(`127.0.0.1:${String(platform.port)}`)
  })

  it('serves static assets from the mount', async () => {
    const { platform } = await startFakePlatform()
    const response = await fetch(`${base(platform)}/u/core/alpha/assets/app.js`, {
      headers: { cookie: 'dsh-platform-session=token-alpha' },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript')
    expect(await response.text()).toContain('/assets/app.js')
  })

  it('redirects the bare mount to its trailing slash', async () => {
    const { platform } = await startFakePlatform()
    const response = await fetch(`${base(platform)}/u/core/alpha`, { redirect: 'manual' })
    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('/u/core/alpha/')
    await response.text()
  })
})

describe('web proxy websocket tunnel', () => {
  it('tunnels upgrades with the prefix stripped', async () => {
    const { platform } = await startFakePlatform()
    await new Promise<void>((resolve, reject) => {
      const socket = connect(platform.port, '127.0.0.1')
      const lines: string[] = []
      let buffer = ''
      socket.on('connect', () => {
        socket.write([
          'GET /u/core/alpha/api/remote.mux HTTP/1.1',
          `host: 127.0.0.1:${String(platform.port)}`,
          'upgrade: websocket',
          'connection: Upgrade',
          'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version: 13',
          'cookie: dsh-platform-session=token-alpha',
          '', '',
        ].join('\r\n'))
      })
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd >= 0 && lines.length === 0) {
          lines.push(buffer.slice(0, headerEnd))
          buffer = buffer.slice(headerEnd + 4)
          socket.write('ping-through-tunnel')
        }
        if (buffer.includes('ping-through-tunnel')) {
          expect(lines[0]).toContain('101')
          expect(buffer.split('\n')[0]).toBe('/api/remote.mux')
          socket.destroy()
          resolve()
        }
      })
      socket.on('error', reject)
      setTimeout(() => { socket.destroy(); reject(new Error('tunnel timed out')) }, 5_000).unref()
    })
  })

  it('rejects unauthenticated upgrades', async () => {
    const { platform } = await startFakePlatform()
    await new Promise<void>((resolve, reject) => {
      const socket = connect(platform.port, '127.0.0.1')
      let seen = ''
      socket.on('connect', () => {
        socket.write([
          'GET /u/core/alpha/api/remote.mux HTTP/1.1',
          `host: 127.0.0.1:${String(platform.port)}`,
          'upgrade: websocket',
          'connection: Upgrade',
          '', '',
        ].join('\r\n'))
      })
      socket.on('data', (chunk: Buffer) => {
        seen += chunk.toString('utf8')
      })
      socket.on('close', () => {
        expect(seen).toContain('401')
        resolve()
      })
      socket.on('error', reject)
      setTimeout(() => { socket.destroy(); reject(new Error('upgrade timed out')) }, 5_000).unref()
    })
  })
})

void WebSocket
