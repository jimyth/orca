// Spike-transcript end-to-end reflow: the recorded session/event frames flow
// through the live adapter (envelope parse → translation → merge) and land as
// the final journal rows the renderer consumes, plus the renderer-side diff
// contract that the Write row's input must keep satisfying.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { diffFromToolCall } from '../../shared/native-chat-diff'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { adapterFor, fakeZcode, identityFor } from './zcode-structured-session-adapter-fixture'

type RecordedRow = { identity: AgentJournalItemIdentity; body: AgentJournalItemBody }

function recordingSink(): { sink: StructuredAgentSessionEventSink; rows: () => RecordedRow[] } {
  const byKey = new Map<string, RecordedRow>()
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity, body) => {
      byKey.set(agentJournalItemKey(identity), { identity, body })
    },
    appendTombstone: () => {},
    publish: () => {}
  }
  return { sink, rows: () => [...byKey.values()] }
}

type TranscriptLine = { direction?: string; method?: string; params?: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function spikeSessionEventParams(): Record<string, unknown>[] {
  return readFileSync(
    new URL('./fixtures/spike-session-transcript.ndjson', import.meta.url),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line): TranscriptLine => JSON.parse(line))
    .filter((line) => line.direction === 'in' && line.method === 'session/event')
    .flatMap((line) => (isRecord(line.params) ? [line.params] : []))
}

/** Feeds the recorded spike transcript through a live adapter; rows reflect the
 *  journal's upsert semantics, so each key reads in its final merged state. */
async function reflowSpikeTranscript(): Promise<RecordedRow[]> {
  const zcode = fakeZcode()
  const { sink, rows } = recordingSink()
  const adapter = adapterFor(zcode)
  await adapter.acquire({
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    events: sink
  })
  for (const frame of spikeSessionEventParams()) {
    zcode.connections[0].handlers.onNotification?.('session/event', frame)
  }
  return rows()
}

describe('spike transcript reflow into journal rows', () => {
  it('lands the Write call completed with its assembled input, output, and duration', async () => {
    const rows = await reflowSpikeTranscript()
    const write = rows.find(
      (row) => row.body.kind === 'tool-call' && row.body.name === 'Write'
    )?.body
    expect(write).toMatchObject({
      kind: 'tool-call',
      callId: 'call_ed045ab8e9aa42fba23974b7',
      // The whole-input object survives verbatim (the renderer's diff contract
      // below reads it); the partial streamed JSON never shows in the end state.
      input: { file_path: '/tmp/zcode-spike-ws/spike.txt', content: 'hi\n' },
      state: 'completed',
      output: {
        head: 'File created successfully at: /tmp/zcode-spike-ws/spike.txt (file state is current in your context — no need to Read it back)',
        truncated: false
      },
      durationMs: 11
    })
  })

  it('lands the Read call completed with its own output and duration', async () => {
    const rows = await reflowSpikeTranscript()
    const read = rows.find((row) => row.body.kind === 'tool-call' && row.body.name === 'Read')?.body
    expect(read).toMatchObject({
      kind: 'tool-call',
      callId: 'call_7102b1ad2e6844cc9f71047b',
      input: { file_path: '/tmp/zcode-spike-ws/spike.txt' },
      state: 'completed',
      output: { truncated: false },
      durationMs: 2
    })
  })

  it('accumulates streamed assistant and reasoning messages to their full text, kept apart', async () => {
    const rows = await reflowSpikeTranscript()
    const messages = rows.filter((row) => row.body.kind === 'message')
    // The final turn interleaves reasoning and text under one message id; the
    // rows must stay separate streams or one swallows the other's text.
    const finalText = messages.find(
      (row) =>
        row.body.kind === 'message' &&
        row.body.role === 'assistant' &&
        row.body.blocks.some((block) => block.type === 'text' && block.text.startsWith('Done.'))
    )?.body
    const finalBlocks =
      finalText?.kind === 'message'
        ? finalText.blocks.map((block) => (block.type === 'text' ? block.text : ''))
        : []
    expect(finalBlocks).toEqual([
      'Done. Created `/tmp/zcode-spike-ws/spike.txt` containing `hi`, and reading it back confirms the file contains exactly that text.'
    ])
    const finalReasoning = messages.find(
      (row) =>
        row.body.kind === 'message' &&
        row.body.role === 'reasoning' &&
        row.body.blocks.some(
          (block) => block.type === 'text' && block.text.includes('final message')
        )
    )?.body
    expect(
      finalReasoning?.kind === 'message' &&
        finalReasoning.blocks.some(
          (block) => block.type === 'text' && block.text.startsWith('The Read call was flagged')
        )
    ).toBe(true)
  })

  it('settles the turn and the permission approval from the recorded frames', async () => {
    const rows = await reflowSpikeTranscript()
    expect(rows.find((row) => row.body.kind === 'turn')?.body).toMatchObject({
      kind: 'turn',
      state: 'completed',
      outcome: 'success',
      durationMs: 7899
    })
    expect(rows.find((row) => row.body.kind === 'approval')?.body).toMatchObject({
      kind: 'approval',
      title: 'Allow Write?',
      resolution: { state: 'resolved', selectedOptionId: 'allow' }
    })
  })

  it('keeps the Write row input in the shape the renderer turns into a diff card', async () => {
    const rows = await reflowSpikeTranscript()
    const write = rows.find(
      (row) => row.body.kind === 'tool-call' && row.body.name === 'Write'
    )?.body
    if (write?.kind !== 'tool-call') {
      throw new Error('test expected the spike Write tool-call row')
    }
    // Locks the render contract end to end: EDIT_TOOL_NAMES covers Write and the
    // content fallback paints the whole file as additions — the honest "new
    // file" diff, since the provider's input carries no previous content.
    expect(diffFromToolCall('Write', write.input)).toEqual([
      { kind: 'meta', text: '/tmp/zcode-spike-ws/spike.txt' },
      { kind: 'add', text: 'hi' }
    ])
    // A read tool is not an edit: its input must not paint a diff card.
    expect(diffFromToolCall('Read', { file_path: '/tmp/zcode-spike-ws/spike.txt' })).toBeNull()
  })
})

