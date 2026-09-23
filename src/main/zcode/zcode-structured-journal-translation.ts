import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody,
  AgentJournalResolution,
  AgentJournalStatusItem,
  AgentJournalToolCallState,
  AgentJournalTurnLifecycleState,
  AgentJournalTurnOutcome,
  AgentJournalTurnUsage
} from '../../shared/agent-session-journal-types'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import type { ZcodeSessionEventEnvelope } from './zcode-protocol'
import {
  zcodeApprovalItem,
  zcodePermissionResolution
} from './zcode-structured-journal-prompt-items'
import {
  translateZcodeModelStreaming,
  translateZcodeToolUpdated
} from './zcode-structured-journal-tool-translation'

// One ZCode `session/event` notification → the journal writes it implies.
//
// Pure on purpose: envelope in, translation out, no sink and no state. The
// consumer (Task 11 adapter) owns what codex's translator keeps internally —
// minting AgentJournalItemIdentity from each arm's provider itemKey,
// accumulating stream deltas into codex-style snapshot appends, merging
// tool-call updates onto the remembered row, and settling prompts.

export type ZcodeJournalItemAppend = {
  /** Provider reconciliation key (toolCallId for tool calls, requestId for prompts). */
  itemKey: string
  body: AgentJournalItemBody
  observedAt: number
  /** Mirrors codex: rows with a resolution settle through the lifecycle barrier. */
  lifecycle: boolean
}

export type ZcodeJournalStreamDelta = {
  /** Accumulation key: assistantMessageId for text/reasoning, toolCallId for tool-input. */
  streamId: string
  kind: 'text' | 'reasoning' | 'tool-input'
  delta: string
  toolName?: string
  observedAt: number
}

/** A state advance for a tool-call row keyed by an earlier append. Fields the
 *  source event did not carry are absent; the consumer merges, never replaces. */
export type ZcodeJournalToolCallUpdate = {
  itemKey: string
  state: AgentJournalToolCallState
  toolName?: string
  output?: AgentJournalBoundedPayload
  durationMs?: number
  observedAt: number
}

export type ZcodeJournalPromptResolution = {
  /** The `permission.requested` requestId the settled item was keyed by. */
  promptKey: string
  resolution: AgentJournalResolution
}

export type ZcodeJournalTurnBoundary = {
  turnId: string
  state: AgentJournalTurnLifecycleState
  /** The provider's own verdict; absent means unknown, never success. */
  outcome?: AgentJournalTurnOutcome
  /** Provider ids of the user message that opened the turn, for dispatch settle. */
  userMessageId?: string
  inputId?: string
  startedAt?: number
  completedAt?: number
  durationMs?: number
  /** Provider-reported token usage of the finished turn, when it carried any. */
  usage?: AgentJournalTurnUsage
}

export type ZcodeJournalGenericFrame = {
  itemKey: string
  body: AgentJournalStatusItem
  classification: 'timeline-substantive' | 'error-surface'
  turnId: string | null
  observedAt: number
}

export type ZcodeJournalTranslation = {
  appendItems: ZcodeJournalItemAppend[]
  streamDeltas: ZcodeJournalStreamDelta[]
  toolCallUpdates: ZcodeJournalToolCallUpdate[]
  genericFrames: ZcodeJournalGenericFrame[]
  promptResolution: ZcodeJournalPromptResolution | null
  turnBoundary: ZcodeJournalTurnBoundary | null
}

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

/** The provider's verdict on a finished turn. `cancelled` interrupts the
 *  lifecycle row as well; anything unplaced stays unknown — `completed` alone
 *  proves nothing. */
function zcodeTurnOutcome(resultType: string | null): AgentJournalTurnOutcome | undefined {
  if (resultType === 'success') {
    return 'success'
  }
  if (resultType === 'error' || resultType === 'failed') {
    return 'failure'
  }
  if (resultType === 'cancelled' || resultType === 'canceled' || resultType === 'interrupted') {
    return 'cancellation'
  }
  return undefined
}

function appendGenericFrame(
  envelope: ZcodeSessionEventEnvelope,
  translation: ZcodeJournalTranslation
): void {
  const frame = unhandledProviderFrameJournalItem('zcode', envelope.type, envelope.payload)
  if (!frame) {
    return
  }
  translation.genericFrames.push({
    itemKey: envelope.eventId,
    body: frame.body,
    classification: frame.classification,
    turnId: envelope.turnId ?? null,
    observedAt: envelope.timestamp
  })
}

function translateTurnStart(
  envelope: ZcodeSessionEventEnvelope,
  translation: ZcodeJournalTranslation
): boolean {
  if (!envelope.turnId) {
    return false
  }
  const userMessageId = readString(envelope.payload, 'messageId')
  const inputId = readString(envelope.payload, 'inputId')
  translation.turnBoundary = {
    turnId: envelope.turnId,
    state: 'running',
    startedAt: envelope.timestamp,
    ...(userMessageId === null ? {} : { userMessageId }),
    ...(inputId === null ? {} : { inputId })
  }
  return true
}

