// Session-scoped state for the zcode structured adapter: the deps surface the
// adapter accepts, the per-session record, and the acquisition registry that
// fences concurrent acquires of one session. Mirrors the codex session-state
// module; the translator's internal state (item merge rows, stream snapshots,
// prompt bindings) lives here on the session because the zcode translation is
// a pure function.

import { randomUUID } from 'node:crypto'
import { cancelProcessAcquisition } from '../../shared/child-process/cancel-process-acquisition'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type {
  ZcodeAppServerConnection,
  openZcodeAppServerConnection
} from './zcode-app-server-connection'
import { ZcodeAcquisitionWindow } from './zcode-structured-acquisition-window'
import type { ZcodeStructuredLaunch } from './zcode-structured-launch-resolution'
import type { ZcodeStructuredPermissionMode } from './zcode-structured-permission-policy'
import type { ZcodeSessionSendParams, ZcodeSessionEventEnvelope } from './zcode-protocol'

export type ZcodeStructuredSessionEvent =
  | {
      type: 'session-event'
      sessionId: string
      providerSessionId: string
      envelope: ZcodeSessionEventEnvelope
    }
  | {
      type: 'prompt'
      sessionId: string
      providerSessionId: string
      requestId: string
      method: string
      params: unknown
    }
  | StructuredAgentSessionLifecycleEvent
  /** Translator-only compatibility for callers that do not participate in host recovery. */
  | { type: 'ended'; sessionId: string; reason: string; observedAt?: number }

export type ZcodeStructuredSessionAdapterDeps = {
  resolveLaunch: (input: {
    identity: AgentSessionJournalIdentity
  }) => Promise<ZcodeStructuredLaunch>
  /** Task 8 policy: 'yolo' names session/create's mode, 'default' omits it so
   *  the user's own ~/.zcode permission.mode resolves. */
  resolvePermissionMode?: (input: {
    identity: AgentSessionJournalIdentity
  }) => Promise<ZcodeStructuredPermissionMode> | ZcodeStructuredPermissionMode
  /** Overrides model selection for session/send; production prefers the
   *  create-result echo and falls back to the shipped config default. */
  resolveModelSelection?: (input: {
    sessionId: string
  }) => Promise<ZcodeSessionSendParams['modelSelection']> | ZcodeSessionSendParams['modelSelection']
  onEvent?: (event: ZcodeStructuredSessionEvent) => void
  /** Identity for a send admitted earlier, once turn.started names the user input. */
  onDispatchSettledLate?: (input: {
    sessionId: string
    clientMessageId: string
    providerIdentity: AgentJournalItemIdentity
  }) => void
  openConnection?: typeof openZcodeAppServerConnection
  readProcessStartTime?: (pid: number) => Promise<number | null>
  mintLinkId?: () => string
  mintAcquisitionGeneration?: () => string
  now?: () => number
  requestTimeoutMs?: number
}

/** One accumulated stream keyed by the translation's streamId. */
export type ZcodeStreamSnapshot = {
  kind: 'text' | 'reasoning' | 'tool-input'
  text: string
  toolName: string | null
}

export type ZcodeSession = {
  connection: ZcodeAppServerConnection
  ended: boolean
  requestedClose: boolean
  fence: number
  acquisitionGeneration: string
  providerSessionId: string
  /** Model selection the create result echoed, when it carried one. */
  modelSelection: ZcodeSessionSendParams['modelSelection'] | null
  /** Registry carried over from the acquisition window once the session publishes. */
  prompts: ZcodeAcquisitionWindow['prompts']
  /** requestIds already answered on the wire; a re-sent frame must not re-prompt. */
  answeredRequests: Set<string>
  /** journalItemId → requestId, learned from our own rows and host bindings. */
  promptItemIds: Map<string, string>
  /** itemKey → last appended body; tool-call updates merge onto it, prompt resolutions settle it. */
  items: Map<string, AgentJournalItemBody>
  streams: Map<string, ZcodeStreamSnapshot>
  /** Sends awaiting the turn.started echo that will name their provider identity. */
  pendingSends: { clientMessageId: string; requestedAt?: number }[]
  sink: StructuredAgentSessionEventSink | null
  unbindReadingControl?: () => void
  /** Terminates this exact child as an unexpected death and enters host recovery. */
  forceCloseUnexpected: (reason: Error) => Promise<boolean>
}

