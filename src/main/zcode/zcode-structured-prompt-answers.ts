// Answering one zcode prompt: claim the live callback, commit the journal CAS
// while the claim is held, then reply on the wire with the chosen option's
// prefabricated response. A prompt cancel claims the same callback, so only one
// operation can commit — and an already-answered requestId never replies twice.

import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  AgentSessionPromptUnavailableError,
  type StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { ZcodePermissionOptionResponse } from './zcode-protocol'
import type { ZcodeSession } from './zcode-structured-session-state'

type AnswerInput = Parameters<StructuredAgentSessionAdapter['answerPrompt']>[0]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** journalItemId → provider requestId: host bindings first, then our own
 * `zcode-item:<session>:<requestId>` rows, then a raw requestId for direct
 * callers that never went through the journal. */
function resolveZcodeRequestId(session: ZcodeSession, itemId: string): string | null {
  const bound = session.promptItemIds.get(itemId)
  if (bound !== undefined) {
    return bound
  }
  const parsed = parseAgentJournalItemKey(itemId)
  if (parsed?.provider === 'orca') {
    const prefix = `zcode-item:${session.providerSessionId}:`
    if (parsed.clientMessageId.startsWith(prefix)) {
      return parsed.clientMessageId.slice(prefix.length)
    }
    return null
  }
  // Not a journal key: a direct caller naming the provider requestId.
  return itemId
}

/** The reply the CLI accepts verbatim: the option's prefabricated response when
 * the prompt shipped one, else the allow/deny decision implied by its id. */
function zcodeOptionReply(
  options: readonly { optionId: string; response: unknown }[],
  optionId: string
): ZcodePermissionOptionResponse {
  const option = options.find((entry) => entry.optionId === optionId)
  if (!option) {
    throw new Error(`${optionId} is not a zcode prompt option`)
  }
  const response = option.response
  if (isRecord(response)) {
    const decision = response.decision
    if (
      decision === 'allow' ||
      decision === 'deny' ||
      decision === 'escalate' ||
      decision === 'modify'
    ) {
      return { ...response, decision }
    }
  }
  return { decision: optionId.startsWith('allow') ? 'allow' : 'deny' }
}

export async function answerZcodeStructuredPrompt(input: {
  request: AnswerInput
  session: ZcodeSession
  sessions: Map<string, ZcodeSession>
}): Promise<void> {
  const { request, session, sessions } = input
  const requestId = resolveZcodeRequestId(session, request.itemId)
  if (requestId === null) {
    throw new AgentSessionPromptUnavailableError(request.itemId)
  }
  if (session.answeredRequests.has(requestId)) {
    // Already replied on the wire (or the server resolved it elsewhere); a
    // stale UI answer must succeed without sending a second reply.
    return
  }
  const kind = request.kind === 'question' ? 'user-input' : 'permission'
  const claim = session.prompts.claim(session.providerSessionId, requestId, kind)
  if (!claim) {
    throw new AgentSessionPromptUnavailableError(request.itemId)
  }
  try {
    const reply = zcodeOptionReply(claim.prompt.options, request.optionId)
    await request.commit()
    if (
      sessions.get(request.sessionId) !== session ||
      session.ended ||
      session.fence !== request.fence ||
      !session.prompts.ownsClaim(claim)
    ) {
      throw new AgentSessionPromptUnavailableError(request.itemId)
    }
    // Forget first and record the answer: a re-sent frame or a second answer
    // must find nothing left to reply to, not a second pending ask.
    session.prompts.forget(claim.prompt)
    session.answeredRequests.add(requestId)
    session.connection.respond(claim.prompt.frameId, reply)
  } catch (error) {
    session.prompts.releaseClaim(claim)
    throw error
  }
}
