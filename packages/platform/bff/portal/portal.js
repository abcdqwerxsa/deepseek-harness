/* Admin console: a deliberately build-free page over the platform BFF's
 * role-scoped REST surfaces. Members are pointed at their original UI; dept
 * admins get their department's directory, usage, and audit; platform admins
 * get the instance overview plus any department drill-down. All state lives
 * in this module; the BFF owns auth, isolation, and persistence. */
(function () {
  'use strict'

  const $ = (id) => document.getElementById(id)
  const tokenInput = $('token')
  const statusLabel = $('status')
  const views = $('views')

  const state = { token: '', principal: null }

  function api(path, init = {}) {
    return fetch(path, {
      ...init,
      headers: { authorization: `Bearer ${state.token}`, 'content-type': 'application/json', ...init.headers },
    }).then(async (response) => {
      if (response.status === 401) throw new Error('令牌无效或已过期')
      if (response.status === 403) throw new Error('无权访问该视图')
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    })
  }

  function status(text, isError = false) {
    statusLabel.textContent = text
    statusLabel.className = isError ? 'who error' : 'who'
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'text') node.textContent = value
      else node.setAttribute(key, value)
    }
    for (const child of children) {
      if (typeof child === 'string') node.appendChild(document.createTextNode(child))
      else node.appendChild(child)
    }
    return node
  }

  function section(title, ...children) {
    const heading = el('h2', { text: title })
    return el('section', {}, heading, ...children)
  }

  function table(headers, rows) {
    const head = el('tr', {}, ...headers.map(h => el('th', { text: h })))
    const body = rows.map(row => el('tr', {}, ...row.map(cell => el('td', { text: String(cell) }))))
    return el('table', {}, el('thead', {}, head), el('tbody', {}, ...body))
  }

  function auditList(rows) {
    return el('ul', { class: 'audit' }, ...rows.map(row =>
      el('li', { text: `${row.at}  ${row.tenantId ?? ''}  ${row.event}  ${row.detail ?? ''}` })))
  }

  function originalUiLink() {
    const { deptId, userId } = state.principal
    const url = `/u/${encodeURIComponent(deptId)}/${encodeURIComponent(userId)}/?ptoken=${encodeURIComponent(state.token)}`
    return el('a', { href: url, class: 'open-ui', text: '打开我的原版工作台 →' })
  }

  async function render() {
    views.replaceChildren()
    const { role, deptId, userId } = state.principal
    status(`${deptId}/${userId} · ${role}`)

    if (role === 'member') {
      views.appendChild(section('个人工作区', originalUiLink()))
      return
    }

    // Everyone with a governance role also keeps their own original UI.
    views.appendChild(section('个人工作区', originalUiLink()))

    if (role === 'dept-admin') {
      await renderDept(deptId)
      return
    }

    // platform-admin: instance overview plus per-department drill-down.
    const overview = await api('/api/admin/overview')
    const cards = el('div', {},
      el('div', { class: 'card' }, el('b', { text: String(overview.departments.length) }), '部门'),
      el('div', { class: 'card' }, el('b', { text: String(overview.acp.live) }), 'ACP 运行时'),
      el('div', { class: 'card' }, el('b', { text: String(overview.web.live) }), 'Web 运行时'))
    views.appendChild(section('实例概览', cards,
      table(['部门', '用户数'], overview.departments.map(d => [d.deptId, d.users]))))
    const picker = el('select', {}, el('option', { value: '', text: '选择部门查看…' }),
      ...overview.departments.filter(d => d.deptId !== '_platform').map(d =>
        el('option', { value: d.deptId, text: d.deptId })))
    picker.addEventListener('change', () => {
      if (picker.value !== '') void renderDeptInto(picker.value, views)
    })
    views.appendChild(section('部门下钻', picker, el('div', { id: 'drill' })))
  }

  async function renderDept(deptId) {
    await renderDeptInto(deptId, views)
  }

  async function renderDeptInto(deptId, container) {
    let drill = container.querySelector('#drill')
    if (drill === null) {
      drill = el('div', { id: 'drill' })
      container.appendChild(drill)
    }
    const members = await api(`/api/dept/members?dept=${encodeURIComponent(deptId)}`)
    const usage = await api(`/api/dept/usage?dept=${encodeURIComponent(deptId)}`)
    const audit = await api(`/api/dept/audit?dept=${encodeURIComponent(deptId)}`)
    drill.replaceChildren(
      section(`成员 · ${deptId}`, table(['用户', '角色'], members.members.map(m => [m.userId, m.role]))),
      section('用量', table(['用户', '会话', '回合', '消息', '工具调用'],
        usage.users.map(u => [u.userId, u.totals.sessions, u.totals.turns, u.totals.messages, u.totals.toolCalls]))),
      section('审计', auditList(audit)))
  }

  async function connect() {
    state.token = tokenInput.value.trim()
    if (state.token === '') {
      status('请输入访问令牌', true)
      return
    }
    try {
      state.principal = await api('/api/whoami')
      views.hidden = false
      await render()
    } catch (error) {
      status(error instanceof Error ? error.message : String(error), true)
    }
  }

  $('connect').addEventListener('click', () => { void connect() })
  tokenInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void connect()
  })

  window.__adminConsole = { connect, api, state }
})()
