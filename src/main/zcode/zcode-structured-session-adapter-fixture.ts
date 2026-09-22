// Test doubles for the zcode structured session adapter: a route-table fake of
// the app-server connection (mirrors the codex fakeCodex fixture) plus acquire
// helpers that keep the happy path one line long.

import type {
  AgentJournalMessageItem,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type {
  ZcodeAppServerConnection,
  ZcodeAppServerConnectionHandlers,
  ZcodeAppServerLaunch,
  openZcodeAppServerConnection
} from './zcode-app-server-connection'
import {
  ZcodeStructuredSessionAdapter,
  type ZcodeStructuredLaunch,
  type ZcodeStructuredSessionEvent
} from './zcode-structured-session-adapter'
import type { ZcodeSessionSendParams } from './zcode-protocol'

export const PROVIDER_SESSION_ID = 'sess_e2d0e231-d28d-4ffc-b4a8-4fba6aaff29f'
export const TURN_ID = 'turn_701dd6be-2ad0-4b18-b922-f570b9093636'

export function identityFor(sessionId: string): AgentSessionJournalIdentity {
  return {
    sessionId,
    workspaceId: 'ws-1',
    hostId: 'host-1',
    agent: 'zcode',
    providerHandle: { kind: 'opaque', agent: 'zcode', value: PROVIDER_SESSION_ID }
  }
}

export const USER_MESSAGE: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ship it' }]
}

export const MODEL_SELECTION: ZcodeSessionSendParams['modelSelection'] = {
  providerId: 'bigmodel-test',
  modelId: 'GLM-5.3',
  options: { reasoningLevel: 'max' }
}

export type Route = (params: Record<string, unknown> | undefined) => unknown

type FakeConnection = Omit<ZcodeAppServerConnection, 'closed'> & {
  closed: boolean
  launch: ZcodeAppServerLaunch
  handlers: ZcodeAppServerConnectionHandlers
  calls: { method: string; params?: Record<string, unknown> }[]
  replies: { id: number | string; result?: unknown; code?: number; message?: string }[]
  closeCount: number
}

export function fakeZcode(routes: Record<string, Route> = {}): {
  connections: FakeConnection[]
  openConnection: typeof openZcodeAppServerConnection
  routes: Record<string, Route>
} {
  const connections: FakeConnection[] = []
  const openConnection: typeof openZcodeAppServerConnection = async (launch, handlers = {}) => {
    const connection: FakeConnection = {
      launch,
      handlers,
      calls: [],
      replies: [],
      closeCount: 0,
      pid: 4321,
      closed: false,
      request: async (method, params) => {
        connection.calls.push({ method, params })
        const route = routes[method]
        return route ? route(params) : {}
      },
      respond: (id, result) => connection.replies.push({ id, result }),
      respondWithError: (id, code, message) => connection.replies.push({ id, code, message }),
      pauseReading: () => {},
      resumeReading: () => {},
      close: async () => {
        connection.closeCount += 1
        connection.closed = true
        return true
      }
    }
    connections.push(connection)
    return connection
  }
  routes['session/create'] ??= () => ({ session: { sessionId: PROVIDER_SESSION_ID } })
  return { connections, openConnection, routes }
}

export function adapterFor(
  zcode: ReturnType<typeof fakeZcode>,
  launch: Partial<ZcodeStructuredLaunch> = {},
  events: ZcodeStructuredSessionEvent[] = [],
  modelSelection?: ZcodeSessionSendParams['modelSelection']
): ZcodeStructuredSessionAdapter {
  let acquisitionGeneration = 0
  return new ZcodeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      command: 'zcode',
      args: ['app-server', '--stdio'],
      cwd: '/work/repo',
      ...launch
    }),
    resolvePermissionMode: () => 'default',
    ...(modelSelection ? { resolveModelSelection: async () => modelSelection } : {}),
    onEvent: (event) => events.push(event),
    openConnection: zcode.openConnection,
    readProcessStartTime: async () => 1_700_000_000_000,
    now: () => 1_700_000_000_500,
    mintAcquisitionGeneration: () => `generation-${++acquisitionGeneration}`
  })
}

export async function acquired(
  zcode: ReturnType<typeof fakeZcode>,
  events: ZcodeStructuredSessionEvent[] = [],
  modelSelection?: ZcodeSessionSendParams['modelSelection']
): Promise<ZcodeStructuredSessionAdapter> {
  const adapter = adapterFor(zcode, {}, events, modelSelection)
  await adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })
  return adapter
}

let nextEventSeq = 0

/** Spike-shaped `session/event` envelope for onNotification delivery. */
export function sessionEvent(
  type: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  nextEventSeq += 1
  return {
    eventId: `evt-${nextEventSeq}`,
    sessionId: PROVIDER_SESSION_ID,
    turnId: TURN_ID,
    seq: nextEventSeq,
    timestamp: 1_790_103_642_782,
    type,
    payload,
    ...overrides
  }
}