describe('streamed delta bounds in journal rows', () => {
  const oversizedText = 'x'.repeat(20 * 1024)

  const reflowDeltas = async (frames: Record<string, unknown>[]): Promise<RecordedRow[]> => {
    const zcode = fakeZcode()
    const { sink, rows } = recordingSink()
    const adapter = adapterFor(zcode)
    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      events: sink
    })
    let seq = 0
    for (const payload of frames) {
      seq += 1
      zcode.connections[0].handlers.onNotification?.('session/event', {
        eventId: `evt-bounds-${seq}`,
        sessionId: 'sess_e2d0e231-d28d-4ffc-b4a8-4fba6aaff29f',
        turnId: 'turn_701dd6be-2ad0-4b18-b922-f570b9093636',
        seq,
        timestamp: 1_790_103_642_782,
        type: 'model.streaming',
        payload
      })
    }
    return rows()
  }

  it('bounds an oversized streamed assistant message and marks the truncation', async () => {
    const rows = await reflowDeltas([
      { assistantMessageId: 'am-big', kind: 'text_delta', delta: oversizedText, done: false }
    ])
    const message = rows.find((row) => row.body.kind === 'message')?.body
    if (message?.kind !== 'message') {
      throw new Error('test expected a streamed message row')
    }
    const block = message.blocks[0]
    if (block?.type !== 'text') {
      throw new Error('test expected a text block')
    }
    expect(block.text.length).toBeLessThan(oversizedText.length)
    expect(block.text).toMatch(/\[Orca: output truncated — \d+ bytes total/)
  })

  it('bounds an oversized streamed tool input, then the assembled tool_call restores the whole input', async () => {
    const rows = await reflowDeltas([
      { toolCallId: 'tc-big', toolName: 'Write', kind: 'tool_input_delta', delta: oversizedText },
      {
        toolCallId: 'tc-big',
        toolName: 'Write',
        kind: 'tool_call',
        input: { file_path: '/tmp/sandbox/b.txt', content: 'ok\n' }
      }
    ])
    const call = rows.find((row) => row.body.kind === 'tool-call')?.body
    if (call?.kind !== 'tool-call') {
      throw new Error('test expected a tool-call row')
    }
    // The assembled frame replaces the bounded partial with the provider's own
    // parsed input, so a complete write still renders its diff card.
    expect(call).toMatchObject({
      kind: 'tool-call',
      name: 'Write',
      input: { file_path: '/tmp/sandbox/b.txt', content: 'ok\n' }
    })
    expect(diffFromToolCall('Write', call.input)).toEqual([
      { kind: 'meta', text: '/tmp/sandbox/b.txt' },
      { kind: 'add', text: 'ok' }
    ])
  })
})
