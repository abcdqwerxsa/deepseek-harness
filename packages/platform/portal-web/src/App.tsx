import { useEffect, useState } from 'react'
import { apiClient, storedToken, storeToken, type Principal } from './api'
import { Chat } from './Chat'

export function App() {
  const [token, setToken] = useState<string | null>(storedToken())
  const [principal, setPrincipal] = useState<Principal | null>(null)

  useEffect(() => {
    if (token === null) return
    let cancelled = false
    apiClient.whoami()
      .then((p) => { if (!cancelled) setPrincipal(p) })
      .catch(() => { if (!cancelled) setToken(null) })
    return () => { cancelled = true }
  }, [token])

  if (token === null || principal === null) {
    return <Login onLogin={(t) => { storeToken(t); setToken(t) }} />
  }
  return (
    <Chat
      key={token}
      token={token}
      principal={principal}
      onLogout={() => { storeToken(null); setToken(null); setPrincipal(null) }}
    />
  )
}

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const token = value.trim()
    if (token === '' || busy) return
    setBusy(true)
    setError('')
    try {
      storeToken(token)
      await apiClient.whoami()
      onLogin(token)
    } catch (err) {
      storeToken(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={(e) => { e.preventDefault(); void submit() }}>
        <div className="login-logo">⬢</div>
        <h1>企业智能体工作台</h1>
        <p className="login-sub">DeepSeek Harness · 内网部署</p>
        <input
          autoFocus
          type="password"
          placeholder="输入访问令牌"
          value={value}
          onChange={e => setValue(e.target.value)}
        />
        {error !== '' && <div className="login-error">{error}</div>}
        <button type="submit" disabled={busy || value.trim() === ''}>
          {busy ? '验证中…' : '进入工作台'}
        </button>
      </form>
    </div>
  )
}
