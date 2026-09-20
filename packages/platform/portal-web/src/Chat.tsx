import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { apiClient, type Principal, type SessionInfo } from './api'
import { applyUpdate, emptyChat, finishTurn, fromRows, setTurnError, type ChatState, type SessionUpdate } from './events'
import { TurnView } from './blocks'

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

  const activeRef = useRef<string | null>(null)
  activeRef.current = activeId
  const wsRef = useRef<WebSocket | null>(null)
  const stickRef = useRef(true)
  const streamRef = useRef<HTMLDivElement>(null)

  const resync = useCallback(async (sessionId: string | null) => {
    if (sessionId === null) return
    try {
      const rows = await apiClient.transcript(sessionId)
      if (activeRef.current === sessionId) dispatch({ type: 'rows', rows })
    } catch {
      /* transcript fetch failure keeps current view; next reconnect retries */
    }
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
      wsRef.current = ws
      ws.onopen = () => {
        setConnected(true)
        void resync(activeRef.current)
      }
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as WsMessage
          if (msg.type === 'session-update' && msg.sessionId === activeRef.current && msg.update !== undefined) {
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
      wsRef.current = null
    }
  }, [token, resync])

  useEffect(() => {
    void apiClient.sessions().then((data) => {
      setSessions(data.sessions)
    }).catch(() => { /* sidebar shows empty; sessions retry on next action */ })
  }, [])

  const selectSession = useCallback((sessionId: string) => {
    setActiveId(sessionId)
    activeRef.current = sessionId
    stickRef.current = true
    dispatch({ type: 'reset' })
    void resync(sessionId)
  }, [resync])

  const startDraft = useCallback(() => {
    setActiveId(null)
    activeRef.current = null
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
        setSessions(prev => [{ sessionId: sid, cwd: created.cwd }, ...prev])
      }
      // The user bubble arrives via the WS echo the BFF broadcasts — no
      // local append, so reload/replay/live render identically.
      await apiClient.prompt(sessionId, text)
      dispatch({ type: 'finish' })
    } catch (err) {
      dispatch({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      setPosting(false)
    }
  }, [draft, posting])

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
      </aside>

      <main className="main">
        <header className="main-head">
          <span className="task-name">{activeSession !== null ? activeSession.sessionId.slice(0, 12) : '新任务'}</span>
          {posting && <span className="posting">执行中…</span>}
        </header>
        <div className="stream" ref={streamRef} onScroll={onScroll}>
          {chat.turns.length === 0 && activeId === null && <Welcome onPick={setDraft} />}
          {chat.turns.map(turn => <TurnView key={turn.id} turn={turn} />)}
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
      </main>
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
