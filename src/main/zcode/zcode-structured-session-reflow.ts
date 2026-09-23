// Live zcode `session/event` notifications → durable journal rows and host
// events.
//
// The Task 10 translator is a pure function, so this module owns what codex's
// translator keeps internally: minting journal identities from each arm's
// provider itemKey, merging tool-call updates onto the remembered row,
// accumulating stream deltas into snapshot appends, settling prompt rows, and
// keeping the journal write ahead of the host event that observes it.

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalToolCallItem
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAppendOptions } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  ZCODE_NOTIFICATION_METHODS,
  type ZcodeSessionEventEnvelope,
  type ZcodeSessionEventType
} from './zcode-protocol'
import type { ZcodeJournalTranslation } from './zcode-structured-journal-translation'
import { translateZcodeSessionEvent } from './zcode-structured-journal-translation'
import {
  zcodeItemIdentity,
  type ZcodeSession,
  type ZcodeStructuredSessionEvent
} from './zcode-structured-session-state'

export type ZcodeReflowWiring = {
  emit: (event: ZcodeStructuredSessionEvent) => void
  /** Sink-refused rows force the child closed so host recovery records a
   *  truthful terminal failure instead of silently dropping provider output. */
  forceCloseUnexpected: (reason: Error) => void
  onDispatchSettledLate?: (input: {
    sessionId: string
    clientMessageId: string
    providerIdentity: AgentJournalItemIdentity
  }) => void
  now?: () => number
}

export type ZcodeJournalAdmission = { accepted: true } | { accepted: false; reason: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Journal-append helper threaded through every translation arm; false means
 *  the row was refused and the child is being force-closed. */
type ZcodeJournalAppend = (
  itemKey: string,
  body: AgentJournalItemBody,
  options: StructuredAgentSessionAppendOptions
) => boolean

export function appendZcodeJournalRow(
  session: ZcodeSession,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  options: StructuredAgentSessionAppendOptions
): ZcodeJournalAdmission {
  const sink = session.sink
  if (!sink) {
    return { accepted: true }
  }
  if (!sink.tryAppendItem) {
    sink.appendItem(identity, body, options)
    return { accepted: true }
  }
  const admission = sink.tryAppendItem(identity, body, options)
  return admission.accepted ? { accepted: true } : { accepted: false, reason: admission.reason }
}

/** Parses one `session/event` notification body into its envelope, or null when
 *  the frame carries no usable key (the frame reader already drops unparseable
 *  lines; an envelope without ids has no journal key to append under). */
export function readZcodeSessionEventEnvelope(params: unknown): ZcodeSessionEventEnvelope | null {
  if (!isRecord(params)) {
    return null
  }
  const { eventId, sessionId, seq, timestamp, type, turnId, payload } = params
  if (
    typeof eventId !== 'string' ||
    eventId.length === 0 ||
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    typeof type !== 'string' ||
    type.length === 0 ||
    typeof seq !== 'number' ||
    !Number.isFinite(seq) ||
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp)
  ) {
    return null
  }
  return {
    eventId,
    sessionId,
    seq,
    timestamp,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: unknown event types must still parse (the protocol has no stability promise); the translator compares type strings and routes anything unrecognized to the generic-frame fallback.
    type: type as ZcodeSessionEventType,
    ...(typeof turnId === 'string' && turnId.length > 0 ? { turnId } : {}),
    payload
  }
}

export function deliverZcodeNotification(input: {
  session: ZcodeSession | undefined
  sessionId: string
  method: string
  params: unknown
  wiring: ZcodeReflowWiring
}): void {
  const { session, sessionId, method, params, wiring } = input
  if (!session || method !== ZCODE_NOTIFICATION_METHODS.sessionEvent) {
    // storageState is consumed inside the connection; no other notification
    // method exists on the wire today.
    return
  }
  const envelope = readZcodeSessionEventEnvelope(params)
  if (envelope === null || envelope.sessionId !== session.providerSessionId) {
    return
  }
  // Journal first so observers never see an event ahead of its durable row.
  const admitted = applyZcodeTranslation(
    session,
    sessionId,
    translateZcodeSessionEvent(envelope),
    wiring
  )
  if (admitted) {
    wiring.emit({
      type: 'session-event',
      sessionId,
      providerSessionId: session.providerSessionId,
      envelope
    })
  }
}

