// Making one zcode session real: launch resolver → stdio connection (the
// storage-readiness gate lives inside the connection) → session/create →
// session/subscribe → the acquisition the host lease proves. Mirrors the codex
// acquire path minus every codex-only concern (no rewind, no compaction, no
// fast-mode catalog, no thread resume).

import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionPreSpawnError,
  type AgentSessionAcquisition,
  type StructuredAgentSessionAcquireInput
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AgentSessionProcessIdentity } from '../../shared/agent-session-record'
import { readProcessStartTimeMs } from '../runtime/agent-session-process-identity-probe'
import { openZcodeAppServerConnection } from './zcode-app-server-connection'
import type { ZcodeProtocolServerRequest, ZcodeSessionSendParams } from './zcode-protocol'
import { zcodeSessionIdFromCreateResult } from './zcode-protocol'
import {
  cancelZcodeAcquisitionAttempt,
  mintZcodeAcquisitionGeneration,
  type ZcodeAcquisitionAttempt,
  type ZcodeAcquisitionRegistry,
  type ZcodeSession,
  type ZcodeStructuredSessionAdapterDeps
} from './zcode-structured-session-state'

const START_TIME_READ_ATTEMPTS = 3
const SESSION_SUBSCRIBE_DELIVERY_KIND = 'desktop-continuous'

/** Last-resort model selection matching the shipped zcode config default
 * (provider.builtin:bigmodel + model.main GLM-5.3, reasoning max); a real
 * session prefers the create-result echo or the injected resolver.
 *
 * UNVERIFIED SOURCE: the provider id `builtin:bigmodel` was read from this
 * machine's legacy ~/.zcode config, not confirmed against a clean install —
 * the local spike ran `bigmodel-spike`. The runtime's injectable
 * resolveModelSelection is the correction path; the real-binary tests must
 * empirically confirm (or replace) this constant before it can be trusted
 * cross-environment. */
