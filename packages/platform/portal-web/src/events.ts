/**
 * Chat-stream view model: folds ACP session updates into ordered turns.
 *
 * Pure logic, no DOM. Every Phase 0 P0 bug traces back to the old portal's
 * global mutable state + echo text matching; here turn boundaries come from
 * the update stream itself (`user_message_chunk` always opens a turn) and
 * block interleaving is preserved per turn.
 */

export interface ToolCall {
  readonly id: string
  readonly title: string
  readonly params: string
  done: boolean
}

export type Block =
  | { readonly type: 'thought'; text: string; done: boolean }
  | { readonly type: 'body'; text: string; done: boolean }
  | { readonly type: 'tool'; readonly call: ToolCall }

export interface Turn {
  readonly id: number
  readonly userText: string
  readonly blocks: readonly Block[]
  error?: string
  done: boolean
}

export interface ChatState {
  readonly turns: readonly Turn[]
  readonly seq: number
}

/** One ACP `session/update` payload as the BFF broadcasts it. */
export interface SessionUpdate {
  readonly sessionUpdate?: string
  readonly content?: { readonly type?: string; readonly text?: string }
  readonly toolCallId?: string
  readonly title?: string
  readonly kind?: string
  readonly parameters?: unknown
}

/** One transcript row: `{ update }` with the update possibly JSON-encoded. */
export interface TranscriptRow {
  readonly update?: unknown
}

export const emptyChat: ChatState = { turns: [], seq: 0 }

const textOf = (update: SessionUpdate): string => update.content?.text ?? ''

function safeParams(parameters: unknown): string {
  if (parameters === undefined || parameters === null) return ''
  try {
    return JSON.stringify(parameters)
  } catch {
    return String(parameters)
  }
}

function withTurn(state: ChatState, fn: (turn: Turn) => Turn): ChatState {
  const last = state.turns[state.turns.length - 1]
  if (last === undefined) return state
  const next = fn(last)
  if (next === last) return state
  const turns = [...state.turns]
  turns[turns.length - 1] = next
  return { ...state, turns }
}

/** A turn to append into; creates an orphan when updates precede any user echo. */
function ensureTurn(state: ChatState): ChatState {
  if (state.turns.length > 0) return state
  return { turns: [{ id: state.seq + 1, userText: '', blocks: [], done: false }], seq: state.seq + 1 }
}

/** Mark a trailing streaming thought/body block as settled. */
function closeStreaming(turn: Turn): Turn {
  const last = turn.blocks[turn.blocks.length - 1]
  if (last !== undefined && (last.type === 'thought' || last.type === 'body') && !last.done) {
    const blocks = [...turn.blocks]
    blocks[blocks.length - 1] = { ...last, done: true }
    return { ...turn, blocks }
  }
  return turn
}

function appendText(state: ChatState, type: 'thought' | 'body', text: string): ChatState {
  if (text === '') return state
  const s = ensureTurn(state)
  return withTurn(s, (turn) => {
    const last = turn.blocks[turn.blocks.length - 1]
    if (last !== undefined && last.type === type && !last.done) {
      const blocks = [...turn.blocks]
      blocks[blocks.length - 1] = { ...last, text: last.text + text }
      return { ...turn, blocks }
    }
    const settled = closeStreaming(turn)
    return { ...settled, blocks: [...settled.blocks, { type, text, done: false }] }
  })
}

export function applyUpdate(state: ChatState, update: SessionUpdate): ChatState {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return {
        turns: [...state.turns, { id: state.seq + 1, userText: textOf(update), blocks: [], done: false }],
        seq: state.seq + 1,
      }
    case 'agent_thought_chunk':
      return appendText(state, 'thought', textOf(update))
    case 'agent_message_chunk':
      return appendText(state, 'body', textOf(update))
    case 'tool_call': {
      const s = ensureTurn(state)
      return withTurn(s, (turn) => {
        const call: ToolCall = {
          id: update.toolCallId ?? `tool-${turn.id}-${turn.blocks.length}`,
          title: update.title || update.kind || 'Tool',
          params: safeParams(update.parameters),
          done: false,
        }
        const settled = closeStreaming(turn)
        return { ...settled, blocks: [...settled.blocks, { type: 'tool', call }] }
      })
    }
    case 'tool_call_update': {
      const id = update.toolCallId
      if (id === undefined) return state
      return withTurn(state, (turn) => {
        for (let i = turn.blocks.length - 1; i >= 0; i--) {
          const block = turn.blocks[i]
          if (block !== undefined && block.type === 'tool' && block.call.id === id && !block.call.done) {
            const blocks = [...turn.blocks]
            blocks[i] = { type: 'tool', call: { ...block.call, done: true } }
            return { ...turn, blocks }
          }
        }
        return turn
      })
    }
    default:
      return state
  }
}

/** Settle the trailing turn after a prompt round-trip resolves. */
export function finishTurn(state: ChatState): ChatState {
  return withTurn(state, turn => ({ ...closeStreaming(turn), done: true }))
}

/** Attach an error to the trailing turn (failed prompt POST, dead runtime). */
export function setTurnError(state: ChatState, message: string): ChatState {
  return withTurn(ensureTurn(state), turn => ({ ...turn, error: message }))
}

/** Normalize one transcript row into a SessionUpdate, or undefined. */
export function rowUpdate(row: TranscriptRow): SessionUpdate | undefined {
  const raw = row.update
  const update = typeof raw === 'string' ? safeParse(raw) : raw
  if (typeof update === 'object' && update !== null) return update as SessionUpdate
  return undefined
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Rebuild chat state from transcript rows. Replay and live streaming share
 * this reducer, so a reloaded session renders exactly like the live one.
 */
export function fromRows(rows: readonly TranscriptRow[]): ChatState {
  let state = emptyChat
  for (const row of rows) {
    const update = rowUpdate(row)
    if (update !== undefined) state = applyUpdate(state, update)
  }
  return finishTurn(state)
}
