import type { PermissionRequest } from './api'

/**
 * Human-in-the-loop approval card. Answers travel over the portal WS in the
 * shape the BFF's validPermissionResponse accepts: selected+optionId or
 * cancelled; anything malformed fails closed there.
 */
export function PermissionCard({ request, onAnswer }: {
  request: PermissionRequest
  onAnswer: (outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }) => void
}) {
  const options = Array.isArray(request.options) ? request.options : []
  const summary = typeof request.toolCallId === 'string' ? String(request.toolCallId) : '敏感操作'

  return (
    <div className="permission-card">
      <div className="permission-title">⚠️ 审批：{summary}</div>
      <div className="permission-detail">{describe(request)}</div>
      <div className="permission-actions">
        <button className="deny" onClick={() => onAnswer({ outcome: 'cancelled' })}>拒绝</button>
        {options.map(option => (
          <button key={option.id} className="allow" onClick={() => onAnswer({ outcome: 'selected', optionId: option.id })}>
            {option.name || option.id}
          </button>
        ))}
        {options.length === 0 && (
          <button className="allow" onClick={() => onAnswer({ outcome: 'selected', optionId: 'allow-once' })}>允许</button>
        )}
      </div>
    </div>
  )
}

function describe(request: PermissionRequest): string {
  const parts: string[] = []
  for (const key of ['title', 'kind', 'command'] as const) {
    const value = request[key]
    if (typeof value === 'string' && value !== '') parts.push(value)
  }
  return parts.length > 0 ? parts.join(' · ') : '智能体请求执行敏感操作'
}
