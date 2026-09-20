import { describe, expect, it } from 'vitest'
import {
  applyUpdate,
  emptyChat,
  finishTurn,
  fromRows,
  rowUpdate,
  setTurnError,
  type Block,
  type ChatState,
  type SessionUpdate,
} from '../src/events'

const user = (text: string): SessionUpdate => ({
  sessionUpdate: 'user_message_chunk',
  content: { type: 'text', text },
})
const thought = (text: string): SessionUpdate => ({
  sessionUpdate: 'agent_thought_chunk',
  content: { type: 'text', text },
})
const body = (text: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
})
const tool = (id: string, title: string): SessionUpdate => ({
  sessionUpdate: 'tool_call',
  toolCallId: id,
  title,
  parameters: { path: '/tmp/x' },
})
const toolDone = (id: string): SessionUpdate => ({
  sessionUpdate: 'tool_call_update',
  toolCallId: id,
})

const fold = (updates: readonly SessionUpdate[]): ChatState =>
  updates.reduce((state, update) => applyUpdate(state, update), emptyChat)

const typesOf = (state: ChatState): string[] =>
  state.turns.flatMap(turn => turn.blocks.map((block: Block) => block.type))

describe('turn boundaries', () => {
  it('opens a new turn per user echo, even for identical text', () => {
    const state = fold([user('继续'), thought('a'), user('继续'), thought('b')])
    expect(state.turns).toHaveLength(2)
    expect(state.turns[0]?.userText).toBe('继续')
    expect(state.turns[1]?.userText).toBe('继续')
  })

  it('auto-creates an orphan turn when content precedes any user echo', () => {
    const state = fold([body('hello')])
    expect(state.turns).toHaveLength(1)
    expect(state.turns[0]?.userText).toBe('')
  })
})

describe('block interleaving', () => {
  it('preserves thought/body/tool order and closes blocks on switch', () => {
    const state = fold([
      user('q'),
      thought('t1'),
      body('b1'),
      tool('t-1', 'bash'),
      thought('t2'),
      body('b2'),
    ])
    expect(typesOf(state)).toEqual(['thought', 'body', 'tool', 'thought', 'body'])
    const [t1, b1, , t2, b2] = state.turns[0]?.blocks ?? []
    expect(t1).toMatchObject({ type: 'thought', done: true })
    expect(b1).toMatchObject({ type: 'body', done: true })
    expect(t2).toMatchObject({ type: 'thought', done: true })
    expect(b2).toMatchObject({ type: 'body', done: false })
  })

  it('accumulates consecutive same-kind chunks into one block', () => {
    const state = fold([user('q'), thought('he'), thought('llo'), body('wo'), body('rld')])
    expect(state.turns[0]?.blocks).toHaveLength(2)
    expect(state.turns[0]?.blocks[0]).toMatchObject({ text: 'hello' })
    expect(state.turns[0]?.blocks[1]).toMatchObject({ text: 'world' })
  })
})

describe('tool calls', () => {
  it('marks the most recent matching tool done and ignores unknown ids', () => {
    const state = fold([user('q'), tool('a', 'read'), tool('b', 'bash'), toolDone('a')])
    const blocks = state.turns[0]?.blocks ?? []
    expect(blocks[0]).toMatchObject({ type: 'tool', call: { id: 'a', done: true } })
    expect(blocks[1]).toMatchObject({ type: 'tool', call: { id: 'b', done: false } })
    const unknown = applyUpdate(state, toolDone('zzz'))
    expect(unknown).toBe(state)
  })

  it('serializes parameters and defaults the title', () => {
    const state = fold([tool('x', '')])
    expect(state.turns[0]?.blocks[0]).toMatchObject({
      type: 'tool',
      call: { title: 'Tool', params: '{"path":"/tmp/x"}' },
    })
  })
})

describe('turn completion and errors', () => {
  it('finishTurn settles trailing streaming blocks', () => {
    const state = finishTurn(fold([user('q'), thought('t'), body('b')]))
    expect(state.turns[0]?.done).toBe(true)
    expect(state.turns[0]?.blocks.every(block =>
      block.type === 'tool' || block.done)).toBe(true)
  })

  it('setTurnError lands on the trailing turn, creating one if needed', () => {
    expect(setTurnError(emptyChat, 'boom').turns[0]?.error).toBe('boom')
    const state = setTurnError(fold([user('q')]), 'boom')
    expect(state.turns).toHaveLength(1)
    expect(state.turns[0]?.error).toBe('boom')
  })
})

describe('edge branches', () => {
  it('safeParams handles null and unserializable parameters', () => {
    const withNull = fold([user('q'), { sessionUpdate: 'tool_call', toolCallId: 'n1', parameters: null }])
    expect(withNull.turns[0]?.blocks[0]).toMatchObject({ type: 'tool', call: { params: '' } })

    const circular: Record<string, unknown> = {}
    circular.self = circular
    const withCyclic = fold([user('q'), { sessionUpdate: 'tool_call', toolCallId: 'n2', parameters: circular }])
    expect(withCyclic.turns[0]?.blocks[0]).toMatchObject({ type: 'tool', call: { params: '[object Object]' } })
  })

  it('ignores unknown update kinds and empty chunks', () => {
    const state = fold([user('q')])
    expect(applyUpdate(state, { sessionUpdate: 'config_option_update' })).toBe(state)
    expect(applyUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { text: '' } })).toBe(state)
    expect(applyUpdate(state, { sessionUpdate: 'agent_thought_chunk' })).toBe(state)
  })

  it('finishTurn on an empty chat is identity', () => {
    expect(finishTurn(emptyChat)).toBe(emptyChat)
  })

  it('rowUpdate filters non-object and malformed rows', () => {
    expect(rowUpdate({ update: 5 })).toBeUndefined()
    expect(rowUpdate({ update: '{not json' })).toBeUndefined()
    expect(rowUpdate({})).toBeUndefined()
  })

  it('tolerates tool events without ids', () => {
    const anon = fold([user('q'), { sessionUpdate: 'tool_call', kind: 'read' }])
    expect(anon.turns[0]?.blocks[0]).toMatchObject({ type: 'tool', call: { title: 'read' } })

    const noUpdateId = applyUpdate(anon, { sessionUpdate: 'tool_call_update' })
    expect(noUpdateId).toBe(anon)

    // fromRows skips garbage rows instead of aborting the replay
    const mixed = fromRows([{ update: 42 }, { update: user('q') }, { update: '{oops' }, { update: body('hi') }])
    expect(mixed.turns).toHaveLength(1)
    expect(mixed.turns[0]?.blocks[0]).toMatchObject({ type: 'body', text: 'hi' })
  })
})

describe('transcript replay', () => {
  it('rebuilds identical state from rows, including JSON-encoded updates', () => {
    const rows = [
      { update: user('hi') },
      { update: JSON.stringify(thought('thinking...')) },
      { update: body('answer') },
    ]
    const state = fromRows(rows)
    expect(state.turns).toHaveLength(1)
    expect(typesOf(state)).toEqual(['thought', 'body'])
    expect(state.turns[0]?.done).toBe(true)
  })
})
