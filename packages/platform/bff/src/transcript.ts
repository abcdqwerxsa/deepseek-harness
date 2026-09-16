import { DatabaseSync } from 'node:sqlite'

/** Per-tenant usage aggregates (v1: update-stream counts, not billing tokens). */
export interface UsageReport {
  readonly totals: { sessions: number; turns: number; messages: number; toolCalls: number }
  readonly sessions: readonly {
    sessionId: string
    turns: number
    messages: number
    toolCalls: number
    contextUsed: number | null
    contextSize: number | null
  }[]
}

/**
 * Platform-side transcript store: every ACP `session/update` the BFF observes
 * is appended here in arrival order, because ACP `session/resume` never
 * replays history — the portal renders prior turns from this table.
 * @module
 */

export interface TranscriptRow {
  readonly seq: number
  readonly sessionId: string
  readonly update: string
  readonly receivedAt: string
}

export class TranscriptStore {
  private readonly db: DatabaseSync

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transcript (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        update_json TEXT NOT NULL,
        received_at TEXT NOT NULL
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS transcript_tenant_session ON transcript (tenant_id, session_id, seq)')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        event TEXT NOT NULL,
        detail TEXT
      )
    `)
    this.db.exec('CREATE INDEX IF NOT EXISTS audit_tenant_seq ON audit (tenant_id, seq)')
  }

  append(tenantId: string, sessionId: string, update: unknown): void {
    const json = JSON.stringify(update)
    const receivedAt = new Date().toISOString()
    this.db.prepare('INSERT INTO transcript (tenant_id, session_id, update_json, received_at) VALUES (?, ?, ?, ?)')
      .run(tenantId, sessionId, json, receivedAt)
  }

  list(tenantId: string, sessionId: string): TranscriptRow[] {
    const statement = this.db.prepare(
      'SELECT seq, session_id, update_json, received_at FROM transcript WHERE tenant_id = ? AND session_id = ? ORDER BY seq',
    )
    return statement.all(tenantId, sessionId).map((row) => {
      const record = row as { seq: number; session_id: string; update_json: string; received_at: string }
      return { seq: record.seq, sessionId: record.session_id, update: record.update_json, receivedAt: record.received_at }
    })
  }

  close(): void {
    this.db.close()
  }

  /** Append one audit event (auth failures, session lifecycle, permission answers). */
  audit(tenantId: string, event: string, detail?: string): void {
    this.db.prepare('INSERT INTO audit (at, tenant_id, event, detail) VALUES (?, ?, ?, ?)')
      .run(new Date().toISOString(), tenantId, event, detail ?? null)
  }

  /** Per-tenant audit trail, newest first. */
  auditTrail(tenantId: string, limit = 100): { at: string; event: string; detail: string | null }[] {
    const rows = this.db.prepare(
      'SELECT at, event, detail FROM audit WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?',
    ).all(tenantId, limit)
    return rows.map((row) => {
      const record = row as { at: string; event: string; detail: string | null }
      return { at: record.at, event: record.event, detail: record.detail }
    })
  }

  /**
   * Per-tenant usage aggregates: sessions, turns (successful session-prompt
   * audit rows per session — dsh's ACP bridge emits no user-message updates),
   * agent message chunks, tool calls, and the peak context occupancy observed
   * per session. ACP reports occupancy, not billing-grade token counts; chunk
   * counts are not distinct-message counts — the recorded v1 ceiling.
   */
  usage(tenantId: string): UsageReport {
    const promptCounts = new Map<string, number>()
    const auditRows = this.db.prepare(
      "SELECT detail FROM audit WHERE tenant_id = ? AND event = 'session-prompt'",
    ).all(tenantId)
    for (const row of auditRows) {
      const raw = (row as { detail: string | null }).detail ?? ''
      const sessionId = raw.split(' ')[0] ?? ''
      if (sessionId !== '') promptCounts.set(sessionId, (promptCounts.get(sessionId) ?? 0) + 1)
    }
    const rows = this.db.prepare(`
      SELECT
        session_id AS sessionId,
        SUM(CASE WHEN json_extract(update_json, '$.sessionUpdate') = 'agent_message_chunk' THEN 1 ELSE 0 END) AS messages,
        SUM(CASE WHEN json_extract(update_json, '$.sessionUpdate') = 'tool_call' THEN 1 ELSE 0 END) AS toolCalls,
        MAX(CASE WHEN json_extract(update_json, '$.sessionUpdate') = 'usage_update'
          THEN json_extract(update_json, '$.used') END) AS contextUsed,
        MAX(CASE WHEN json_extract(update_json, '$.sessionUpdate') = 'usage_update'
          THEN json_extract(update_json, '$.size') END) AS contextSize
      FROM transcript WHERE tenant_id = ?
      GROUP BY session_id
      ORDER BY session_id
    `).all(tenantId)
    const sessions = rows.map((row) => {
      const record = row as Record<string, number | string | null>
      const number = (value: number | string | null | undefined): number => (typeof value === 'number' ? value : 0)
      return {
        sessionId: String(record.sessionId),
        turns: promptCounts.get(String(record.sessionId)) ?? 0,
        messages: number(record.messages),
        toolCalls: number(record.toolCalls),
        contextUsed: typeof record.contextUsed === 'number' ? record.contextUsed : null,
        contextSize: typeof record.contextSize === 'number' ? record.contextSize : null,
      }
    })
    return {
      totals: {
        sessions: sessions.length,
        turns: sessions.reduce((sum, entry) => sum + entry.turns, 0),
        messages: sessions.reduce((sum, entry) => sum + entry.messages, 0),
        toolCalls: sessions.reduce((sum, entry) => sum + entry.toolCalls, 0),
      },
      sessions,
    }
  }
}
