import { useEffect, useMemo, useState } from 'react'
import { apiClient, type AuditEvent, type DeptMember, type DeptUsage, type Principal } from './api'
import { Icon, type IconName } from './icons'

/** Full-page admin console over the BFF console endpoints (admin role). */
export type ConsoleTab = 'overview' | 'members' | 'usage' | 'audit'

export const CONSOLE_TABS: readonly { id: ConsoleTab; label: string; icon: IconName }[] = [
  { id: 'overview', label: '总览', icon: 'layout-dashboard' },
  { id: 'members', label: '成员管理', icon: 'users' },
  { id: 'usage', label: '用量统计', icon: 'bar-chart-3' },
  { id: 'audit', label: '审计日志', icon: 'scroll-text' },
]

interface Overview {
  readonly departments: readonly { deptId: string; users: number }[]
  readonly acp: { live: number }
}

interface ConsoleData {
  readonly members: readonly DeptMember[]
  readonly usage: DeptUsage
  readonly audit: readonly AuditEvent[]
  readonly overview: Overview | null
}

export function AdminConsole({ principal, tab }: { principal: Principal; tab: ConsoleTab }) {
  const [data, setData] = useState<ConsoleData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const isAdmin = principal.role === 'admin'

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    // Spread of a conditional array loses tuple typing in Promise.all, so the
    // admin-only overview fetch runs after the fixed trio.
    const run = async () => {
      const [members, usage, audit] = await Promise.all([
        apiClient.deptMembers(principal.deptId),
        apiClient.deptUsage(principal.deptId),
        apiClient.deptAudit(principal.deptId),
      ])
      const overview = isAdmin ? await apiClient.adminOverview() : null
      return { members: members.members, usage, audit, overview } satisfies ConsoleData
    }
    run().then(
      (data) => { if (!cancelled) { setData(data); setLoading(false) } },
      (err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      },
    )
    return () => { cancelled = true }
  }, [principal.deptId, isAdmin, reload])

  const usageByUser = useMemo(() => {
    const map = new Map<string, { sessions: number; messages: number; toolCalls: number }>()
    for (const user of data?.usage.users ?? []) map.set(user.userId, user.totals)
    return map
  }, [data])

  return (
    <main className="console">
      <header className="console-topbar">
        <span className="console-title">管理控制台</span>
        <span className="badge">{principal.deptId}</span>
        <span className="topbar-spacer" />
        <button className="icon-btn" title="刷新" aria-label="刷新数据" onClick={() => setReload(key => key + 1)}>
          <Icon name="refresh-cw" size={14} />
        </button>
      </header>
      <div className="console-body">
        {error !== '' && (
          <div className="console-state">
            <span className="console-error">{error}</span>
            <button className="btn-primary" onClick={() => setReload(key => key + 1)}>重试</button>
          </div>
        )}
        {error === '' && loading && <div className="console-state muted">加载中…</div>}
        {error === '' && !loading && data !== null && tab === 'overview' && (
          <OverviewTab principal={principal} data={data} usageByUser={usageByUser} />
        )}
        {error === '' && !loading && data !== null && tab === 'members' && (
          <MembersTab data={data} usageByUser={usageByUser} />
        )}
        {error === '' && !loading && data !== null && tab === 'usage' && (
          <UsageTab usage={data.usage} />
        )}
        {error === '' && !loading && data !== null && tab === 'audit' && (
          <AuditTab audit={data.audit} principal={principal} full />
        )}
      </div>
    </main>
  )
}

type UsageTotals = { readonly sessions: number; readonly messages: number; readonly toolCalls: number }

