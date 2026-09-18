/* Enterprise Agent Mission Cockpit (Option B)
 * Pure vanilla ESM - no build tools, zero runtime dependencies.
 */
(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const state = {
    token: '',
    principal: null,
    ws: null,
    sessions: [],
    activeSessionId: null,
    files: [],
    pendingPermissions: new Map(),
    currentThoughtText: '',
    currentAgentText: '',
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
    if (state.ws) {
      try { state.ws.close() } catch {}
    }
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${location.host}/ws?token=${encodeURIComponent(state.token)}`
    const ws = new WebSocket(wsUrl)

    ws.onopen = () => {
      $('sandbox-badge').hidden = false
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
      $('sandbox-badge').hidden = true
      // Reconnect after 3s if still authenticated
      if (state.token) setTimeout(connectWs, 3000)
    }

    state.ws = ws
  }

  // Handle incoming WS events
  function handleWsMessage(msg) {
    if (msg.type === 'session-update' && msg.sessionId === state.activeSessionId) {
      const update = msg.update || {}
      const kind = update.sessionUpdate

      if (kind === 'agent_thought_chunk') {
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

  // UI: Thought Flow
  function renderThoughtChunk(fullText) {
    let thoughtCard = document.querySelector('.active-thought-card')
    if (!thoughtCard) {
      thoughtCard = document.createElement('div')
      thoughtCard.className = 'thought-flow-card active-thought-card'
      thoughtCard.innerHTML = `
        <div class="thought-header">
          <div class="thought-title">
            <span>🧠</span>
            <span>DeepSeek Thought Flow</span>
            <span class="badge badge-blue">推理中...</span>
          </div>
          <button class="btn btn-sm toggle-thought-btn" style="padding:2px 6px;">折叠/展开</button>
        </div>
        <div class="thought-steps-bar">
          <div class="step-node"><span>1</span> 分析需求</div>
          <span class="step-arrow">→</span>
          <div class="step-node"><span>2</span> 知识/工具检索</div>
          <span class="step-arrow">→</span>
          <div class="step-node"><span>3</span> 运算与产出</div>
        </div>
        <div class="thought-detail" style="display:block;"></div>
      `
      thoughtCard.querySelector('.toggle-thought-btn').onclick = () => {
        const detail = thoughtCard.querySelector('.thought-detail')
        detail.style.display = detail.style.display === 'none' ? 'block' : 'none'
      }
      $('chat-messages').appendChild(thoughtCard)
    }

    const detail = thoughtCard.querySelector('.thought-detail')
    if (detail) {
      detail.textContent = fullText
      detail.scrollTop = detail.scrollHeight
    }
    scrollChatBottom()
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

  // UI: Agent message chunk
  function renderAgentChunk(fullText) {
    let body = document.querySelector('.active-agent-body')
    if (!body) {
      const msgWrapper = document.createElement('div')
      msgWrapper.className = 'message message-agent'
      body = document.createElement('div')
      body.className = 'agent-body active-agent-body'
      msgWrapper.appendChild(body)
      $('chat-messages').appendChild(msgWrapper)
    }
    body.innerHTML = formatMarkdown(fullText)
    scrollChatBottom()
  }

  // UI: Permission request
  function renderPermissionRequest(id, request) {
    const card = document.createElement('div')
    card.className = 'permission-card'
    card.id = `perm-${id}`
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
    card.querySelector('.allow-btn').onclick = () => answerPermission(id, 'approved')
    card.querySelector('.deny-btn').onclick = () => answerPermission(id, 'cancelled')
    $('chat-messages').appendChild(card)
    scrollChatBottom()
  }

  function answerPermission(id, outcome) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({
        type: 'permission-response',
        id,
        response: { outcome: { outcome } },
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
        // Automatically start the first mission
        await createNewSession()
      }
    } catch (e) {
      console.error('[cockpit] Failed to load sessions:', e)
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

  async function selectSession(sessionId) {
    state.activeSessionId = sessionId
    renderSessionList()
    $('chat-messages').innerHTML = ''
    state.currentThoughtText = ''
    state.currentAgentText = ''

    // Load transcript
    try {
      const transcript = await api(`/api/session/${encodeURIComponent(sessionId)}/transcript`)
      transcript.forEach((t) => {
        if (t.event === 'user_message' || t.update?.sessionUpdate === 'user_message_chunk') {
          appendUserMessage(t.detail || t.update?.content?.text || '')
        } else if (t.update?.sessionUpdate === 'agent_message_chunk') {
          renderAgentChunk(t.update?.content?.text || '')
        }
      })
      // Clear active classes so new messages start fresh cards
      document.querySelectorAll('.active-thought-card').forEach(e => e.classList.remove('active-thought-card'))
      document.querySelectorAll('.active-tools-card').forEach(e => e.classList.remove('active-tools-card'))
      document.querySelectorAll('.active-agent-body').forEach(e => e.classList.remove('active-agent-body'))
    } catch (e) {
      console.error('[cockpit] Failed to load transcript:', e)
    }
  }

  async function createNewSession() {
    try {
      const res = await api('/api/session/new', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      if (res.sessionId) {
        state.sessions.unshift({ sessionId: res.sessionId, cwd: res.cwd })
        await selectSession(res.sessionId)
      }
    } catch (e) {
      alert('创建任务会话失败: ' + e.message)
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
    const input = $('chat-input')
    const text = input.value.trim()
    if (!text || !state.activeSessionId) return

    input.value = ''
    appendUserMessage(text)

    // Reset current streaming states
    document.querySelectorAll('.active-thought-card').forEach(e => e.classList.remove('active-thought-card'))
    document.querySelectorAll('.active-tools-card').forEach(e => e.classList.remove('active-tools-card'))
    document.querySelectorAll('.active-agent-body').forEach(e => e.classList.remove('active-agent-body'))
    state.currentThoughtText = ''
    state.currentAgentText = ''

    try {
      await api(`/api/session/${encodeURIComponent(state.activeSessionId)}/prompt`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      })
      // Prompt completed, refresh files list
      await loadWorkspaceFiles()
    } catch (e) {
      renderAgentChunk(`\n> ⚠️ 执行错误: ${e.message}`)
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
          <a class="btn btn-sm" href="/api/workspace/file?path=${encodeURIComponent(file.relativePath)}&download=1" download target="_blank">⬇️</a>
        </div>
      `
      list.appendChild(card)
    })
  }

  async function uploadFile(file) {
    if (!file) return
    const path = file.name
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
      if (!res.ok) throw new Error('上传失败')
      await loadWorkspaceFiles()
      // Announce file upload to agent
      if (state.activeSessionId) {
        appendUserMessage(`已上传文件: ${file.name}`)
        await api(`/api/session/${encodeURIComponent(state.activeSessionId)}/prompt`, {
          method: 'POST',
          body: JSON.stringify({ text: `我已经将文件 ${file.name} 放入工作区，请查看并开始分析。` }),
        })
      }
    } catch (e) {
      alert('上传文件失败: ' + e.message)
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
    if (state.ws) {
      try { state.ws.close() } catch {}
      state.ws = null
    }
    sessionStorage.removeItem('dsh_token')
    $('auth-banner').hidden = false
    $('workspace-layout').hidden = true
    $('dept-badge').hidden = true
    $('user-info').hidden = true
    $('admin-btn').hidden = true
    $('logout-btn').hidden = true
  }

  // Wire Event Listeners
  function init() {
    $('login-btn').onclick = () => login($('token-input').value)
    $('token-input').onkeydown = (e) => { if (e.key === 'Enter') login($('token-input').value) }
    $('logout-btn').onclick = logout
    $('new-task-btn').onclick = createNewSession
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
    if (savedToken) {
      $('token-input').value = savedToken
      login(savedToken)
    }
    window.__agentCockpit = { login, logout, state, init }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
