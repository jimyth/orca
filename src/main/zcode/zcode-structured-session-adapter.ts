// Orchestration core for zcode structured sessions: acquire spawns the child
// and opens the provider session, dispatch/cancelTurn/answerPrompt are the
// host's turn surface, and every provider frame flows back through the pure
// Task 10 translator into journal rows and host events. Mirrors the codex
// adapter's skeleton; the differences are deliberate and listed in the task
// report (no rewind/compaction/background tasks/fast mode, translator is pure).

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { closeProcessRegistry } from '../../shared/child-process/close-process-registry'
import {
  AgentSessionPromptUnavailableError,
  type AgentSessionAcquisition,
  type AgentSessionDispatchOutcome,
  type StructuredAgentSessionAcquireInput,
  type StructuredAgentSessionAdapter,
  type StructuredAgentSessionSetOptionInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ZcodeAppServerConnection } from './zcode-app-server-connection'
import { isZcodeAppServerRequestError } from './zcode-app-server-connection'
import {
  acquireZcodeStructuredSession,
  defaultZcodeModelSelection
} from './zcode-structured-session-acquire'
import { answerZcodeStructuredPrompt } from './zcode-structured-prompt-answers'
import { deliverZcodeNotification, type ZcodeReflowWiring } from './zcode-structured-session-reflow'
import { deliverZcodeServerRequest } from './zcode-structured-server-request-delivery'
import {
  ZcodeAcquisitionRegistry,
  cancelZcodeAcquisitionAttempt,
  requireLiveZcodeSession,
  type ZcodeAcquisitionAttempt,
  type ZcodeSession,
  type ZcodeStructuredSessionAdapterDeps
} from './zcode-structured-session-state'

export type { ZcodeStructuredLaunch } from './zcode-structured-launch-resolution'
export type {
  ZcodeStructuredSessionAdapterDeps,
  ZcodeStructuredSessionEvent
} from './zcode-structured-session-state'