function OverviewTab({ principal, data, usageByUser }: {
  principal: Principal
  data: ConsoleData
  usageByUser: Map<string, UsageTotals>
}) {
  const totalSessions = [...usageByUser.values()].reduce((sum, totals) => sum + totals.sessions, 0)
  const topUsers = [...usageByUser.entries()]
    .sort(([, a], [, b]) => b.sessions - a.sessions)
    .slice(0, 7)
  const maxSessions = topUsers[0]?.[1].sessions ?? 0
  return (
    <>
      <div className="kpi-grid">
        {data.overview !== null && (
          <Kpi icon="building-2" label="部门数" value={String(data.overview.departments.length)} tone="accent" />
        )}
        <Kpi icon="users" label="部门成员" value={String(data.members.length)} tone="accent" />
        <Kpi icon="message-square" label="总会话" value={totalSessions.toLocaleString()} tone="accent" />
        {data.overview !== null && (
          <Kpi icon="cpu" label="活跃运行时" value={String(data.overview.acp.live)} tone="amber" />
        )}
      </div>
      <div className="mid-row">
        <section className="card">
          <div className="card-head">
            <span className="card-title">成员会话排行</span>
            <span className="card-spacer" />
            <span className="legend"><span className="legend-dot" />会话数</span>
          </div>
          {topUsers.length === 0
            ? <div className="console-empty">暂无用量数据</div>
            : (
              <div className="chart">
                {topUsers.map(([userId, totals], i) => (
                  <div className="chart-col" key={userId}>
                    <span className="chart-val">{totals.sessions.toLocaleString()}</span>
                    <span
                      className={`chart-bar ${i === 0 ? 'top' : ''}`}
                      style={{ height: `${Math.max(8, Math.round(totals.sessions / Math.max(maxSessions, 1) * 170))}px` }}
                    />
                    <span className="chart-user" title={userId}>{userId}</span>
                  </div>
                ))}
              </div>
            )}
        </section>
        <AuditTab audit={data.audit} principal={principal} />
      </div>
      {data.overview !== null && (
        <section className="card">
          <div className="card-head">
            <span className="card-title">部门概览</span>
            <span className="card-spacer" />
            <span className="muted-note">{data.overview.departments.length} 个部门</span>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>部门</th><th className="num">成员数</th></tr>
              </thead>
              <tbody>
                {data.overview.departments.map(dept => (
                  <tr key={dept.deptId}>
                    <td>{dept.deptId}</td>
                    <td className="num">{dept.users}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  )
}

function MembersTab({ data, usageByUser }: { data: ConsoleData; usageByUser: Map<string, UsageTotals> }) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const members = data.members.filter(member => member.userId.toLowerCase().includes(needle))
  return (
    <section className="card members-card">
      <div className="card-head">
        <span className="card-title">部门成员</span>
        <span className="card-spacer" />
        <label className="search-box">
          <Icon name="search" size={13} />
          <input
            type="search"
            placeholder="搜索成员…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="搜索成员"
          />
        </label>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>用户</th><th>角色</th>
              <th className="num">会话</th><th className="num">消息</th><th className="num">工具调用</th>
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const totals = usageByUser.get(member.userId)
              return (
                <tr key={member.userId}>
                  <td><span className="member-cell"><span className="member-avatar">{member.userId.slice(0, 1).toUpperCase()}</span>{member.userId}</span></td>
                  <td><span className={`badge ${member.role === 'admin' ? '' : 'muted'}`}>{member.role === 'admin' ? '管理员' : member.role === undefined ? '-' : '成员'}</span></td>
                  <td className="num">{totals?.sessions.toLocaleString() ?? '—'}</td>
                  <td className="num">{totals?.messages.toLocaleString() ?? '—'}</td>
                  <td className="num">{totals?.toolCalls.toLocaleString() ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {members.length === 0 && <div className="console-empty">没有匹配的成员</div>}
    </section>
  )
}

function UsageTab({ usage }: { usage: DeptUsage }) {
  const users = [...(usage.users ?? [])].sort((a, b) => b.totals.sessions - a.totals.sessions)
  return (
    <section className="card">
      <div className="card-head">
        <span className="card-title">部门用量</span>
        <span className="card-spacer" />
        <span className="muted-note">按会话数排序</span>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>用户</th>
              <th className="num">会话</th><th className="num">消息</th><th className="num">工具调用</th>
            </tr>
          </thead>
          <tbody>
            {users.map(user => (
              <tr key={user.userId}>
                <td>{user.userId}</td>
                <td className="num">{user.totals.sessions.toLocaleString()}</td>
                <td className="num">{user.totals.messages.toLocaleString()}</td>
                <td className="num">{user.totals.toolCalls.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {users.length === 0 && <div className="console-empty">暂无用量数据</div>}
    </section>
  )
}

function AuditTab({ audit, principal, full = false }: {
  audit: readonly AuditEvent[]
  principal: Principal
  full?: boolean
}) {
  const rows = full ? audit : audit.slice(0, 6)
  return (
    <section className={`card audit-card ${full ? 'wide' : ''}`}>
      <div className="card-head">
        <span className="card-title">{full ? '审计日志' : '最近审计'}</span>
        <span className="card-spacer" />
        <span className="badge muted">快照</span>
      </div>
      <div className="audit-list">
        {rows.map((event, i) => (
          <div className="audit-row" key={i}>
            <span className={`audit-chip tone-${eventTone(event.event)}`}>
              <Icon name={eventIcon(event.event)} size={13} />
            </span>
            <span className="audit-col">
              <span className="audit-text"><b>{userOf(event.tenantId, principal.deptId)}</b> {event.event}{event.detail ? ` · ${event.detail}` : ''}</span>
              <span className="audit-time">{formatTime(event.at, full)}</span>
            </span>
          </div>
        ))}
        {rows.length === 0 && <div className="console-empty">暂无审计记录</div>}
      </div>
    </section>
  )
}

function Kpi({ icon, label, value, tone }: { icon: IconName; label: string; value: string; tone: 'accent' | 'amber' }) {
  return (
    <div className="kpi">
      <div className="kpi-head">
        <span className={`kpi-chip tone-${tone}`}><Icon name={icon} size={15} /></span>
        {label}
      </div>
      <span className="kpi-value">{value}</span>
    </div>
  )
}

/** Map an audit event name to a representative icon without hard-failing on new events. */
function eventIcon(event: string): IconName {
  if (event.includes('tool')) return 'terminal'
  if (event.includes('upload') || event.includes('file')) return 'upload'
  if (event.includes('session') || event.includes('prompt')) return 'message-square'
  if (event.includes('role') || event.includes('admin')) return 'shield'
  if (event.includes('login')) return 'log-in'
  if (event.includes('export') || event.includes('download')) return 'file-text'
  return 'scroll-text'
}

function eventTone(event: string): 'accent' | 'amber' | 'green' | 'red' {
  if (event.includes('tool')) return 'amber'
  if (event.includes('role') || event.includes('admin')) return 'red'
  if (event.includes('upload') || event.includes('file') || event.includes('export')) return 'green'
  return 'accent'
}

function formatTime(timestamp: string, full = false): string {
  // Epoch-millis strings come from older rows; ISO strings parse directly.
  const date = /^\d+$/.test(timestamp) ? new Date(Number(timestamp)) : new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return full ? date.toLocaleString() : date.toLocaleTimeString()
}

/** The audit trail keys rows by `deptId/userId`; show the user part. */
function userOf(tenantId: string, deptId: string): string {
  return tenantId.startsWith(`${deptId}/`) ? tenantId.slice(deptId.length + 1) : tenantId
}
