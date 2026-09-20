import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ApiError, apiClient, configOptionsOf, type ConfigOption, type PermissionRequest, type Principal, type SessionInfo } from './api'
import { applyUpdate, emptyChat, finishTurn, fromRows, setTurnError, type ChatState, type SessionUpdate } from './events'
import { TurnView } from './blocks'
import { ModelPicker } from './ModelPicker'
import { PermissionCard } from './PermissionCard'
import { FilePanel } from './FilePanel'
import { AdminPanel } from './AdminPanel'

type Action =
  | { type: 'update'; update: SessionUpdate }
  | { type: 'rows'; rows: readonly { update?: unknown }[] }
  | { type: 'error'; message: string }
  | { type: 'finish' }
  | { type: 'reset' }

function chatReducer(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'update': return applyUpdate(state, action.update)
    case 'rows': return fromRows(action.rows)
    case 'error': return setTurnError(state, action.message)
    case 'finish': return finishTurn(state)
    case 'reset': return emptyChat
  }
}

interface WsMessage {
  readonly type?: string
  readonly sessionId?: string
  readonly update?: SessionUpdate
  readonly id?: string
  readonly request?: unknown
}

export function Chat({ token, principal, onLogout }: {
  token: string
  principal: Principal
  onLogout: () => void
}) {
  const [sessions, setSessions] = useState<readonly SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [chat, dispatch] = useReducer(chatReducer, emptyChat)
  const [posting, setPosting] = useState(false)
  const [connected, setConnected] = useState(false)
  const [draft, setDraft] = useState('')
  const [configOptions, setConfigOptions] = useState<readonly ConfigOption[] | null>(null)
  const [permissions, setPermissions] = useState<readonly { id: string; request: PermissionRequest }[]>([])
  const [filesRefresh, setFilesRefresh] = useState(0)
  const [adminOpen, setAdminOpen] = useState(false)

  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId
  // Set while a transcript resync fetch is in flight; WS updates landing in
  // that window mark the snapshot stale so resync re-runs instead of letting
  // the older snapshot clobber live chunks (reviewer P2).
  const resyncingRef = useRef(false)
  const staleRef = useRef(false)
  // Serialized resync queue: concurrent triggers (WS onopen + session select)
  // must not interleave fetches, or the later-dispatched older snapshot
  // clobbers a newer one with no stale marking (reviewer residual P2).
  const resyncQueueRef = useRef<Promise<void>>(Promise.resolve())
  const sendRef = useRef<WebSocket | null>(null)
  const stickRef = useRef(true)
  const streamRef = useRef<HTMLDivElement>(null)

  const resync = useCallback((sessionId: string | null): Promise<void> => {
    if (sessionId === null) return Promise.resolve()
    const run = resyncQueueRef.current.then(async () => {
      // Bounded passes: each rerun requires updates that landed inside the
      // previous fetch window, so a live stream converges once it settles.
      for (let pass = 0; pass < 5; pass++) {
        if (activeRef.current !== sessionId) return
        resyncingRef.current = true
        staleRef.current = false
        let fetched = true
        try {
          const rows = await apiClient.transcript(sessionId)
          if (activeRef.current === sessionId) dispatch({ type: 'rows', rows })
        } catch {
          fetched = false /* transcript fetch failure keeps current view; next reconnect retries */
        } finally {
          resyncingRef.current = false
        }
        if (!fetched || !(staleRef.current && activeRef.current === sessionId)) return
      }
    })
    resyncQueueRef.current = run.then(() => undefined, () => undefined)
    return run
  }, [])

  // One WebSocket per login. On (re)connect, rebuild from the transcript so
  // updates missed during the disconnect window are never lost.
  useEffect(() => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    let ws: WebSocket | undefined
    const connect = () => {
      ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`)
      sendRef.current = ws
      ws.onopen = () => {
        setConnected(true)
        void resync(activeRef.current)
      }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as WsMessage
          if (msg.type === 'permission-request' && typeof msg.id === 'string') {
            // The BFF replays every pending request on reconnect; dedupe by id.
            setPermissions(prev => prev.some(entry => entry.id === msg.id)
              ? prev
              : [...prev, { id: msg.id as string, request: (msg.request ?? {}) as PermissionRequest }])
          }
          if (msg.type === 'session-update' && msg.sessionId === activeRef.current && msg.update !== undefined) {
            if (resyncingRef.current) staleRef.current = true
            if (msg.update.sessionUpdate === 'config_option_update' && msg.update.configOptions !== undefined) {
              setConfigOptions(configOptionsOf(msg.update.configOptions))
            }
            dispatch({ type: 'update', update: msg.update })
          }
        } catch {
          /* malformed frames are dropped, matching the BFF tolerance */
        }
      }
      ws.onclose = () => {
        setConnected(false)
        // ponytail: fixed 3s retry, no backoff — intranet server restarts are
        // the only realistic outage; add jittered backoff if this ever faces WAN.
        if (!closed) timer = setTimeout(connect, 3000)
      }
    }
    connect()
    return () => {
      closed = true
      if (timer !== undefined) clearTimeout(timer)
      ws?.close()
      sendRef.current = null
    }
  }, [token, resync])

  useEffect(() => {
    void apiClient.sessions().then((data) => {
      setSessions(data.sessions)
    }).catch(err => {
      // An expired session must leave the dead shell, not linger in it.
      if (err instanceof ApiError && err.status === 401) onLogout()
    })
  }, [onLogout])

  const selectSession = useCallback((sessionId: string) => {
    setActiveId(sessionId)
    activeRef.current = sessionId
    stickRef.current = true
    setConfigOptions(null)
    setPermissions([])
    dispatch({ type: 'reset' })
    void resync(sessionId)
  }, [resync])

  const startDraft = useCallback(() => {
    setActiveId(null)
    activeRef.current = null
    setConfigOptions(null)
    setPermissions([])
    dispatch({ type: 'reset' })
  }, [])

  const sendPrompt = useCallback(async () => {
    const text = draft.trim()
    if (text === '' || posting) return
    setPosting(true)
    setDraft('')
    let sessionId = activeRef.current
    try {
      if (sessionId === null) {
        const created = await apiClient.sessionNew()
        const sid = created.sessionId
        sessionId = sid
        setActiveId(sid)
        activeRef.current = sid
        setConfigOptions(created.configOptions === undefined ? null : configOptionsOf(created.configOptions))
        setSessions(prev => [{ sessionId: sid, cwd: created.cwd }, ...prev])
      }
      // The user bubble arrives via the WS echo the BFF broadcasts — no
      // local append, so reload/replay/live render identically.
      // Snapshot the session: a switch or a second operator on another tab
      // must not settle or error the turn now displayed (reviewer P2).
      const prompted = sessionId
      await apiClient.prompt(prompted, text)
      if (activeRef.current === prompted) {
        dispatch({ type: 'finish' })
        setFilesRefresh(key => key + 1)
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onLogout()
        return
      }
      if (activeRef.current === sessionId) dispatch({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setPosting(false)
    }
  }, [draft, posting, onLogout])

  const answerPermission = useCallback((id: string, outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }) => {
    const ws = sendRef.current
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'permission-response', id, response: { outcome } }))
    }
    setPermissions(prev => prev.filter(entry => entry.id !== id))
  }, [])

  const onScroll = () => {
    const el = streamRef.current
    if (el !== null) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useEffect(() => {
    const el = streamRef.current
    if (el !== null && stickRef.current) {
      requestAnimationFrame(() => { if (stickRef.current && el.isConnected) el.scrollTop = el.scrollHeight })
    }
  }, [chat])

  const activeSession = useMemo(
    () => sessions.find(s => s.sessionId === activeId) ?? null,
    [sessions, activeId],
  )

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar-head">
          <span className="brand">⬢ 智能体工作台</span>
          <span className={`conn ${connected ? 'on' : 'off'}`}>{connected ? '● 在线' : '○ 连接中'}</span>
        </div>
        <button className="new-task" onClick={startDraft}>＋ 新建任务</button>
        <div className="session-list">
          {sessions.map(s => (
            <button
              key={s.sessionId}
              className={`session-item ${s.sessionId === activeId ? 'active' : ''}`}
              onClick={() => selectSession(s.sessionId)}
              title={s.cwd ?? s.sessionId}
            >
              <span className="session-title">{s.sessionId.slice(0, 8)}</span>
              <span className="session-cwd">{s.cwd?.split('/').filter(Boolean).slice(-2).join('/') ?? ''}</span>
            </button>
          ))}
          {sessions.length === 0 && <div className="session-empty">暂无历史任务</div>}
        </div>
        <div className="sidebar-foot">
          <div className="who">
            <span className="who-dept">{principal.deptId}</span>
            <span className="who-user">{principal.userId}</span>
          </div>
          <button className="logout" onClick={onLogout}>退出</button>
        </div>
        {principal.role !== 'member' && (
          <button className="admin-entry" onClick={() => setAdminOpen(true)}>⚙ 管理控制台</button>
        )}
      </aside>

      <main className="main">
        <header className="main-head">
          <span className="task-name">{activeSession !== null ? activeSession.sessionId.slice(0, 12) : '新任务'}</span>
          <ModelPicker sessionId={activeId} configOptions={configOptions} onApplied={(sid, options) => { if (activeRef.current === sid) setConfigOptions(options) }} />
          {posting && <span className="posting">执行中…</span>}
        </header>
        <div className="workspace-row">
          <div className="main-col">
            <div className="stream" ref={streamRef} onScroll={onScroll}>
              {chat.turns.length === 0 && activeId === null && <Welcome onPick={setDraft} />}
              {chat.turns.map(turn => <TurnView key={turn.id} turn={turn} />)}
              {permissions.map(entry => (
                <PermissionCard
                  key={entry.id}
                  request={entry.request}
                  onAnswer={outcome => answerPermission(entry.id, outcome)}
                />
              ))}
            </div>
            <footer className="composer">
          <textarea
            value={draft}
            placeholder="描述你的任务…（Enter 发送，Shift+Enter 换行）"
            rows={3}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void sendPrompt()
              }
            }}
          />
          <button className="send" disabled={posting || draft.trim() === ''} onClick={() => void sendPrompt()}>
            {posting ? '执行中…' : '发送'}
          </button>
          </footer>
          </div>
          <FilePanel refreshKey={filesRefresh} onRefresh={() => setFilesRefresh(key => key + 1)} />
        </div>
      </main>
      {adminOpen && <AdminPanel principal={principal} onClose={() => setAdminOpen(false)} />}
    </div>
  )
}

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  const examples: [string, string, string][] = [
    ['📂', '检查当前工作区与环境', '列出当前工作区的所有文件，并告诉我环境信息'],
    ['📊', '数据分析脚本', '编写一个处理 CSV 数据的 Python 脚本，提取关键统计指标'],
    ['⚙️', '检查可用工具', '检查可用工具和 MCP 服务集成状态'],
  ]
  return (
    <div className="welcome">
      <div className="welcome-icon">⬢</div>
      <h2>新建智能体任务</h2>
      <p>任务在专属沙箱环境中执行。输入数据分析、自动化脚本或业务需求，首个消息发出时自动创建任务。</p>
      <div className="welcome-examples">
        {examples.map(([icon, title, prompt]) => (
          <button key={title} onClick={() => onPick(prompt)}>
            <span>{icon}</span> {title}
          </button>
        ))}
      </div>
    </div>
  )
}