function applyZcodeTranslation(
  session: ZcodeSession,
  sessionId: string,
  translation: ZcodeJournalTranslation,
  wiring: ZcodeReflowWiring
): boolean {
  const append: ZcodeJournalAppend = (itemKey, body, options) => {
    const admission = appendZcodeJournalRow(
      session,
      zcodeItemIdentity(session.providerSessionId, itemKey),
      body,
      options
    )
    if (!admission.accepted) {
      wiring.forceCloseUnexpected(
        new Error(
          `zcode journal row ${itemKey} could not be durably recorded (${admission.reason})`
        )
      )
      return false
    }
    return true
  }
  for (const item of translation.appendItems) {
    if (item.body.kind === 'approval' && session.items.has(item.itemKey)) {
      // The server-request path already journaled this pending prompt.
      continue
    }
    session.items.set(item.itemKey, item.body)
    if (
      !append(item.itemKey, item.body, {
        observedAt: item.observedAt,
        ...(item.lifecycle ? { lifecycle: true } : {})
      })
    ) {
      return false
    }
  }
  for (const update of translation.toolCallUpdates) {
    const remembered = session.items.get(update.itemKey)
    const base: AgentJournalToolCallItem =
      remembered?.kind === 'tool-call'
        ? remembered
        : {
            kind: 'tool-call',
            name: update.toolName ?? update.itemKey,
            callId: update.itemKey,
            input: undefined,
            state: 'running'
          }
    const merged: AgentJournalToolCallItem = {
      ...base,
      state: update.state,
      ...(update.toolName === undefined ? {} : { name: update.toolName }),
      ...(update.output === undefined ? {} : { output: update.output }),
      ...(update.durationMs === undefined ? {} : { durationMs: update.durationMs })
    }
    session.items.set(update.itemKey, merged)
    if (!append(update.itemKey, merged, { observedAt: update.observedAt })) {
      return false
    }
  }
  for (const delta of translation.streamDeltas) {
    if (!applyStreamDelta(session, delta, append)) {
      return false
    }
  }
  for (const frame of translation.genericFrames) {
    if (!append(frame.itemKey, frame.body, { observedAt: frame.observedAt })) {
      return false
    }
  }
  if (translation.promptResolution) {
    if (!applyPromptResolution(session, translation.promptResolution, append)) {
      return false
    }
  }
  if (translation.turnBoundary) {
    if (!applyTurnBoundary(session, sessionId, translation.turnBoundary, wiring, append)) {
      return false
    }
  }
  session.sink?.publish()
  return true
}

function applyStreamDelta(
  session: ZcodeSession,
  delta: ZcodeJournalTranslation['streamDeltas'][number],
  append: ZcodeJournalAppend
): boolean {
  const prior = session.streams.get(delta.streamId)
  const text = `${prior?.text ?? ''}${delta.delta}`
  session.streams.set(delta.streamId, {
    kind: delta.kind,
    text,
    toolName: delta.toolName ?? prior?.toolName ?? null
  })
  if (delta.kind === 'tool-input') {
    // The assembled `tool_call` append later replaces this partial with the
    // provider's own parsed input; until then the raw stream is the best body.
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
    const merged: AgentJournalToolCallItem = { ...base, input: text }
    session.items.set(delta.streamId, merged)
    return append(delta.streamId, merged, { observedAt: delta.observedAt })
  }
  return append(
    `stream:${delta.streamId}`,
    {
      kind: 'message',
      role: delta.kind === 'text' ? 'assistant' : 'reasoning',
      blocks: [{ type: 'text', text }]
    },
    { observedAt: delta.observedAt }
  )
}

function applyPromptResolution(
  session: ZcodeSession,
  resolution: NonNullable<ZcodeJournalTranslation['promptResolution']>,
  append: ZcodeJournalAppend
): boolean {
  const { promptKey, resolution: settled } = resolution
  // The server settled it — here or on another device — so the callback is
  // dead: a late host answer must find nothing left to claim.
  const pending = session.prompts.find(session.providerSessionId, promptKey)
  if (pending) {
    session.prompts.forget(pending)
  }
  const remembered = session.items.get(promptKey)
  if (remembered?.kind !== 'approval' && remembered?.kind !== 'question') {
    return true
  }
  const body = { ...remembered, resolution: settled }
  session.items.set(promptKey, body)
  return append(promptKey, body, { lifecycle: true })
}

function applyTurnBoundary(
  session: ZcodeSession,
  sessionId: string,
  boundary: NonNullable<ZcodeJournalTranslation['turnBoundary']>,
  wiring: ZcodeReflowWiring,
  append: ZcodeJournalAppend
): boolean {
  const userItemKey = boundary.userMessageId ?? boundary.inputId ?? null
  const identity =
    userItemKey === null ? null : zcodeItemIdentity(session.providerSessionId, userItemKey)
  let requestedAt: number | undefined
  if (identity !== null && boundary.state === 'running') {
    const pending = session.pendingSends.shift()
    if (pending) {
      requestedAt = pending.requestedAt
      wiring.onDispatchSettledLate?.({
        sessionId,
        clientMessageId: pending.clientMessageId,
        providerIdentity: identity
      })
    }
  }
  const rememberedTurn = session.items.get(`turn:${boundary.turnId}`)
  const turnBody = {
    // Merge onto the remembered turn row: completion carries no userItemId,
    // and the durable row must keep the identity the running row opened with.
    ...(rememberedTurn?.kind === 'turn'
      ? rememberedTurn
      : { kind: 'turn' as const, turnId: boundary.turnId, state: boundary.state }),
    state: boundary.state,
    ...(boundary.outcome === undefined ? {} : { outcome: boundary.outcome }),
    ...(identity === null ? {} : { userItemId: agentJournalItemKey(identity) }),
    ...(boundary.startedAt === undefined ? {} : { startedAt: boundary.startedAt }),
    ...(requestedAt === undefined ? {} : { requestedAt }),
    ...(boundary.completedAt === undefined ? {} : { completedAt: boundary.completedAt }),
    ...(boundary.durationMs === undefined ? {} : { durationMs: boundary.durationMs })
  }
  session.items.set(`turn:${boundary.turnId}`, turnBody)
  return append(`turn:${boundary.turnId}`, turnBody, { lifecycle: true })
}
