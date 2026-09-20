import { useEffect, useState } from 'react'
import { apiClient, type AuditEvent, type DeptMember, type DeptUsage, type Principal } from './api'

/**
 * Admin drawer over the BFF console endpoints. Gated on any admin role
 * today; the role-flattening milestone collapses the two variants into one
 * user/admin view.
 */
export function AdminPanel({ principal, onClose }: { principal: Principal; onClose: () => void }) {
  const [members, setMembers] = useState<readonly DeptMember[]>([])
  const [usage, setUsage] = useState<DeptUsage>({})
  const [audit, setAudit] = useState<readonly AuditEvent[]>([])
  const [overview, setOverview] = useState<{ departments: readonly { deptId: string; users: number }[]; acp: { live: number } } | null>(null)
  const [error, setError] = useState('')

  const isPlatformAdmin = principal.role === 'platform-admin'

  useEffect(() => {
    let cancelled = false
    const fail = (err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) }
    void apiClient.deptMembers(principal.deptId).then(r => { if (!cancelled) setMembers(r.members) }, fail)
    void apiClient.deptUsage(principal.deptId).then(r => { if (!cancelled) setUsage(r) }, fail)
    void apiClient.deptAudit(principal.deptId).then(r => { if (!cancelled) setAudit(r.events ?? []) }, fail)
    if (isPlatformAdmin) void apiClient.adminOverview().then(r => { if (!cancelled) setOverview(r) }, fail)
    return () => { cancelled = true }
  }, [principal.deptId, isPlatformAdmin])

  return (
    <div className="admin-overlay" onClick={onClose}>
      <div className="admin-card" onClick={e => e.stopPropagation()}>
        <div className="admin-head">
          <span>管理控制台 · {principal.deptId}</span>
          <button onClick={onClose}>✕</button>
        </div>
        {error !== '' && <div className="admin-error">{error}</div>}

        {isPlatformAdmin && overview !== null && (
          <section>
            <h3>实例概览</h3>
            <p className="admin-kpi">
              <b>{overview.departments.length}</b> 个部门 · <b>{overview.acp.live}</b> 个活跃运行时
            </p>
            <table>
              <thead><tr><th>部门</th><th>用户数</th></tr></thead>
              <tbody>
                {overview.departments.map(dept => (
                  <tr key={dept.deptId}><td>{dept.deptId}</td><td>{dept.users}</td></tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section>
          <h3>部门成员</h3>
          <table>
            <thead><tr><th>用户</th><th>角色</th></tr></thead>
            <tbody>
              {members.map(member => (
                <tr key={member.userId}><td>{member.userId}</td><td>{member.role ?? '-'}</td></tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3>部门用量</h3>
          <table>
            <thead><tr><th>用户</th><th>会话</th><th>消息</th><th>工具调用</th></tr></thead>
            <tbody>
              {(usage.users ?? []).map(user => (
                <tr key={user.userId}>
                  <td>{user.userId}</td>
                  <td>{user.totals.sessions}</td>
                  <td>{user.totals.messages}</td>
                  <td>{user.totals.toolCalls}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section>
          <h3>最近审计</h3>
          <div className="admin-audit">
            {audit.slice(0, 30).map((event, i) => (
              <div key={i} className="admin-audit-row">
                <span><b>{event.userId ?? ''}</b> {event.action ?? ''} {event.detail ?? ''}</span>
                <span className="admin-audit-time">{formatTime(event.timestamp)}</span>
              </div>
            ))}
            {audit.length === 0 && <div className="admin-empty">暂无审计记录</div>}
          </div>
        </section>
      </div>
    </div>
  )
}

function formatTime(timestamp: number | string | undefined): string {
  if (timestamp === undefined) return ''
  const date = typeof timestamp === 'number' ? new Date(timestamp) : new Date(timestamp)
  return Number.isNaN(date.getTime()) ? String(timestamp) : date.toLocaleTimeString()
}
