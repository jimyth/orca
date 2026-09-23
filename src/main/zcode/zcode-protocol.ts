// Hand-written minimal subset of the ZCode app-server wire protocol (legacy
// surface). Source of truth: ZCode repo packages/shared/src/zcode-protocol/index.ts
// (Zod schemas) — extracted 2026-09-22 and cross-checked against the Task 2 spike
// transcript (./fixtures/spike-session-transcript.ndjson). The protocol has NO
// stability promise, so this file must tolerate unknown methods/fields and never
// throw on them.

export type ZcodeProtocolRequestId = number | string

export type ZcodeProtocolResponse = {
  kind: 'response'
  id: ZcodeProtocolRequestId
  result: unknown
}

export type ZcodeProtocolError = {
  kind: 'error'
  id: ZcodeProtocolRequestId
  error: { code: number; message: string; data?: unknown }
}

// Server-initiated requests carry string ids ("server-1" in the spike); our own
// request ids are numbers.
export type ZcodeProtocolServerRequest = {
  kind: 'server-request'
  id: ZcodeProtocolRequestId
  method: string
  params?: unknown
}

export type ZcodeProtocolNotification = {
  kind: 'notification'
  method: string
  params?: unknown
}

export type ZcodeProtocolFrame =
  | ZcodeProtocolResponse
  | ZcodeProtocolError
  | ZcodeProtocolServerRequest
  | ZcodeProtocolNotification

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const isRequestId = (value: unknown): value is ZcodeProtocolRequestId =>
  typeof value === 'number' || typeof value === 'string'

export function parseZcodeProtocolFrame(line: string): ZcodeProtocolFrame | null {
  const stripped = line.endsWith('\r') ? line.slice(0, -1) : line
  if (stripped.trim().length === 0) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripped)
  } catch {
    return null
  }
  if (!isJsonObject(parsed)) {
    return null
  }
  // Discrimination order mirrors ZCode's own client: result/error keys win over method.
  if (isRequestId(parsed.id)) {
    if ('result' in parsed) {
      return { kind: 'response', id: parsed.id, result: parsed.result }
    }
    if (isJsonObject(parsed.error)) {
      if (typeof parsed.error.code === 'number' && typeof parsed.error.message === 'string') {
        return {
          kind: 'error',
          id: parsed.id,
          error: { code: parsed.error.code, message: parsed.error.message, data: parsed.error.data }
        }
      }
    }
    if (typeof parsed.method === 'string') {
      return { kind: 'server-request', id: parsed.id, method: parsed.method, params: parsed.params }
    }
  }
  if (typeof parsed.method === 'string') {
    return { kind: 'notification', method: parsed.method, params: parsed.params }
  }
  return null
}

export const ZCODE_PROTOCOL_METHODS = {
  sessionCreate: 'session/create',
  sessionResume: 'session/resume',
  sessionSend: 'session/send',
  sessionSubscribe: 'session/subscribe',
  sessionStop: 'session/stop',
  sessionCompact: 'session/compact',
  sessionEvents: 'session/events',
  runtimeCapabilities: 'runtime/capabilities'
} as const

export const ZCODE_NOTIFICATION_METHODS = {
  storageState: 'startup/storageState',
  sessionEvent: 'session/event'
} as const

// Requests the server waits on — a missing reply fails the owning flow: an
// unanswered session/requestRuntimePreferences times out after 15s with -32022
// and aborts session/create.
export const ZCODE_SERVER_REQUEST_METHODS = {
  requestRuntimePreferences: 'session/requestRuntimePreferences'
} as const

export const ZCODE_INTERACTION_METHODS = {
  requestPermission: 'interaction/requestPermission',
  requestUserInput: 'interaction/requestUserInput'
} as const

export const ZCODE_ERROR_CODES = {
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  sessionUnavailable: -32004
} as const

export function isZcodeAppServerMethodNotFoundError(error: unknown): boolean {
  return isJsonObject(error) && error.code === ZCODE_ERROR_CODES.methodNotFound
}

export type ZcodeStoragePhase =
  | 'checking'
  | 'waiting_for_lock'
  | 'migrating'
  | 'committing'
  | 'ready'
  | 'failed'

export type ZcodeStorageStateParams = {
  phase: ZcodeStoragePhase
  errorCode?: string
  sequence?: number
  attemptId?: string
}

