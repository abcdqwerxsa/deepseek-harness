import { rmSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { TranscriptStore } from '../src/transcript.ts'

/**
 * Transcript store unit coverage for the composite `deptId/userId` key and
 * the department-scoped rollups the admin console renders.

 */

const dir = mkdtempSync(join(tmpdir(), 'dsh-transcript-'))
const store = new TranscriptStore(join(dir, 'platform.sqlite'))

afterAll(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const chunk = (update: Record<string, unknown>): unknown => ({ sessionUpdate: 'agent_message_chunk', ...update })

describe('composite tenant keys', () => {
  it('isolates transcripts, sessions, and audits per user key', () => {
    store.registerSession('deptA/user1', 's1', '/ws/one')
    store.append('deptA/user1', 's1', chunk({}))
    store.audit('deptA/user1', 'session-prompt', 's1 stop=end_turn')
    store.registerSession('deptA/user2', 's2', '/ws/two')
    store.audit('deptA/user2', 'session-new', 's2 cwd=/ws/two')

    expect(store.list('deptA/user1', 's1')).toHaveLength(1)
    expect(store.list('deptA/user2', 's1')).toHaveLength(0)
    expect(store.listSessions('deptA/user1').map(s => s.sessionId)).toEqual(['s1'])
    expect(store.sessionCwd('deptA/user2', 's2')).toBe('/ws/two')
    expect(store.usage('deptA/user1').totals.messages).toBe(1)
    expect(store.usage('deptA/user2').totals.messages).toBe(0)
  })
})

describe('department rollups', () => {
  it('aggregates usage across a department without crossing it', () => {
    // user1: one session, two turns, one message; user2: prompts only (audit-only user).
    store.audit('deptB/user1', 'session-prompt', 'sB1 stop=end_turn')
    store.audit('deptB/user1', 'session-prompt', 'sB1 stop=end_turn')
    store.registerSession('deptB/user1', 'sB1', '/ws/b1')
    store.append('deptB/user1', 'sB1', chunk({}))
    store.audit('deptB/user2', 'session-prompt', 'sB2 stop=end_turn')

    const report = store.deptUsage('deptB')
    // Turns follow usage()'s v1 semantics: counted per transcript session row,
    // so a prompts-only user shows with zeros while still being listed.
    expect(report.totals).toEqual({ users: 2, sessions: 1, turns: 2, messages: 1, toolCalls: 0 })
    expect(report.users.find(u => u.userId === 'user1')?.totals.turns).toBe(2)
    expect(report.users.find(u => u.userId === 'user2')?.totals).toEqual({ sessions: 0, turns: 0, messages: 0, toolCalls: 0 })

    // A same-prefix department in another segment must not leak in.
    expect(store.deptUsage('dept').totals.users).toBe(0)
    expect(store.deptUsage('deptC').totals.users).toBe(0)
  })

  it('scopes the department audit trail to that department', () => {
    store.audit('deptC/user1', 'session-new', 'sC1')
    store.audit('deptCX/user1', 'session-new', 'sX1')
    const trail = store.deptAuditTrail('deptC')
    expect(trail.every(row => row.tenantId.startsWith('deptC/'))).toBe(true)
    expect(trail.some(row => row.tenantId === 'deptCX/user1')).toBe(false)
    expect(trail[0]).toMatchObject({ tenantId: 'deptC/user1', event: 'session-new' })
  })
})