/** session/send carries one string; the journal's text blocks join with a newline. */
function zcodeMessageText(body: AgentJournalMessageItem): string {
  const parts: string[] = []
  for (const block of body.blocks) {
    if (block.type === 'text' && block.text.length > 0) {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

export class ZcodeStructuredSessionAdapter implements StructuredAgentSessionAdapter {
  private readonly sessions = new Map<string, ZcodeSession>()
  private readonly acquisitions = new ZcodeAcquisitionRegistry()

  constructor(private readonly deps: ZcodeStructuredSessionAdapterDeps) {}

  acquire = (input: StructuredAgentSessionAcquireInput): Promise<AgentSessionAcquisition> =>
    acquireZcodeStructuredSession({
      input,
      deps: this.deps,
      sessions: this.sessions,
      acquisitions: this.acquisitions,
      deliver: (window, sessionId, event, retainedBytes) =>
        this.deliver(window, sessionId, event, retainedBytes),
      handleNotification: (sessionId, method, params) =>
        deliverZcodeNotification({
          session: this.sessions.get(sessionId),
          sessionId,
          method,
          params,
          wiring: this.wiring(sessionId)
        }),
      handleServerRequest: (sessionId, request) =>
        deliverZcodeServerRequest({
          session: this.sessions.get(sessionId),
          sessionId,
          request,
          wiring: this.wiring(sessionId)
        }),
      handleExit: (sessionId, connection, error) => this.handleExit(sessionId, connection, error),
      closePublished: (sessionId) => this.closePublished(sessionId),
      forceCloseUnexpected: (sessionId, fence, acquisitionGeneration, reason) =>
        this.closePublished(sessionId, {
          requestedClose: false,
          expectedFence: fence,
          expectedGeneration: acquisitionGeneration,
          unexpectedReason: reason
        })
    })

  /** Buffers pre-publication frames and drops frames from superseded children. */
  private deliver(
    acquisition: ZcodeAcquisitionAttempt['window'],
    sessionId: string,
    event: () => void,
    retainedBytes?: number
  ): void {
    if (acquisition.buffer(event, retainedBytes)) {
      return
    }
    if (this.sessions.get(sessionId)?.connection === acquisition.connection) {
      event()
    } else if (acquisition.isOverflowed) {
      // Pre-publication overflow is an acquisition failure, not a dropped
      // notification; tear down the child so callers retry explicitly.
      void acquisition.connection?.close()
    }
  }

  private wiring(sessionId: string): ZcodeReflowWiring {
    return {
      emit: (event) => this.deps.onEvent?.(event),
      forceCloseUnexpected: (reason) => {
        const session = this.sessions.get(sessionId)
        if (session) {
          void session.forceCloseUnexpected(reason)
        }
      },
      ...(this.deps.onDispatchSettledLate
        ? { onDispatchSettledLate: this.deps.onDispatchSettledLate }
        : {}),
      ...(this.deps.now ? { now: this.deps.now } : {})
    }
  }

  /** First observed child exit ends the session exactly once. */
  private handleExit(
    sessionId: string,
    connection: ZcodeAppServerConnection | null,
    error: Error
  ): boolean {
    const session = this.sessions.get(sessionId)
    if (!session || session.connection !== connection || session.ended) {
      return false
    }
    session.ended = true
    session.unbindReadingControl?.()
    this.deps.onEvent?.({
      type: 'ended',
      sessionId,
      reason: error.message,
      cause: session.requestedClose ? 'requested-close' : 'unexpected-exit',
      fence: session.fence,
      acquisitionGeneration: session.acquisitionGeneration,
      observedAt: this.deps.now?.() ?? Date.now()
    })
    session.prompts.clear()
    return true
  }

  async dispatch(input: {
    sessionId: string
    clientMessageId: string
    body: AgentJournalMessageItem
    fence: number
    requestedAt?: number
    beforeDispatch?: () => Promise<void>
  }): Promise<AgentSessionDispatchOutcome> {
    const session = requireLiveZcodeSession(this.sessions, input.sessionId)
    const modelSelection = this.deps.resolveModelSelection
      ? await this.deps.resolveModelSelection({ sessionId: input.sessionId })
      : (session.modelSelection ?? defaultZcodeModelSelection())
    await input.beforeDispatch?.()
    // Armed before the write: turn.started can land while the response is in
    // flight, and only the echo names which send opened the turn.
    session.pendingSends.push({
      clientMessageId: input.clientMessageId,
      ...(input.requestedAt === undefined ? {} : { requestedAt: input.requestedAt })
    })
    try {
      await session.connection.request(
        'session/send',
        {
          sessionId: session.providerSessionId,
          content: zcodeMessageText(input.body),
          modelSelection
        },
        { timeoutMs: this.deps.requestTimeoutMs }
      )
    } catch (error) {
      // The server declined this send outright; no echo will settle it.
      session.pendingSends = session.pendingSends.filter(
        (pending) => pending.clientMessageId !== input.clientMessageId
      )
      if (isZcodeAppServerRequestError(error)) {
        return { state: 'rejected', reason: error.message }
      }
      // A timeout or transport failure can happen after the frame was written;
      // keep the send armed so a later echo can prove delivery.
      throw error
    }
    return { state: 'admitted' }
  }

  cancelTurn: StructuredAgentSessionAdapter['cancelTurn'] = async (request) => {
    const session = requireLiveZcodeSession(this.sessions, request.sessionId)
    try {
      await session.connection.request(
        'session/stop',
        { sessionId: session.providerSessionId },
        { timeoutMs: this.deps.requestTimeoutMs }
      )
      return { cancelled: true }
    } catch (error) {
      if (isZcodeAppServerRequestError(error)) {
        return { cancelled: false }
      }
      throw error
    }
  }

  answerPrompt: StructuredAgentSessionAdapter['answerPrompt'] = async (request) => {
    const session = this.sessions.get(request.sessionId)
    if (!session || session.ended || session.fence !== request.fence) {
      throw new AgentSessionPromptUnavailableError(request.itemId)
    }
    await answerZcodeStructuredPrompt({ request, session, sessions: this.sessions })
  }

  /** The provider session id is embedded in every journal row the adapter
   * mints, but a host that journals its own prompt row binds it here instead. */
  bindPromptItemId = (sessionId: string, journalItemId: string, promptKey: string): void => {
    this.sessions.get(sessionId)?.promptItemIds.set(journalItemId, promptKey)
  }

  async setOption(
    input: StructuredAgentSessionSetOptionInput
  ): Promise<void | Readonly<Record<string, string>>> {
    // Model selection rides session/send and permission posture is owned by the
    // launch policy, so there is no live session option to set yet.
    throw new Error(`zcode app-server has no session option named ${input.key}`)
  }

  closeSession = (sessionId: string): Promise<boolean> => this.stop(sessionId)
  forceCloseSession = (sessionId: string): Promise<boolean> =>
    this.closePublished(sessionId, { requestedClose: false })
  disposeSession = (sessionId: string): Promise<boolean> => this.closePublished(sessionId)
  releaseAcquisition = (input: { sessionId: string }): Promise<boolean> =>
    this.stop(input.sessionId)

  closeAll = (): Promise<void> => {
    this.acquisitions.close()
    return closeProcessRegistry({
      attempts: 3,
      hasEntries: () => this.sessions.size > 0 || this.acquisitions.size > 0,
      entryIds: () => new Set([...this.sessions.keys(), ...this.acquisitions.sessionIds()]),
      closeEntry: (sessionId) => this.stop(sessionId),
      failureMessage: 'zcode structured session shutdown could not prove every child stopped'
    })
  }

  /** Cancels an acquisition still opening, then closes the published session. */
  private async stop(sessionId: string): Promise<boolean> {
    const attempt = this.acquisitions.get(sessionId)
    if (!(await cancelZcodeAcquisitionAttempt(attempt))) {
      return false
    }
    if (attempt) {
      this.acquisitions.deleteIfCurrent(sessionId, attempt)
    }
    return this.closePublished(sessionId)
  }

  private async closePublished(
    sessionId: string,
    options: {
      requestedClose?: boolean
      expectedFence?: number
      expectedGeneration?: string
      unexpectedReason?: Error
    } = {}
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return true
    }
    if (
      (options.expectedFence !== undefined && session.fence !== options.expectedFence) ||
      (options.expectedGeneration !== undefined &&
        session.acquisitionGeneration !== options.expectedGeneration)
    ) {
      return false
    }
    // Sink-failure recovery force-closes the child but must preserve the
    // observed-exit cause so host lease settlement runs as an unexpected death.
    session.requestedClose = options.requestedClose ?? true
    // Keep the session indexed until the child exit is proven; a timeout or
    // failed kill must leave the live connection available for a safe retry.
    const exited = await session.connection.close()
    if (exited !== true) {
      return false
    }
    if (!session.ended) {
      this.handleExit(
        sessionId,
        session.connection,
        options.unexpectedReason ?? new Error('zcode session closed')
      )
    }
    this.sessions.delete(sessionId)
    return true
  }
}
