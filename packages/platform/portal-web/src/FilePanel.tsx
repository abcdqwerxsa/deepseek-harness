import { useEffect, useRef, useState } from 'react'
import { apiClient, downloadWorkspaceFile, uploadWorkspaceFile, type FileInfo } from './api'

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`
}

/**
 * Workspace deliverables panel. Refreshes when the refresh key changes
 * (turn completion, upload) instead of per tool update — the old portal's
 * per-tool_call_update refetch hammered this endpoint during tool storms.
 */
export function FilePanel({ refreshKey, onRefresh }: { refreshKey: number; onRefresh: () => void }) {
  const [files, setFiles] = useState<readonly FileInfo[]>([])
  const [error, setError] = useState('')
  const uploadRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    apiClient.workspaceFiles()
      .then(data => { if (!cancelled) { setFiles(data.files); setError('') } })
      .catch(err => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)) })
    return () => { cancelled = true }
  }, [refreshKey])

  const upload = async (file: File | undefined) => {
    if (file === undefined) return
    try {
      await uploadWorkspaceFile(file)
      const data = await apiClient.workspaceFiles()
      setFiles(data.files)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const shown = files.filter(file => !file.isDirectory)

  return (
    <div className="files-panel">
      <div className="files-head">
        <span>工作区产物</span>
        <button title="刷新" onClick={onRefresh}>⟳</button>
        <button title="上传" onClick={() => uploadRef.current?.click()}>⇧</button>
        <input
          ref={uploadRef}
          type="file"
          hidden
          onChange={e => { void upload(e.target.files?.[0]); e.target.value = '' }}
        />
      </div>
      {error !== '' && <div className="files-error">{error}</div>}
      {shown.length === 0 && <div className="files-empty">暂无产物</div>}
      {shown.map(file => (
        <button
          key={file.relativePath}
          className="file-card"
          onClick={() => { void downloadWorkspaceFile(file.relativePath, file.name) }}
          title={file.relativePath}
        >
          <span className="file-name">{file.name}</span>
          <span className="file-size">{formatBytes(file.size)}</span>
        </button>
      ))}
    </div>
  )
}
