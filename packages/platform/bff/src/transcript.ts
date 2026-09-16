import { DatabaseSync } from 'node:sqlite'

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
}
