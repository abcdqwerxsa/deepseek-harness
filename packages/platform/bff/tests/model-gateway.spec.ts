import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { devTokenAuthenticator, type DevTokenIdentity } from '../src/auth.ts'

const ident = (userId: string, deptId = 'core'): DevTokenIdentity => ({ deptId, userId, role: 'member' })
import { startPlatformServer, type PlatformServer } from '../src/index.ts'
import { signModelToken } from '../src/model-token.ts'

/**
 * Model gateway behavior: signed tokens gate the internal endpoint, provider
 * calls stream through with the real key (which never leaves this process),
 * and usage lands in the audit trail.
 */

const TOKEN = 'gw-token'
const upstreamServer: { server?: Server; calls: { auth: string; body: string }[] } = { calls: [] }

function startUpstream(): Promise<void> {
  return new Promise((resolve) => {
    upstreamServer.server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
      req.on('end', () => {
        upstreamServer.calls.push({ auth: req.headers.authorization ?? '', body })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          id: 'cmpl-x',
          choices: [{ index: 0, message: { role: 'assistant', content: 'GATEWAY OK' } }],
          usage: { prompt_tokens: 11, completion_tokens: 7 },
        }))
      })
    })
    upstreamServer.server.listen(0, '127.0.0.1', () => { resolve() })
  })
}

const cleanup: Array<() => Promise<void> | void> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
  upstreamServer.calls.length = 0
})

describe('model gateway', () => {
  it('forwards authenticated calls, meters usage, and keeps the upstream key internal', async () => {
    await startUpstream()
    cleanup.push(() => new Promise<void>((resolve) => { upstreamServer.server?.close(() => { resolve() }) }))
    const port = (upstreamServer.server?.address() as { port: number }).port

    const platform: PlatformServer = await startPlatformServer({
      authenticator: devTokenAuthenticator(new Map([[TOKEN, ident('alpha')]])),
      createRuntime: async () => { throw new Error('no runtime needed') },
      modelGateway: {
        secret: 'test-secret',
        upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
        upstreamApiKey: 'real-provider-key',
      },
    })
    cleanup.push(() => platform.close())

    // No/invalid token: 401.
    const unauthorized = await fetch(`http://127.0.0.1:${platform.port}/internal/model/v1/chat/completions`, {
      method: 'POST', body: '{}',
    })
    expect(unauthorized.status).toBe(401)

    // Valid signed token: streams through with the real key.
    const modelToken = signModelToken('test-secret', 'core', 'alpha')
    const forwarded = await fetch(`http://127.0.0.1:${platform.port}/internal/model/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${modelToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(forwarded.status).toBe(200)
    const body = await forwarded.json() as { choices: { message: { content: string } }[] }
    expect(body.choices[0]!.message.content).toBe('GATEWAY OK')
    expect(upstreamServer.calls).toHaveLength(1)
    expect(upstreamServer.calls[0]!.auth).toBe('Bearer real-provider-key')
    expect(upstreamServer.calls[0]!.body).toContain('hi')

    // Metering landed in the audit trail under the token's tenant.
    const audit = await (await fetch(`http://127.0.0.1:${platform.port}/api/audit`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })).json() as { event: string; detail: string }[]
    const metered = audit.find(entry => entry.event === 'model-call')
    expect(metered?.detail).toContain('tokens=11+7')
    expect(metered?.detail).toContain('status=200')
  })

  it('rejects forged and expired tokens', async () => {
    await startUpstream()
    cleanup.push(() => new Promise<void>((resolve) => { upstreamServer.server?.close(() => { resolve() }) }))
    const port = (upstreamServer.server?.address() as { port: number }).port
    const platform: PlatformServer = await startPlatformServer({
      authenticator: devTokenAuthenticator(new Map([[TOKEN, ident('alpha')]])),
      createRuntime: async () => { throw new Error('no runtime needed') },
      modelGateway: { secret: 'test-secret', upstreamBaseUrl: `http://127.0.0.1:${port}/v1`, upstreamApiKey: 'k' },
    })
    cleanup.push(() => platform.close())
    const endpoint = `http://127.0.0.1:${platform.port}/internal/model/v1/chat/completions`

    const forged = await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer mt_forged.sig' }, body: '{}' })
    expect(forged.status).toBe(401)
    const wrongSecret = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${signModelToken('other-secret', 'alpha')}` },
      body: '{}',
    })
    expect(wrongSecret.status).toBe(401)
    const expired = await fetch(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${signModelToken('test-secret', 'alpha', undefined, -1)}` },
      body: '{}',
    })
    expect(expired.status).toBe(401)
    expect(upstreamServer.calls).toHaveLength(0)
  })
})
