/* Enterprise Agent Mission Cockpit (Option B)
 * Pure vanilla ESM - no build tools, zero runtime dependencies.
 */
(function () {
  'use strict'

  const $ = (id) => (typeof document !== 'undefined' && document ? document.getElementById(id) : null)
  const state = {
    token: '',
    principal: null,
    ws: null,
    reconnectTimer: null,
    isBusy: false,
    sessions: [],
    activeSessionId: null,
    files: [],
    currentThoughtText: '',
    currentAgentText: '',
    typewriterTimer: null,
    typewriterTargetText: '',
    typewriterRenderedLen: 0,
  }

  // API helper
  async function api(path, init = {}) {
    const headers = {
      'content-type': 'application/json',
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
      ...init.headers,
    }
    const res = await fetch(path, { ...init, headers })
    if (res.status === 401) {
      logout()
      throw new Error('未授权或登录已过期')
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `HTTP ${res.status}`)
    }
    return res.json()
  }

  function escapeHtml(str) {
    if (!str) return ''
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;')
  }

  // Simple Markdown renderer
  function formatMarkdown(text) {
    if (!text) return ''
    let html = escapeHtml(text)
    // Code blocks ```code```
    html = html.replace(/```([a-z0-9_-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      return `<pre><code class="language-${lang}">${code}</code></pre>`
    })
    // Inline code `code`
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold **text**
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Line breaks
    html = html.replace(/\n/g, '<br>')
    return html
  }

  // Format bytes
  function formatBytes(bytes) {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  // WebSocket connection
  function connectWs() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
    if (state.ws) {
      state.ws.onclose = null
      state.ws.onerror = null
      try { state.ws.close() } catch {}
    }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${location.host}/ws?token=${encodeURIComponent(state.token)}`
    const ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      const badge = $('sandbox-badge')
      if (badge) badge.hidden = false
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        handleWsMessage(msg)
      } catch (e) {
        console.error('[cockpit] WS parse error:', e)
      }
    }

    ws.onclose = () => {
      const badge = $('sandbox-badge')
      if (badge) badge.hidden = true
      // Reconnect after 3s if still authenticated
      if (state.token) {
        state.reconnectTimer = setTimeout(connectWs, 3000)
      }
    }

    state.ws = ws
  }

  // Handle incoming WS events
  function handleWsMessage(msg) {
    if (msg.type === 'session-update' && msg.sessionId === state.activeSessionId) {
      const update = msg.update || {}
      const kind = update.sessionUpdate

      if (kind === 'user_message_chunk') {
        const text = update.content?.text || ''
        const lastMsg = $('chat-messages').lastElementChild
        const alreadyRendered = lastMsg && lastMsg.classList.contains('message-user') && lastMsg.textContent === text
        if (!alreadyRendered) {
          finishCurrentTurn()
          appendUserMessage(text)
        }
      } else if (kind === 'agent_thought_chunk') {
        const text = update.content?.text || ''
        state.currentThoughtText += text
        renderThoughtChunk(state.currentThoughtText)
      } else if (kind === 'tool_call') {
        renderToolCall(update)
      } else if (kind === 'tool_call_update') {
        renderToolCallUpdate(update)
      } else if (kind === 'agent_message_chunk') {
        const text = update.content?.text || ''
        state.currentAgentText += text
        renderAgentChunk(state.currentAgentText)
      }
    } else if (msg.type === 'permission-request') {
      renderPermissionRequest(msg.id, msg.request)
    }
  }

  // UI: Thought Flow (Cherry Studio Style)
  function renderThoughtChunk(fullText) {
    let container = document.querySelector('.active-thought-container')
    if (!container) {
      container = document.createElement('div')
      container.className = 'thought-container active-thought-container active-thought-card'
      container.innerHTML = `
        <div class="thought-header">
          <div class="thought-header-left">
            <span class="thought-arrow">▶</span>
            <span class="thought-pulse"></span>
            <span class="thought-title">DeepSeek 深度思考中...</span>
          </div>
          <span class="thought-toggle-text">展开全部</span>
        </div>
        <div class="thought-content"></div>
      `
      const header = container.querySelector('.thought-header')
      const toggleText = container.querySelector('.thought-toggle-text')
      header.onclick = () => {
        const isExpanded = container.classList.toggle('expanded')
        toggleText.textContent = isExpanded ? '收起' : '展开全部'
      }
      $('chat-messages').appendChild(container)
    }

    const content = container.querySelector('.thought-content')
    if (content) {
      content.textContent = fullText
      if (container.classList.contains('expanded')) {
        content.scrollTop = content.scrollHeight
      }
    }
    scrollChatBottom()
  }

  function finalizeThoughts() {
    document.querySelectorAll('.active-thought-container').forEach((container) => {
      container.classList.remove('active-thought-container')
      const pulse = container.querySelector('.thought-pulse')
      if (pulse) pulse.remove()
      const title = container.querySelector('.thought-title')
      const content = container.querySelector('.thought-content')
      const charCount = content?.textContent?.length || 0
      if (title) {
        title.textContent = `已深度思考 (${charCount} 字)`
      }
    })
  }

  // UI: Tool Call
  function renderToolCall(tool) {
    let toolsCard = document.querySelector('.active-tools-card')
    if (!toolsCard) {
      toolsCard = document.createElement('div')
      toolsCard.className = 'tools-card active-tools-card'
      toolsCard.innerHTML = `
        <div class="tools-card-header">
          <span>⚙️ Tools & MCP Integrations</span>
          <span class="badge badge-blue">调用中</span>
        </div>
        <div class="tools-items-list"></div>
      `
      $('chat-messages').appendChild(toolsCard)
    }

    const list = toolsCard.querySelector('.tools-items-list')
    const item = document.createElement('div')
    item.className = 'tool-item'
    item.id = `tool-${tool.toolCallId || Date.now()}`
    const title = tool.title || tool.kind || 'Tool'
    item.innerHTML = `
      <div class="tool-item-title">
        <span>${escapeHtml(title)}</span>
        <span class="badge badge-amber">Running</span>
      </div>
      <div style="font-family:monospace; color:var(--text-muted); font-size:11px;">${escapeHtml(JSON.stringify(tool.parameters || {}))}</div>
    `
    list.appendChild(item)
    scrollChatBottom()
  }

  function renderToolCallUpdate(update) {
    const item = document.getElementById(`tool-${update.toolCallId}`)
    if (item) {
      const statusBadge = item.querySelector('.badge')
      if (statusBadge) {
        statusBadge.className = 'badge badge-green'
        statusBadge.textContent = 'Completed'
      }
    }
    // Automatically check for new files when tools complete
    loadWorkspaceFiles().catch(() => {})
  }

  // UI: Agent message chunk with smooth streaming
  function renderAgentChunk(fullText) {
    finalizeThoughts()
    let body = document.querySelector('.active-agent-body')
    if (!body) {
      const msgWrapper = document.createElement('div')
      msgWrapper.className = 'message message-agent'
      body = document.createElement('div')
      body.className = 'agent-body active-agent-body'
      msgWrapper.appendChild(body)
      $('chat-messages').appendChild(msgWrapper)
      state.typewriterTargetText = ''
      state.typewriterRenderedLen = 0
    }

    state.typewriterTargetText = fullText
    startTypewriter(body)
  }

  function startTypewriter(body) {
    if (state.typewriterTimer) return
    state.typewriterTimer = setInterval(() => {
      const target = state.typewriterTargetText
      const currentLen = state.typewriterRenderedLen

      if (currentLen >= target.length) {
        clearInterval(state.typewriterTimer)
        state.typewriterTimer = null
        body.innerHTML = formatMarkdown(target)
        scrollChatBottom()
        return
      }

      const diff = target.length - currentLen
      const step = diff > 80 ? 8 : diff > 30 ? 4 : diff > 10 ? 2 : 1
      state.typewriterRenderedLen = Math.min(target.length, currentLen + step)
      const visible = target.slice(0, state.typewriterRenderedLen)
      body.innerHTML = formatMarkdown(visible) + '<span class="typing-cursor"></span>'
      scrollChatBottom()
    }, 18)
  }

  // UI: Permission request
  function renderPermissionRequest(id, request) {
    const card = document.createElement('div')
    card.className = 'permission-card'
    card.id = `perm-${id}`
    const options = Array.isArray(request?.options) ? request.options : []
    const defaultOptionId = options[0]?.id || 'allow-once'
    card.innerHTML = `
      <div class="permission-title">
        <span>⚠️</span>
        <span>Human-in-the-Loop 敏感操作审批</span>
      </div>
      <div class="permission-detail">${escapeHtml(JSON.stringify(request, null, 2))}</div>
      <div class="permission-actions">
        <button class="btn btn-sm deny-btn" style="color:var(--accent-red); border-color:#fca5a5;">拒绝</button>
        <button class="btn btn-sm btn-primary allow-btn">允许执行</button>
      </div>
    `
    card.querySelector('.allow-btn').onclick = () => answerPermission(id, { outcome: 'selected', optionId: defaultOptionId })
    card.querySelector('.deny-btn').onclick = () => answerPermission(id, { outcome: 'cancelled' })
    $('chat-messages').appendChild(card)
    scrollChatBottom()
  }

  function answerPermission(id, outcomeObj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        type: 'permission-response',
        id,
        response: { outcome: outcomeObj },
      }))
    }
    const card = document.getElementById(`perm-${id}`)
    if (card) {
      card.remove()
    }
  }

  function scrollChatBottom() {
    const el = $('chat-messages')
    el.scrollTop = el.scrollHeight
  }

  // Sessions Management
  async function loadSessions() {
    try {
      const data = await api('/api/sessions')
      state.sessions = data.sessions || []
      renderSessionList()
      if (state.sessions.length > 0 && !state.activeSessionId) {
        selectSession(state.sessions[0].sessionId)
      } else if (state.sessions.length === 0) {
        // No existing sessions: show draft welcome screen without creating process
        enterDraftMode()
      }
    } catch (e) {
      console.error('[cockpit] Failed to load sessions:', e)
      enterDraftMode()
    }
  }

  function enterDraftMode() {
    state.activeSessionId = null
    finishCurrentTurn()
    renderSessionList()
    renderWelcomeScreen()
    const input = $('chat-input')
    if (input) input.focus()
  }

  function renderWelcomeScreen() {
    const chat = $('chat-messages')
    if (!chat) return
    chat.innerHTML = `
      <div class="welcome-screen">
        <div class="welcome-icon">⚡</div>
        <h2>新建智能体任务</h2>
        <p>在专属安全沙箱环境中运行。输入您的数据分析、自动化脚本、MCP 知识库或业务需求，智能体将在接收到任务时启动协作。</p>
        <div class="welcome-examples">
          <button class="example-btn" onclick="window.__fillPrompt('列出当前工作区的所有文件，并告诉我环境信息')">📂 检查当前工作区与环境</button>
          <button class="example-btn" onclick="window.__fillPrompt('编写一个处理 CSV 数据的 Python 脚本，提取关键统计指标')">📊 编写并运行数据分析脚本</button>
          <button class="example-btn" onclick="window.__fillPrompt('检查可用工具和 MCP 服务集成状态')">⚙️ 检索 MCP 工具与扩展</button>
        </div>
      </div>
    `
  }

  window.__fillPrompt = (text) => {
    const input = $('chat-input')
    if (input) {
      input.value = text
      input.focus()
    }
  }

  function renderSessionList() {
    const list = $('task-list')
    list.innerHTML = ''
    state.sessions.forEach((sess) => {
      const card = document.createElement('div')
      card.className = `task-card ${sess.sessionId === state.activeSessionId ? 'active' : ''}`
      card.innerHTML = `
        <div class="task-card-header">
          <div class="task-title">${escapeHtml(sess.sessionId)}</div>
          <span class="badge ${sess.sessionId === state.activeSessionId ? 'badge-blue' : 'badge-green'}">Active</span>
        </div>
        <div class="task-meta">CWD: ${escapeHtml(sess.cwd || '/workspace')}</div>
      `
      card.onclick = () => selectSession(sess.sessionId)
      list.appendChild(card)
    })
  }

  function finishCurrentTurn() {
    finalizeThoughts()
    if (state.typewriterTimer) {
      clearInterval(state.typewriterTimer)
      state.typewriterTimer = null
    }
    const body = document.querySelector('.active-agent-body')
    if (body && state.typewriterTargetText) {
      body.innerHTML = formatMarkdown(state.typewriterTargetText)
    }
    document.querySelectorAll('.active-tools-card').forEach(e => e.classList.remove('active-tools-card'))
    document.querySelectorAll('.active-agent-body').forEach(e => e.classList.remove('active-agent-body'))
    state.currentThoughtText = ''
    state.currentAgentText = ''
    state.typewriterTargetText = ''
    state.typewriterRenderedLen = 0
  }

  function setBusy(busy) {
    state.isBusy = busy
    const sendBtn = $('send-btn')
    const input = $('chat-input')
    if (sendBtn) {
      sendBtn.disabled = busy
      sendBtn.textContent = busy ? '执行中...' : '发送'
    }
    if (input) {
      input.disabled = busy
      if (!busy) input.focus()
    }
  }

  async function selectSession(sessionId) {
    state.activeSessionId = sessionId
    renderSessionList()
    $('chat-messages').innerHTML = ''
    finishCurrentTurn()

    // Load transcript
    try {
      const rows = await api(`/api/session/${encodeURIComponent(sessionId)}/transcript`)
      rows.forEach((t) => {
        let update = t.update
        if (typeof update === 'string') {
          try {
            update = JSON.parse(update)
          } catch {
            update = {}
          }
        }
        const kind = update?.sessionUpdate
        if (kind === 'user_message_chunk') {
          finishCurrentTurn()
          appendUserMessage(update.content?.text || '')
        } else if (kind === 'agent_thought_chunk') {
          state.currentThoughtText += update.content?.text || ''
          renderThoughtChunk(state.currentThoughtText)
        } else if (kind === 'tool_call') {
          renderToolCall(update)
        } else if (kind === 'tool_call_update') {
          renderToolCallUpdate(update)
        } else if (kind === 'agent_message_chunk') {
          state.currentAgentText += update.content?.text || ''
          renderAgentChunk(state.currentAgentText)
        }
      })
      finishCurrentTurn()
    } catch (e) {
      console.error('[cockpit] Failed to load transcript:', e)
    }
  }

  function appendUserMessage(text) {
    const wrapper = document.createElement('div')
    wrapper.className = 'message message-user'
    wrapper.innerHTML = `<div class="user-bubble">${escapeHtml(text)}</div>`
    $('chat-messages').appendChild(wrapper)
    scrollChatBottom()
  }

  async function sendPrompt() {
    if (state.isBusy) return
    const input = $('chat-input')
    const text = input.value.trim()
    if (!text) return

    input.value = ''
    setBusy(true)

    // Lazy session creation: only initialize session and backend runtime when user sends first prompt
    if (!state.activeSessionId) {
      const welcome = document.querySelector('.welcome-screen')
      if (welcome) welcome.remove()
      try {
        const res = await api('/api/session/new', {
          method: 'POST',
          body: JSON.stringify({}),
        })
        if (!res.sessionId) throw new Error('未能获取有效的任务 ID')
        state.activeSessionId = res.sessionId
        state.sessions.unshift({ sessionId: res.sessionId, cwd: res.cwd })
        renderSessionList()
      } catch (e) {
        alert('启动任务失败: ' + e.message)
        setBusy(false)
        return
      }
    }

    appendUserMessage(text)
    finishCurrentTurn()

    try {
      await api(`/api/session/${encodeURIComponent(state.activeSessionId)}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      // Prompt completed, refresh files list
      await loadWorkspaceFiles()
    } catch (e) {
      renderAgentChunk(`\n> ⚠️ 执行错误: ${e.message}`)
    } finally {
      finishCurrentTurn()
      setBusy(false)
    }
  }

  // Workspace Files Management
  async function loadWorkspaceFiles() {
    try {
      const data = await api('/api/workspace/files')
      state.files = data.files || []
      renderFileList()
    } catch (e) {
      console.error('[cockpit] Failed to load workspace files:', e)
    }
  }

  function renderFileList() {
    const list = $('file-list')
    list.innerHTML = ''
    if (state.files.length === 0) {
      list.innerHTML = '<div style="font-size:12px; color:var(--text-muted); text-align:center; padding:12px;">工作区暂无产物</div>'
      return
    }

    state.files.forEach((file) => {
      if (file.isDirectory) return
      const card = document.createElement('div')
      card.className = 'file-card'
      const isTable = file.name.endsWith('.csv') || file.name.endsWith('.xlsx')
      const isImg = file.name.endsWith('.png') || file.name.endsWith('.jpg') || file.name.endsWith('.svg')
      const icon = isTable ? '📊' : isImg ? '🖼️' : '📄'

      card.innerHTML = `
        <div class="file-info">
          <span>${icon}</span>
          <div>
            <div class="file-name" title="${escapeHtml(file.relativePath)}">${escapeHtml(file.name)}</div>
            <div class="file-size">${formatBytes(file.size)}</div>
          </div>
        </div>
        <div style="display:flex; gap:4px;">
          <button class="btn btn-sm download-file-btn" title="下载" style="padding:2px 8px;">⬇️</button>
        </div>
      `
      const dlBtn = card.querySelector('.download-file-btn')
      if (dlBtn) {
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation()
          downloadWorkspaceFile(file.relativePath, file.name)
        })
      }
      list.appendChild(card)
    })
  }

  async function downloadWorkspaceFile(relativePath, fileName) {
    try {
      const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(relativePath)}&download=1`, {
        headers: { authorization: `Bearer ${state.token}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      alert('下载文件失败: ' + e.message)
    }
  }

  async function uploadFile(file) {
    if (!file || state.isBusy) return
    const path = file.name
    setBusy(true)
    try {
      const buf = await file.arrayBuffer()
      const res = await fetch(`/api/workspace/upload?path=${encodeURIComponent(path)}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${state.token}`,
          'content-type': 'application/octet-stream',
        },
        body: buf,
      })
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}))
        throw new Error(errData.error || `上传失败 (HTTP ${res.status})`)
      }
      await loadWorkspaceFiles()
      // Announce file upload to agent
      if (state.activeSessionId) {
        await api(`/api/session/${encodeURIComponent(state.activeSessionId)}/prompt`, {
          method: 'POST',
          body: JSON.stringify({ text: `我已经将文件 ${file.name} 放入工作区，请查看并开始分析。` }),
        })
      }
    } catch (e) {
      alert('上传文件失败: ' + e.message)
    } finally {
      finishCurrentTurn()
      setBusy(false)
    }
  }

  // Admin Console View
  async function openAdminConsole() {
    const modal = $('admin-modal')
    const body = $('admin-modal-body')
    modal.hidden = false
    body.innerHTML = '<div style="padding:20px; text-align:center;">正在加载管理视图...</div>'

    try {
      const { role, deptId } = state.principal
      if (role === 'dept-admin') {
        const members = await api(`/api/dept/members?dept=${encodeURIComponent(deptId)}`)
        const usage = await api(`/api/dept/usage?dept=${encodeURIComponent(deptId)}`)
        const audit = await api(`/api/dept/audit?dept=${encodeURIComponent(deptId)}`)
        body.innerHTML = `
          <h3>部门成员 (${escapeHtml(deptId)})</h3>
          <table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:16px;">
            <thead><tr style="border-bottom:1px solid var(--border-subtle);"><th style="text-align:left; padding:6px;">用户</th><th style="text-align:left; padding:6px;">角色</th></tr></thead>
            <tbody>${members.members.map(m => `<tr><td style="padding:6px;">${escapeHtml(m.userId)}</td><td style="padding:6px;">${escapeHtml(m.role)}</td></tr>`).join('')}</tbody>
          </table>
          <h3>部门用量统计</h3>
          <table style="width:100%; border-collapse:collapse; font-size:13px; margin-bottom:16px;">
            <thead><tr style="border-bottom:1px solid var(--border-subtle);"><th style="text-align:left; padding:6px;">用户</th><th style="padding:6px;">会话</th><th style="padding:6px;">消息</th><th style="padding:6px;">工具调用</th></tr></thead>
            <tbody>${usage.users.map(u => `<tr><td style="padding:6px;">${escapeHtml(u.userId)}</td><td style="text-align:center; padding:6px;">${u.totals.sessions}</td><td style="text-align:center; padding:6px;">${u.totals.messages}</td><td style="text-align:center; padding:6px;">${u.totals.toolCalls}</td></tr>`).join('')}</tbody>
          </table>
          <h3>最近审计事件</h3>
          <div style="max-height:140px; overflow-y:auto; font-size:12px; border:1px solid var(--border-subtle); border-radius:6px; padding:6px;">
            ${(audit.events || []).slice(0, 20).map(ev => `
              <div style="padding:4px 0; border-bottom:1px solid var(--border-subtle); display:flex; justify-content:space-between;">
                <span><b>${escapeHtml(ev.userId || '')}</b>: ${escapeHtml(ev.action || '')} ${escapeHtml(ev.detail || '')}</span>
                <span style="color:var(--text-muted); font-size:11px;">${new Date(ev.timestamp).toLocaleTimeString()}</span>
              </div>
            `).join('') || '<div style="color:var(--text-muted); padding:4px;">暂无审计记录</div>'}
          </div>
        `
      } else if (role === 'platform-admin') {
        const overview = await api('/api/admin/overview')
        body.innerHTML = `
          <h3>实例总体概览</h3>
          <div style="display:flex; gap:12px; margin-bottom:16px;">
            <div class="card" style="padding:12px; border:1px solid var(--border-subtle); border-radius:8px; flex:1;"><b>${overview.departments.length}</b> 个部门</div>
            <div class="card" style="padding:12px; border:1px solid var(--border-subtle); border-radius:8px; flex:1;"><b>${overview.acp.live}</b> 个活跃 ACP 运行时</div>
          </div>
          <table style="width:100%; border-collapse:collapse; font-size:13px;">
            <thead><tr style="border-bottom:1px solid var(--border-subtle);"><th style="text-align:left; padding:6px;">部门</th><th style="text-align:left; padding:6px;">用户数</th></tr></thead>
            <tbody>${overview.departments.map(d => `<tr><td style="padding:6px;">${escapeHtml(d.deptId)}</td><td style="padding:6px;">${d.users}</td></tr>`).join('')}</tbody>
          </table>
        `
      }
    } catch (e) {
      body.innerHTML = `<div style="color:var(--accent-red);">加载管理控制台失败: ${escapeHtml(e.message)}</div>`
    }
  }

  // Auth Flow
  async function login(token) {
    state.token = token.trim()
    try {
      state.principal = await api('/api/whoami')
      sessionStorage.setItem('dsh_token', state.token)
      $('auth-banner').hidden = true
      $('workspace-layout').hidden = false
      $('header').hidden = false

      // Update header badges
      $('dept-badge').hidden = false
      $('dept-name').textContent = state.principal.deptId
      $('user-info').hidden = false
      $('user-name').textContent = `${state.principal.userId} (${state.principal.role})`
      $('logout-btn').hidden = false

      if (state.principal.role === 'dept-admin' || state.principal.role === 'platform-admin') {
        $('admin-btn').hidden = false
      }

      connectWs()
      await loadSessions()
      await loadWorkspaceFiles()
    } catch (e) {
      $('auth-error').style.display = 'flex'
      $('auth-error').textContent = e.message
    }
  }

  function logout() {
    state.token = ''
    state.principal = null
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer)
      state.reconnectTimer = null
    }
    if (state.ws) {
      state.ws.onclose = null
      state.ws.onerror = null
      try { state.ws.close() } catch {}
      state.ws = null
    }
    sessionStorage.removeItem('dsh_token')
    const banner = $('auth-banner')
    if (banner) banner.hidden = false
    const layout = $('workspace-layout')
    if (layout) layout.hidden = true
    const dept = $('dept-badge')
    if (dept) dept.hidden = true
    const user = $('user-info')
    if (user) user.hidden = true
    const admin = $('admin-btn')
    if (admin) admin.hidden = true
    const logoutBtn = $('logout-btn')
    if (logoutBtn) logoutBtn.hidden = true
  }

  // Wire Event Listeners
  function init() {
    $('login-btn').onclick = () => login($('token-input').value)
    $('token-input').onkeydown = (e) => { if (e.key === 'Enter') login($('token-input').value) }
    $('logout-btn').onclick = logout
    $('new-task-btn').onclick = enterDraftMode
    $('send-btn').onclick = sendPrompt
    $('chat-input').onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        sendPrompt()
      }
    }
    $('refresh-files-btn').onclick = loadWorkspaceFiles

    // File attachments
    $('attach-btn').onclick = () => $('file-upload-input').click()
    $('file-upload-input').onchange = (e) => {
      if (e.target.files && e.target.files[0]) {
        uploadFile(e.target.files[0])
      }
    }

    // Drag and drop dropzone
    const dropzone = $('upload-dropzone')
    dropzone.onclick = () => $('file-upload-input').click()
    dropzone.ondragover = (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--accent-blue)' }
    dropzone.ondragleave = () => { dropzone.style.borderColor = 'var(--border-subtle)' }
    dropzone.ondrop = (e) => {
      e.preventDefault()
      dropzone.style.borderColor = 'var(--border-subtle)'
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        uploadFile(e.dataTransfer.files[0])
      }
    }

    // Admin modal
    $('admin-btn').onclick = openAdminConsole
    $('admin-close-btn').onclick = () => { $('admin-modal').hidden = true }

    // Auto-login from query or storage
    const params = new URLSearchParams(location.search)
    const urlToken = params.get('ptoken') || params.get('token')
    const savedToken = urlToken || sessionStorage.getItem('dsh_token')
    if (urlToken) {
      try { history.replaceState(null, '', location.pathname) } catch {}
    }
    if (savedToken) {
      $('token-input').value = savedToken
      login(savedToken)
    }
    window.__agentCockpit = { login, logout, state, init, enterDraftMode }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
