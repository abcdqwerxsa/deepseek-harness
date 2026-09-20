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
  readonly configOptions?: readonly unknown[]
}

export interface FileInfo {
  readonly name: string
  readonly relativePath: string
  readonly size: number
  readonly isDirectory: boolean
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

  workspaceFiles: () => api<{ files: readonly FileInfo[] }>('/api/workspace/files'),
}