// Full 26-member set from the protocol source; members marked `spike-observed`
// appeared in the Task 2 transcript. Unknown types still parse — callers treat
// them as opaque events.
export type ZcodeSessionEventType =
  | 'session.created'
  | 'session.resumed'
  | 'session.updated' // spike-observed
  | 'session.titleUpdated' // spike-observed
  | 'session.closed'
  | 'turn.started' // spike-observed
  | 'turn.steerQueued'
  | 'turn.steerDrained'
  | 'turn.completed' // spike-observed
  | 'turn.failed'
  | 'message.upserted'
  | 'message.removed'
  | 'part.started'
  | 'part.delta'
  | 'part.upserted'
  | 'part.removed'
  | 'model.streaming' // spike-observed
  | 'tool.updated' // spike-observed
  | 'permission.requested' // spike-observed
  | 'permission.resolved' // spike-observed
  | 'userInput.requested'
  | 'userInput.resolved'
  | 'checkpoint.created' // spike-observed
  | 'rewind.triggered'
  | 'streamRecovery.updated' // spike-observed

export type ZcodeSessionEventEnvelope = {
  eventId: string
  sessionId: string
  turnId?: string
  seq: number
  timestamp: number
  type: ZcodeSessionEventType
  payload?: unknown
}

// model.streaming payload — six kinds observed in the spike. The tool_* kinds
// carry toolCallId (tool_input_start/tool_call add toolName); tool_call carries
// the assembled input.
export type ZcodeModelStreamingPayload = {
  assistantMessageId: string
  kind:
    | 'reasoning_delta'
    | 'text_delta'
    | 'tool_input_start'
    | 'tool_input_delta'
    | 'tool_input_end'
    | 'tool_call'
  delta?: string
  done?: boolean
  toolCallId?: string
  toolName?: string
  input?: unknown
}

export type ZcodePermissionResponse = {
  decision: 'allow' | 'deny' | 'escalate' | 'modify'
  reason?: string
}

export type ZcodePermissionOptionResponse = ZcodePermissionResponse & {
  permissionUpdates?: unknown
}

// Spike shape: exactly three options — allow_once / allow_project / deny (note
// allow_project's kind is 'allow_always') — and each ships a prefabricated
// `response`; the client decision is option.response sent back verbatim.
export type ZcodePermissionOption = {
  optionId: string
  kind: string
  name: string
  description?: string
  response?: ZcodePermissionOptionResponse
}

export type ZcodePermissionRequestParams = {
  requestId: string
  sessionId: string
  turnId?: string
  toolCallId: string
  toolName: string
  reason: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  input?: unknown
  options: ZcodePermissionOption[]
}

export type ZcodeUserInputResponse = {
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
  reason?: string
}

export type ZcodeSessionCreateParams = {
  sessionId?: string
  workspace: { workspacePath: string; workspaceKey: string; workspaceIdentity?: string }
  mode?: 'plan' | 'build' | 'edit' | 'yolo' | 'auto'
  toolDenylist?: string[]
}

// session/send requires all three modelSelection fields — omitting any one
// fails with invalid params (spike-verified).
export type ZcodeSessionSendParams = {
  sessionId: string
  content: string
  modelSelection: {
    providerId: string
    modelId: string
    options: { reasoningLevel: string }
  }
}

export type ZcodeSessionSendResult = {
  sessionId: string
  accepted: true
  stateRevision: number
}

// inputId/instructions/expectedRevision stay optional on purpose: the host
// never correlates a pending prompt input or tracks the CAS revision, and the
// server accepts the bare session id.
export type ZcodeSessionCompactParams = {
  sessionId: string
  inputId?: string
  instructions?: string
  expectedRevision?: number
}

// The result is an ACK, not a completion receipt: `compact.state` says whether
// the server started a compaction ('accepted') or already had one running
// ('already_running'), and the converged timeline arrives afterwards through
// session/event pushes. `snapshot` is deliberately unmodeled — the host's
// journal reflows those events instead of syncing the snapshot.
export type ZcodeSessionCompactResult = {
  response: string
  compact?: {
    state: 'accepted' | 'already_running'
    inputId?: string
    operationId?: string
  }
}

// The create result's projection.sessionId is an "unknown" placeholder; the
// real id lives at session.sessionId.
export function zcodeSessionIdFromCreateResult(result: unknown): string | null {
  if (!isJsonObject(result) || !isJsonObject(result.session)) {
    return null
  }
  const sessionId = result.session.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId === 'unknown') {
    return null
  }
  return sessionId
}
