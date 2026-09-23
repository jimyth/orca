// zcode session/compact adapter arm. Unlike codex's async thread/compact/start
// + terminal-event wait, the zcode RPC result is itself the verdict, so this
// stays a single request with no completion state machine.

import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { isZcodeAppServerRequestError } from './zcode-app-server-connection'
import { ZCODE_PROTOCOL_METHODS } from './zcode-protocol'
import { requireLiveZcodeSession, type ZcodeSession } from './zcode-structured-session-state'

/** The ACK alone can sit in a minutes-long model-maintenance window; matches
 * ZCode's own client deadline for session/compact instead of the 3-min default. */
const ZCODE_COMPACT_ACK_TIMEOUT_MS = 300_000

/** Any settled answer — 'accepted', 'already_running', or the legacy
 * no-`compact` shape — means the server owns the compaction; the converged
 * timeline flows back through the ordinary session/event reflow, so there is
 * never a late result to report. A request refusal is a reported error; an
 * unsettled call rethrows for the host to record as unconfirmed. */
export async function compactZcodeStructuredSession(
  sessions: Map<string, ZcodeSession>,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['compact']>>[0]
): Promise<{ error?: string }> {
  const session = requireLiveZcodeSession(sessions, input.sessionId)
  try {
    await session.connection.request(
      ZCODE_PROTOCOL_METHODS.sessionCompact,
      { sessionId: session.providerSessionId },
      { timeoutMs: ZCODE_COMPACT_ACK_TIMEOUT_MS }
    )
    return {}
  } catch (error) {
    if (isZcodeAppServerRequestError(error)) {
      return { error: error.message }
    }
    throw error
  }
}
