import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { renderMarkdown } from './markdown'
import type { ToolCall, Turn } from './events'

export function TurnView({ turn }: { turn: Turn }) {
  return (
    <div className="turn">
      {turn.userText !== '' && <div className="bubble user">{turn.userText}</div>}
      {turn.blocks.map((block, i) => {
        if (block.type === 'thought') return <ThoughtCard key={i} text={block.text} done={block.done} />
        if (block.type === 'body') return <BodyView key={i} text={block.text} done={block.done} />
        return <ToolCard key={`${block.call.id}-${i}`} call={block.call} />
      })}
      {turn.error !== undefined && <div className="error-note">⚠️ {turn.error}</div>}
    </div>
  )
}

/** Collapsible thought segment; streaming keeps it open, settling folds it. */
function ThoughtCard({ text, done }: { text: string; done: boolean }) {
  // Settled cards mount collapsed (replay must not flash open first).
  const [open, setOpen] = useState(!done)
  const userToggled = useRef(false)

  useEffect(() => {
    if (done && !userToggled.current) setOpen(false)
  }, [done])

  return (
    <div className={`thought ${done ? 'settled' : 'live'}`}>
      <button
        className="thought-head"
        onClick={() => { userToggled.current = true; setOpen(o => !o) }}
      >
        <span className="thought-arrow">{open ? '▾' : '▸'}</span>
        <span className="thought-title">{done ? `已深度思考（${text.length} 字）` : '深度思考中…'}</span>
        {!done && <span className="thought-pulse" />}
      </button>
      {open && <div className="thought-body">{text}</div>}
    </div>
  )
}

/**
 * Agent message body. Memoized: a settled block never re-parses markdown,
 * so only the streaming block pays per-chunk cost.
 */
const BodyView = memo(function BodyView({ text, done }: { text: string; done: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return (
    <div className="bubble agent">
      <div className="agent-md" dangerouslySetInnerHTML={{ __html: html }} />
      {!done && <span className="typing" />}
    </div>
  )
})

function ToolCard({ call }: { call: ToolCall }) {
  return (
    <div className={`tool ${call.done ? 'done' : 'running'}`}>
      <div className="tool-head">
        <span className="tool-dot" />
        <span className="tool-name">{call.title}</span>
        <span className="tool-status">{call.done ? '完成' : '运行中'}</span>
      </div>
      {call.params !== '' && <pre className="tool-params">{call.params}</pre>}
    </div>
  )
}
