/** BFF REST client. Token lives in sessionStorage; 401 clears it (the Chat shell then routes back to login). */

export interface Principal {
  readonly deptId: string
  readonly userId: string
  readonly role: string
  readonly tenantId: string
}

export interface SessionInfo {
  readonly sessionId: string
  readonly cwd?: string
}

export interface SessionNewResult {
  readonly sessionId: string
  readonly cwd?: string
  readonly configOptions?: readonly ConfigOption[]
}

export interface FileInfo {
  readonly name: string
  readonly relativePath: string
  readonly size: number
  readonly isDirectory: boolean
}

export interface ConfigOptionEntry {
  readonly value: string
  readonly name: string
  readonly description?: string
}

export interface ConfigOption {
  readonly id: string
  readonly name?: string
  readonly currentValue?: string
  readonly options?: readonly (ConfigOptionEntry | {
    readonly group?: string
    readonly name?: string
    readonly options: readonly ConfigOptionEntry[]
  })[]
}

/** Keep only object entries with a string id; the catalog is agent-fed. */
export function configOptionsOf(raw: readonly unknown[]): readonly ConfigOption[] {
  return raw.filter((entry): entry is ConfigOption =>
    typeof entry === 'object' && entry !== null && typeof (entry as ConfigOption).id === 'string')
}

export interface PermissionOption {
  readonly id: string
  readonly name: string
}

export interface PermissionRequest {
  readonly options?: readonly PermissionOption[]
  readonly [key: string]: unknown
}

export interface DeptMember {
  readonly userId: string
  readonly role?: string
}

export interface DeptUsage {
  readonly users?: readonly {
    readonly userId: string
    readonly totals: { readonly sessions: number; readonly messages: number; readonly toolCalls: number }
  }[]
}

export interface AuditEvent {
  readonly at: string
  readonly tenantId: string
  readonly event: string
  readonly detail?: string | null
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const TOKEN_KEY = 'dsh_token'

export function storedToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY)
}

export function storeToken(token: string | null): void {
  if (token === null) sessionStorage.removeItem(TOKEN_KEY)
  else sessionStorage.setItem(TOKEN_KEY, token)
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = storedToken()
  const headers = {
    'content-type': 'application/json',
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    ...init.headers,
  }
  const res = await fetch(path, { ...init, headers })
  if (res.status === 401) {
    storeToken(null)
    throw new ApiError(401, '登录已过期，请重新输入令牌')
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export const apiClient = {
  whoami: () => api<Principal>('/api/whoami'),

  sessions: () => api<{ sessions: readonly SessionInfo[] }>('/api/sessions'),

  sessionNew: () => api<SessionNewResult>('/api/session/new', { method: 'POST', body: '{}' }),

  prompt: (sessionId: string, text: string) =>
    api<{ stopReason?: string }>(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  transcript: (sessionId: string) =>
    api<readonly { update?: unknown }[]>(`/api/session/${encodeURIComponent(sessionId)}/transcript`),

  sessionConfig: (sessionId: string, configId: string, value: string) =>
    api<{ configOptions?: readonly ConfigOption[] }>(`/api/session/${encodeURIComponent(sessionId)}/config`, {
      method: 'POST',
      body: JSON.stringify({ configId, value }),
    }),

  workspaceFiles: () => api<{ files: readonly FileInfo[] }>('/api/workspace/files'),

  deptMembers: (deptId: string) =>
    api<{ deptId: string; members: readonly DeptMember[] }>(`/api/dept/members?dept=${encodeURIComponent(deptId)}`),

  deptUsage: (deptId: string) =>
    api<DeptUsage>(`/api/dept/usage?dept=${encodeURIComponent(deptId)}`),

  deptAudit: (deptId: string) =>
    api<readonly AuditEvent[]>(`/api/dept/audit?dept=${encodeURIComponent(deptId)}`),

  adminOverview: () =>
    api<{ departments: readonly { deptId: string; users: number }[]; acp: { live: number } }>(`/api/admin/overview`),
}

/** Upload one file into the workspace root (binary body, bearer auth). */
export async function uploadWorkspaceFile(file: File): Promise<void> {
  const token = storedToken()
  const res = await fetch(`/api/workspace/upload?path=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      'content-type': 'application/octet-stream',
    },
    body: await file.arrayBuffer(),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    throw new ApiError(res.status, body.error ?? `上传失败 (HTTP ${res.status})`)
  }
}

/** Download one workspace file as a blob and trigger a browser save. */
export async function downloadWorkspaceFile(relativePath: string, name: string): Promise<void> {
  const token = storedToken()
  const res = await fetch(`/api/workspace/file?path=${encodeURIComponent(relativePath)}&download=1`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new ApiError(res.status, `下载失败 (HTTP ${res.status})`)
  const url = URL.createObjectURL(await res.blob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
