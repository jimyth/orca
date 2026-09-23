// `model.streaming` deltas → journal rows. Reasoning and assistant text
// interleave under one assistantMessageId, so each kind accumulates on its own
// stream key; a tool input accumulates raw until the assembled `tool_call`
// frame replaces it with the provider's parsed input.

import type {
  AgentJournalItemBody,
  AgentJournalToolCallItem
} from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { ZcodeJournalTranslation } from './zcode-structured-journal-translation'
import type { ZcodeSession } from './zcode-structured-session-state'

/** Journal-append helper; false means the row was refused and the child is
 *  being force-closed. */
export type ZcodeStreamDeltaAppend = (
  itemKey: string,
  body: AgentJournalItemBody,
  observedAt: number
) => boolean

export function applyZcodeStreamDeltas(
  session: ZcodeSession,
  deltas: ZcodeJournalTranslation['streamDeltas'],
  append: ZcodeStreamDeltaAppend
): boolean {
  for (const delta of deltas) {
    // The accumulation key separates reasoning from assistant text under one
    // message id, or one message swallows the other's text under whichever
    // kind arrived last.
    const streamKey =
      delta.kind === 'tool-input' ? delta.streamId : `${delta.kind}:${delta.streamId}`
    const prior = session.streams.get(streamKey)
    const text = `${prior?.text ?? ''}${delta.delta}`
    session.streams.set(streamKey, {
      kind: delta.kind,
      text,
      toolName: delta.toolName ?? prior?.toolName ?? null
    })
    if (delta.kind === 'tool-input') {
      const remembered = session.items.get(delta.streamId)
      const base: AgentJournalToolCallItem =
        remembered?.kind === 'tool-call'
          ? remembered
          : {
              kind: 'tool-call',
              name: delta.toolName ?? prior?.toolName ?? delta.streamId,
              callId: delta.streamId,
              input: undefined,
              state: 'running'
            }
      const merged: AgentJournalToolCallItem = {
        ...base,
        input: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
      }
      session.items.set(delta.streamId, merged)
      if (!append(delta.streamId, merged, delta.observedAt)) {
        return false
      }
      continue
    }
    if (
      !append(
        `stream:${streamKey}`,
        {
          kind: 'message',
          role: delta.kind === 'text' ? 'assistant' : 'reasoning',
          blocks: [
            { type: 'text', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }
          ]
        },
        delta.observedAt
      )
    ) {
      return false
    }
  }
  return true
}