/** Token usage off a `turn.completed` payload. The wire schema leaves `usage`
 *  open (z.unknown), so every field is screened here; `totalTokens` is derived
 *  from the sibling `tokenCount` or input+output when the provider omitted it,
 *  and a payload with no usable token fact at all yields undefined. */
function zcodeTurnUsageFromPayload(payload: unknown): AgentJournalTurnUsage | undefined {
  if (!isRecord(payload)) {
    return undefined
  }
  const usage = isRecord(payload.usage) ? payload.usage : undefined
  const readUsageCount = (key: string): number | undefined => {
    const value = usage?.[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
  }
  const inputTokens = readUsageCount('inputTokens')
  const outputTokens = readUsageCount('outputTokens')
  const payloadTokenCount = readFiniteNumber(payload, 'tokenCount') ?? undefined
  const totalTokens =
    readUsageCount('totalTokens') ??
    payloadTokenCount ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined)
  if (totalTokens === undefined) {
    return undefined
  }
  const cacheReadTokens = readUsageCount('cacheReadTokens')
  const cacheWriteTokens = readUsageCount('cacheWriteTokens')
  const reasoningTokens = readUsageCount('reasoningTokens')
  const modelRequestCount = readUsageCount('modelRequestCount')
  return {
    totalTokens,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(modelRequestCount === undefined ? {} : { modelRequestCount })
  }
}

function translateTurnCompletion(
  envelope: ZcodeSessionEventEnvelope,
  translation: ZcodeJournalTranslation
): boolean {
  if (!envelope.turnId) {
    return false
  }
  const resultType = readString(envelope.payload, 'resultType')
  const outcome = zcodeTurnOutcome(resultType)
  const durationMs = readFiniteNumber(envelope.payload, 'duration')
  const usage = zcodeTurnUsageFromPayload(envelope.payload)
  translation.turnBoundary = {
    turnId: envelope.turnId,
    state: outcome === 'cancellation' ? 'interrupted' : 'completed',
    ...(outcome === undefined ? {} : { outcome }),
    completedAt: envelope.timestamp,
    ...(durationMs === null ? {} : { durationMs }),
    ...(usage === undefined ? {} : { usage })
  }
  return true
}

/** Routes one envelope onto the typed arms; false means the generic-frame
 *  fallback owns it. A typed event missing its key fields also returns false so
 *  it degrades to a visible row instead of vanishing. */
function translateTypedEvent(
  envelope: ZcodeSessionEventEnvelope,
  translation: ZcodeJournalTranslation
): boolean {
  if (envelope.type === 'turn.started') {
    return translateTurnStart(envelope, translation)
  }
  if (envelope.type === 'turn.completed') {
    return translateTurnCompletion(envelope, translation)
  }
  if (envelope.type === 'turn.failed') {
    if (!envelope.turnId) {
      return false
    }
    // Codex writes the provider's error sentence inside the turn this same
    // frame ends; the boundary alone would swallow the reason.
    appendGenericFrame(envelope, translation)
    translation.turnBoundary = {
      turnId: envelope.turnId,
      state: 'completed',
      outcome: 'failure',
      completedAt: envelope.timestamp
    }
    return true
  }
  if (envelope.type === 'model.streaming') {
    return translateZcodeModelStreaming(envelope, translation)
  }
  if (envelope.type === 'tool.updated') {
    return translateZcodeToolUpdated(envelope, translation)
  }
  if (envelope.type === 'permission.requested') {
    const requestId = readString(envelope.payload, 'requestId')
    if (requestId === null) {
      return false
    }
    translation.appendItems.push({
      itemKey: requestId,
      body: zcodeApprovalItem(envelope.payload),
      observedAt: envelope.timestamp,
      lifecycle: true
    })
    return true
  }
  if (envelope.type === 'permission.resolved') {
    const requestId = readString(envelope.payload, 'requestId')
    if (requestId === null) {
      return false
    }
    translation.promptResolution = {
      promptKey: requestId,
      resolution: zcodePermissionResolution(envelope.payload, envelope.timestamp)
    }
    return true
  }
  // userInput.requested/.resolved land here too: the payload has no spike
  // transcript yet, so question items wait for a real shape (FU).
  return false
}

export function translateZcodeSessionEvent(
  envelope: ZcodeSessionEventEnvelope
): ZcodeJournalTranslation {
  const translation: ZcodeJournalTranslation = {
    appendItems: [],
    streamDeltas: [],
    toolCallUpdates: [],
    genericFrames: [],
    promptResolution: null,
    turnBoundary: null
  }
  if (!translateTypedEvent(envelope, translation)) {
    appendGenericFrame(envelope, translation)
  }
  return translation
}
