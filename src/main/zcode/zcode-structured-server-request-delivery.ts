// Server-initiated zcode requests → replies and prompts. Every request the
// CLI waits on must be answered here (an unanswered request blocks its owning
// flow), and the two interaction prompts additionally become journal rows the
// host can answer across devices. Split from the notification reflow module to
// stay under the max-lines lint.

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  ZCODE_ERROR_CODES,
  ZCODE_INTERACTION_METHODS,
  type ZcodeProtocolServerRequest
} from './zcode-protocol'
import { readZcodeParamString } from './zcode-prompt-registry-bounds'
import {
  disposeZcodeServerRequest,
  zcodeRuntimePreferencesResponse
} from './zcode-server-request-disposition'
import { zcodeApprovalItem } from './zcode-structured-journal-prompt-items'
import { appendZcodeJournalRow, type ZcodeReflowWiring } from './zcode-structured-session-reflow'
import { zcodeItemIdentity, type ZcodeSession } from './zcode-structured-session-state'

export function deliverZcodeServerRequest(input: {
  session: ZcodeSession | undefined
  sessionId: string
  request: ZcodeProtocolServerRequest
  wiring: ZcodeReflowWiring
}): void {
  const { session, sessionId, request, wiring } = input
  if (!session) {
    return
  }
  const disposition = disposeZcodeServerRequest(request)
  if (disposition.kind === 'runtime-preferences') {
    // Mandatory: unanswered for 15s the CLI fails session/create with -32022.
    session.connection.respond(request.id, zcodeRuntimePreferencesResponse())
    return
  }
  if (disposition.kind === 'auto-deny') {
    session.connection.respondWithError(
      request.id,
      ZCODE_ERROR_CODES.methodNotFound,
      disposition.reason
    )
    return
  }
  const requestId = readZcodeParamString(request.params, 'requestId')
  if (requestId === null) {
    session.connection.respondWithError(
      request.id,
      ZCODE_ERROR_CODES.invalidParams,
      `Orca could not read a requestId on ${request.method}`
    )
    return
  }
  const providerSessionId =
    readZcodeParamString(request.params, 'sessionId') ?? session.providerSessionId
  const wasPending = session.prompts.find(providerSessionId, requestId) !== null
  const prompt = session.prompts.register({
    id: request.id,
    method: request.method,
    params: request.params
  })
  if (prompt === null) {
    // register refuses malformed prompts (no options, method mismatch on a live
    // requestId) and over-capacity ones without distinguishing them; both leave
    // an ask nothing can answer, so both surface as invalid params.
    session.connection.respondWithError(
      request.id,
      ZCODE_ERROR_CODES.invalidParams,
      `Orca could not register ${request.method} prompt ${requestId}`
    )
    return
  }
  const remembered = session.items.get(requestId)
  const alreadyResolved =
    (remembered?.kind === 'approval' || remembered?.kind === 'question') &&
    remembered.resolution.state !== 'pending'
  if (session.answeredRequests.has(requestId) || wasPending || alreadyResolved) {
    // A re-sent frame refreshes the wire id above; it must never surface a
    // second prompt, journal a second row, or allow a second reply.
    return
  }
  const emitPrompt = (): void =>
    wiring.emit({
      type: 'prompt',
      sessionId,
      providerSessionId: session.providerSessionId,
      requestId,
      method: request.method,
      params: request.params
    })
  if (request.method !== ZCODE_INTERACTION_METHODS.requestPermission) {
    // User-input asks have no spike-verified journal body yet (Task 10 FU);
    // surface the ask so the host can decide, journal nothing.
    emitPrompt()
    return
  }
  const body = zcodeApprovalItem(request.params)
  const identity = zcodeItemIdentity(session.providerSessionId, requestId)
  const admission = appendZcodeJournalRow(session, identity, body, { lifecycle: true })
  if (!admission.accepted) {
    session.prompts.forget(prompt)
    session.connection.respondWithError(
      request.id,
      ZCODE_ERROR_CODES.internal,
      `Orca could not durably record ${request.method} prompt ${requestId} (${admission.reason})`
    )
    return
  }
  session.items.set(requestId, body)
  session.promptItemIds.set(agentJournalItemKey(identity), requestId)
  // Codex parity: a permission wait can be the only live activity, so the row
  // must publish now rather than wait for the next notification's publish.
  session.sink?.publish({ lifecycle: true })
  emitPrompt()
}
