/* Tenant portal: a deliberately build-free page over the platform BFF's REST
 * and WebSocket surfaces. All state lives in this module; the BFF owns auth,
 * isolation, and transcript persistence. */
(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const tokenInput = $('token')
  const statusLabel = $('status')
  const sessionsList = $('sessions')
  const logView = $('log')
  const composer = $('composer')
  const promptBox = $('prompt')
  const cwdInput = $('cwd')

  const state = {
    token: '',
    socket: null,
    sessionId: null,
    /** Ordered message views for the current session (echo + streamed). */
    turns: [],
  }

  function api(path, init = {}) {
    return fetch(path, {
      ...init,
      headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json', ...init.headers },
    }).then(async (response) => {
      if (response.status === 401) throw new Error('unauthorized: check the tenant token')
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    })
  }

  function status(text) {
    statusLabel.textContent = text
  }

  function renderTurns() {
    logView.replaceChildren(...state.turns.map((turn) => {
      const node = document.createElement('div')
      node.className = turn.kind
      if (turn.kind === 'permission') {
        node.appendChild(document.createTextNode(`审批请求：${turn.summary} `))
        for (const option of turn.options) {
          const button = document.createElement('button')
          button.textContent = option
          button.addEventListener('click', () => {
            state.socket?.send(JSON.stringify({
              type: 'permission-response',
              id: turn.id,
              response: { outcome: { outcome: 'selected', optionId: option } },
            }))
            node.remove()
          })
          node.appendChild(button)
        }
      } else {
        node.textContent = turn.text
      }
      return node
    }))
    logView.scrollTop = logView.scrollHeight
  }

  function applyUpdate(update) {
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      const last = state.turns[state.turns.length - 1]
      if (last !== undefined && last.kind === 'msg') last.text += update.content.text
      else state.turns.push({ kind: 'msg', text: update.content.text })
    } else if (update.sessionUpdate === 'user_message_chunk' && update.content?.type === 'text') {
      // The composer already echoed the outgoing text; skip server echo.
      return
    } else {
      state.turns.push({ kind: 'raw', text: `${update.sessionUpdate ?? 'update'}` })
    }
    renderTurns()
  }

  async function loadTranscript(sessionId) {
    const rows = await api(`/api/session/${sessionId}/transcript`)
    state.turns = []
    for (const row of rows) applyUpdate(JSON.parse(row.update))
    renderTurns()
  }

  function connectSocket() {
    state.socket?.close()
    const socket = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(state.token)}`)
    state.socket = socket
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.type === 'session-update' && message.sessionId === state.sessionId) {
        applyUpdate(message.update)
      } else if (message.type === 'permission-request') {
        const options = (message.request?.options ?? []).map((option) => option.optionId)
        state.turns.push({
          kind: 'permission',
          id: message.id,
          summary: message.request?.title ?? message.request?.type ?? 'action',
          options: options.length > 0 ? options : ['cancelled'],
        })
        renderTurns()
      }
    })
    socket.addEventListener('close', () => { status('连接已断开') })
  }

  async function refreshSessions() {
    const listed = await api('/api/sessions')
    sessionsList.replaceChildren(...listed.sessions.map((session) => {
      const item = document.createElement('li')
      item.textContent = session.sessionId
      item.setAttribute('data-session-id', session.sessionId)
      if (session.sessionId === state.sessionId) item.setAttribute('aria-current', 'true')
      item.addEventListener('click', async () => {
        state.sessionId = session.sessionId
        await loadTranscript(session.sessionId)
        composer.hidden = false
        refreshSessions().catch(() => {})
      })
      return item
    }))
  }

  async function connect() {
    state.token = tokenInput.value.trim()
    if (state.token === '') {
      status('请输入访问令牌')
      return
    }
    try {
      await refreshSessions()
      connectSocket()
      status('已连接')
    } catch (error) {
      status(error instanceof Error ? error.message : String(error))
    }
  }

  async function newSession() {
    const cwd = cwdInput.value.trim()
    if (cwd === '') {
      status('新建会话需要 workspace 绝对路径')
      return
    }
    try {
      const created = await api('/api/session/new', { method: 'POST', body: JSON.stringify({ cwd }) })
      state.sessionId = created.sessionId
      state.turns = []
      renderTurns()
      composer.hidden = false
      await refreshSessions()
      status(`会话 ${created.sessionId}`)
    } catch (error) {
      status(error instanceof Error ? error.message : String(error))
    }
  }

  async function sendPrompt(event) {
    event.preventDefault()
    const text = promptBox.value
    if (text.trim() === '' || state.sessionId === null) return
    promptBox.value = ''
    state.turns.push({ kind: 'msg user', text })
    renderTurns()
    status('回合进行中…')
    try {
      const result = await api(`/api/session/${state.sessionId}/prompt`, { method: 'POST', body: JSON.stringify({ text }) })
      status(`回合结束（${result.stopReason ?? '?'}）`)
    } catch (error) {
      status(error instanceof Error ? error.message : String(error))
    }
  }

  $('connect').addEventListener('click', () => { void connect() })
  $('refresh').addEventListener('click', () => { void refreshSessions().then(() => { status('列表已刷新') }, (error) => { status(String(error)) }) })
  $('new-session').addEventListener('click', () => { void newSession() })
  composer.addEventListener('submit', (event) => { void sendPrompt(event) })

  window.__tenantPortal = { connect, newSession, refreshSessions, api, state }
})()