export function defaultZcodeModelSelection(): ZcodeSessionSendParams['modelSelection'] {
  return {
    providerId: 'builtin:bigmodel',
    modelId: 'GLM-5.3',
    options: { reasoningLevel: 'max' }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function readString(source: unknown, key: string): string | null {
  const value = isRecord(source) ? source[key] : undefined
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The model selection session/create echoed (settings.model.current, or
 * session.model with the config default reasoning level), or null. */
export function readZcodeModelSelectionEcho(
  result: unknown
): ZcodeSessionSendParams['modelSelection'] | null {
  const settingsModel =
    isRecord(result) && isRecord(result.settings) ? result.settings.model : undefined
  const current = isRecord(settingsModel) ? settingsModel.current : undefined
  if (isRecord(current)) {
    const providerId = readString(current, 'providerId')
    const modelId = readString(current, 'modelId')
    const reasoningLevel = isRecord(current.options)
      ? readString(current.options, 'reasoningLevel')
      : null
    if (providerId !== null && modelId !== null) {
      return {
        providerId,
        modelId,
        options: { reasoningLevel: reasoningLevel ?? 'max' }
      }
    }
  }
  const sessionModel =
    isRecord(result) && isRecord(result.session) ? result.session.model : undefined
  if (isRecord(sessionModel)) {
    const providerId = readString(sessionModel, 'providerId')
    const modelId = readString(sessionModel, 'modelId')
    if (providerId !== null && modelId !== null) {
      return { providerId, modelId, options: { reasoningLevel: 'max' } }
    }
  }
  return null
}

export async function zcodeProcessIdentity(
  input: { hostId: string; spawnToken: string; pid: number | undefined },
  readStartTime: (pid: number) => Promise<number | null>
): Promise<AgentSessionProcessIdentity> {
  if (input.pid === undefined) {
    throw new Error('zcode app-server started without a pid')
  }
  let processStartTimeMs: number | null = null
  for (
    let attempt = 0;
    attempt < START_TIME_READ_ATTEMPTS && processStartTimeMs === null;
    attempt += 1
  ) {
    processStartTimeMs = await readStartTime(input.pid)
  }
  if (processStartTimeMs === null) {
    // Why: recording null makes every later owner probe indeterminate — a
    // durable latch. Failing here reaps the child and leaves a retryable
    // refusal instead.
    throw new Error(`zcode app-server start time for pid ${input.pid} could not be read`)
  }
  return {
    hostId: input.hostId,
    pid: input.pid,
    processStartTimeMs,
    spawnToken: input.spawnToken
  }
}

export async function acquireZcodeStructuredSession(input: {
  input: StructuredAgentSessionAcquireInput
  deps: ZcodeStructuredSessionAdapterDeps
  sessions: Map<string, ZcodeSession>
  acquisitions: ZcodeAcquisitionRegistry
  deliver: (
    window: ZcodeAcquisitionAttempt['window'],
    sessionId: string,
    event: () => void,
    retainedBytes?: number
  ) => void
  handleNotification: (sessionId: string, method: string, params: unknown) => void
  handleServerRequest: (sessionId: string, request: ZcodeProtocolServerRequest) => void
  handleExit: (
    sessionId: string,
    connection: ZcodeAcquisitionAttempt['window']['connection'],
    error: Error
  ) => boolean
  closePublished: (sessionId: string) => Promise<boolean>
  forceCloseUnexpected: (
    sessionId: string,
    fence: number,
    acquisitionGeneration: string,
    reason: Error
  ) => Promise<boolean>
}): Promise<AgentSessionAcquisition> {
  const { input: acquireInput, deps, sessions, acquisitions } = input
  const sessionId = acquireInput.identity.sessionId
  const { previousAttempt, attempt } = acquisitions.start(sessionId)
  const acquisition = attempt.window
  let unbindReadingControl: (() => void) | undefined
  const open = deps.openConnection ?? openZcodeAppServerConnection
  try {
    if (previousAttempt !== undefined) {
      if (!(await cancelZcodeAcquisitionAttempt(previousAttempt))) {
        acquisitions.restoreIfCurrent(sessionId, attempt, previousAttempt)
        throw new Error(`zcode acquisition for session ${sessionId} could not be stopped`)
      }
    }
    acquisitions.assertCurrent(sessionId, attempt)
    if (sessions.get(sessionId) !== undefined && !(await input.closePublished(sessionId))) {
      throw new Error(`zcode app-server for session ${sessionId} could not be stopped`)
    }
    acquisitions.assertCurrent(sessionId, attempt)
    const launch = await deps
      .resolveLaunch({ identity: acquireInput.identity })
      .catch((error: unknown) => {
        throw new AgentSessionPreSpawnError(error)
      })
    acquisitions.assertCurrent(sessionId, attempt)
    const permissionMode = await deps.resolvePermissionMode?.({ identity: acquireInput.identity })
    const connection = await open(
      {
        command: launch.command,
        args: launch.args,
        cwd: launch.cwd,
        ...(launch.env !== undefined ? { env: launch.env } : {})
      },
      {
        onNotification: (method, params) =>
          input.deliver(
            acquisition,
            sessionId,
            () => input.handleNotification(sessionId, method, params),
            Buffer.byteLength(JSON.stringify(params ?? null), 'utf8')
          ),
        onServerRequest: (request) =>
          input.deliver(
            acquisition,
            sessionId,
            () => input.handleServerRequest(sessionId, request),
            Buffer.byteLength(JSON.stringify(request), 'utf8')
          ),
        onExit: (error) => {
          if (!input.handleExit(sessionId, acquisition.connection, error)) {
            acquisition.prompts.clear()
          }
        }
      }
    )
    acquisition.connection = connection
    if (acquireInput.events?.bindReadingControl && connection.pauseReading) {
      unbindReadingControl = acquireInput.events.bindReadingControl({
        pauseReading: connection.pauseReading,
        resumeReading: connection.resumeReading
      })
    }
    acquisitions.assertCurrent(sessionId, attempt)
    const createResult = await connection.request(
      'session/create',
      {
        workspace: {
          workspacePath: launch.cwd,
          workspaceKey: acquireInput.identity.workspaceId
        },
        ...(permissionMode === 'yolo' ? { mode: 'yolo' } : {})
      },
      { timeoutMs: deps.requestTimeoutMs }
    )
    acquisitions.assertCurrent(sessionId, attempt)
    const providerSessionId = zcodeSessionIdFromCreateResult(createResult)
    if (providerSessionId === null) {
      throw new Error(`zcode app-server session/create did not name a session for ${sessionId}`)
    }
    await connection.request(
      'session/subscribe',
      {
        sessionId: providerSessionId,
        deliveryKind: SESSION_SUBSCRIBE_DELIVERY_KIND
      },
      { timeoutMs: deps.requestTimeoutMs }
    )
    acquisitions.assertCurrent(sessionId, attempt)
    const process = await zcodeProcessIdentity(
      {
        hostId: acquireInput.identity.hostId,
        spawnToken: acquireInput.spawnToken,
        pid: connection.pid
      },
      deps.readProcessStartTime ?? readProcessStartTimeMs
    )
    acquisitions.assertCurrent(sessionId, attempt)
    if (connection.closed) {
      throw new Error(`zcode app-server for session ${sessionId} exited while being acquired`)
    }
    acquisitions.deleteIfCurrent(sessionId, attempt)
    const acquisitionGeneration = mintZcodeAcquisitionGeneration(deps)
    const session: ZcodeSession = {
      connection,
      ended: false,
      requestedClose: false,
      fence: acquireInput.fence,
      acquisitionGeneration,
      providerSessionId,
      modelSelection: readZcodeModelSelectionEcho(createResult),
      prompts: acquisition.prompts,
      answeredRequests: new Set(),
      promptItemIds: new Map(),
      items: new Map(),
      streams: new Map(),
      pendingSends: [],
      sink: acquireInput.events ?? null,
      ...(unbindReadingControl !== undefined ? { unbindReadingControl } : {}),
      forceCloseUnexpected: (reason) =>
        input.forceCloseUnexpected(sessionId, acquireInput.fence, acquisitionGeneration, reason)
    }
    sessions.set(sessionId, session)
    for (const event of acquisition.drain()) {
      event()
    }
    return {
      process,
      link: {
        linkId:
          deps.mintLinkId?.() ?? `zcode-${acquireInput.fence}-${providerSessionId}`.slice(0, 128),
        handle: { provider: 'zcode', sessionId: providerSessionId },
        origin: 'created',
        mintedAtFence: acquireInput.fence,
        observedAt: deps.now?.() ?? Date.now()
      },
      acquisitionGeneration
    }
  } catch (error) {
    if (sessions.get(sessionId)?.connection !== acquisition.connection) {
      // The failed child was never published: reap it and classify an
      // unprovable exit instead of leaking a writer on the session.
      unbindReadingControl?.()
      if (!(await acquisitions.closeFailedAttempt(sessionId, attempt))) {
        throw new AgentSessionAcquisitionExitUnprovenError(error)
      }
      throw error
    }
    acquisitions.deleteIfCurrent(sessionId, attempt)
    throw error
  } finally {
    attempt.finish()
  }
}
