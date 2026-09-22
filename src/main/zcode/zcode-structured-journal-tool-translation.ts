import {
  boundInlineText,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { ZcodeSessionEventEnvelope } from './zcode-protocol'
import type { ZcodeJournalTranslation } from './zcode-structured-journal-translation'

// `model.streaming` and `tool.updated` session events → the tool-call arms of a
// journal translation. ZCode splits one tool call across several events: the
// input streams in `model.streaming` frames (the assembled `tool_call` frame
// carries the whole input), then `tool.updated` advances the state. A stateless
// translator cannot merge them, so full bodies and state advances travel as
// separate arms and the consumer merges by toolCallId.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readString = (source: unknown, key: string): string | null => {
  const value = isRecord(source) ? source[key] : undefined
  return typeof value === 'string' && value.length > 0 ? value : null
}

const readFiniteNumber = (source: unknown, key: string): number | null => {
  const value = isRecord(source) ? source[key] : undefined
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function translateZcodeModelStreaming(
  envelope: ZcodeSessionEventEnvelope,
  translation: ZcodeJournalTranslation
): boolean {
  const kind = readString(envelope.payload, 'kind')
  const delta = isRecord(envelope.payload) ? envelope.payload.delta : undefined
  if (kind === 'text_delta' || kind === 'reasoning_delta') {
    const streamId = readString(envelope.payload, 'assistantMessageId')
    if (streamId === null || typeof delta !== 'string') {
      return false
    }
    translation.streamDeltas.push({
      streamId,
      kind: kind === 'text_delta' ? 'text' : 'reasoning',
      delta,
      observedAt: envelope.timestamp
    })
    return true
  }
  if (kind === 'tool_input_start' || kind === 'tool_input_delta' || kind === 'tool_input_end') {
    const toolCallId = readString(envelope.payload, 'toolCallId')
    if (toolCallId === null || typeof delta !== 'string') {
      return false
    }
    const toolName = readString(envelope.payload, 'toolName')
    translation.streamDeltas.push({
      streamId: toolCallId,
      kind: 'tool-input',
      delta,
      ...(toolName === null ? {} : { toolName }),
      observedAt: envelope.timestamp
    })
    return true
  }
  if (kind === 'tool_call') {
    const toolCallId = readString(envelope.payload, 'toolCallId')
    const toolName = readString(envelope.payload, 'toolName')
    if (toolCallId === null || toolName === null) {
      return false
    }
    translation.appendItems.push({
      itemKey: toolCallId,
      body: {
        kind: 'tool-call',
        name: toolName,
        callId: toolCallId,
        input: boundToolInput(
          isRecord(envelope.payload) ? envelope.payload.input : undefined,
          DEFAULT_JOURNAL_PAYLOAD_LIMITS
        ),
        state: 'running'
      },
      observedAt: envelope.timestamp,
      lifecycle: false
    })
    return true
  }
  return false
}

export function translateZcodeToolUpdated(
  envelope: ZcodeSessionEventEnvelope,
  translation: ZcodeJournalTranslation
): boolean {
  const kind = readString(envelope.payload, 'kind')
  if (kind === 'batch') {
    // Pure aggregation after the per-call `result` events; no state to advance.
    return true
  }
  const toolCallId = readString(envelope.payload, 'toolCallId')
  if (toolCallId === null) {
    return false
  }
  const observedAt = envelope.timestamp
  if (kind === 'scheduled' || kind === 'started') {
    const toolName = readString(envelope.payload, 'toolName')
    translation.toolCallUpdates.push({
      itemKey: toolCallId,
      state: 'running',
      ...(toolName === null ? {} : { toolName }),
      observedAt
    })
    return true
  }
  if (kind === 'result') {
    const result = isRecord(envelope.payload) ? envelope.payload.result : undefined
    const content = isRecord(result) && typeof result.content === 'string' ? result.content : null
    const durationMs = readFiniteNumber(envelope.payload, 'duration')
    translation.toolCallUpdates.push({
      itemKey: toolCallId,
      state: isRecord(result) && result.success === false ? 'failed' : 'completed',
      ...(content === null || content.length === 0
        ? {}
        : { output: boundInlineText(content, DEFAULT_JOURNAL_PAYLOAD_LIMITS).bounded }),
      ...(durationMs === null ? {} : { durationMs }),
      observedAt
    })
    return true
  }
  return false
}