/** Journal identity for one zcode provider item. AgentJournalItemIdentity has
 *  no zcode variant yet (the wire schemas widen in a later task), so provider
 *  item keys ride the `orca` namespace the way codex's non-message items do. */
export function zcodeItemIdentity(
  providerSessionId: string,
  itemKey: string
): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `zcode-item:${providerSessionId}:${itemKey}` }
}

export function requireLiveZcodeSession(
  sessions: Map<string, ZcodeSession>,
  sessionId: string
): ZcodeSession {
  const session = sessions.get(sessionId)
  if (!session || session.ended) {
    throw new Error(`no live zcode app-server for session ${sessionId}`)
  }
  return session
}

export function mintZcodeAcquisitionGeneration(deps: ZcodeStructuredSessionAdapterDeps): string {
  return deps.mintAcquisitionGeneration?.() ?? randomUUID()
}

export type ZcodeAcquisitionAttempt = {
  window: ZcodeAcquisitionWindow
  cancelled: boolean
  exitProven: boolean
  finished: Promise<void>
  finish: () => void
}

export function createZcodeAcquisitionAttempt(): ZcodeAcquisitionAttempt {
  let finish = (): void => {}
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  return {
    window: new ZcodeAcquisitionWindow(),
    cancelled: false,
    exitProven: false,
    finished,
    finish
  }
}

export class ZcodeAcquisitionRegistry {
  private readonly attempts = new Map<string, ZcodeAcquisitionAttempt>()
  private closing = false

  get size(): number {
    return this.attempts.size
  }

  start(sessionId: string): {
    previousAttempt: ZcodeAcquisitionAttempt | undefined
    attempt: ZcodeAcquisitionAttempt
  } {
    if (this.closing) {
      throw new Error('zcode structured session adapter is closing')
    }
    const previousAttempt = this.attempts.get(sessionId)
    const attempt = createZcodeAcquisitionAttempt()
    this.attempts.set(sessionId, attempt)
    return { previousAttempt, attempt }
  }

  assertCurrent(sessionId: string, attempt: ZcodeAcquisitionAttempt): void {
    if (this.closing || attempt.cancelled || this.attempts.get(sessionId) !== attempt) {
      throw new Error(`zcode session ${sessionId} was superseded while being acquired`)
    }
  }

  get(sessionId: string): ZcodeAcquisitionAttempt | undefined {
    return this.attempts.get(sessionId)
  }

  deleteIfCurrent(sessionId: string, attempt: ZcodeAcquisitionAttempt): void {
    if (this.attempts.get(sessionId) === attempt) {
      this.attempts.delete(sessionId)
    }
  }

  restoreIfCurrent(
    sessionId: string,
    replacement: ZcodeAcquisitionAttempt,
    previous: ZcodeAcquisitionAttempt
  ): void {
    if (this.attempts.get(sessionId) === replacement) {
      this.attempts.set(sessionId, previous)
    }
  }

  async closeFailedAttempt(sessionId: string, attempt: ZcodeAcquisitionAttempt): Promise<boolean> {
    const stopped = (await attempt.window.connection?.close()) ?? true
    if (stopped) {
      attempt.exitProven = true
      this.deleteIfCurrent(sessionId, attempt)
    }
    return stopped
  }

  sessionIds(): IterableIterator<string> {
    return this.attempts.keys()
  }

  close(): void {
    this.closing = true
  }
}

export async function cancelZcodeAcquisitionAttempt(
  attempt: ZcodeAcquisitionAttempt | undefined
): Promise<boolean> {
  if (!attempt) {
    return true
  }
  return cancelProcessAcquisition({
    cancel: () => {
      attempt.cancelled = true
    },
    connection: () => attempt.window.connection,
    exitProven: () => attempt.exitProven,
    finished: attempt.finished
  })
}
