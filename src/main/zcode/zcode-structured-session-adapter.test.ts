import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { ZcodeAppServerRequestError } from './zcode-app-server-connection'
import type {
  StructuredAgentSessionAppendOptions,
  StructuredAgentSessionEventSink
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { ZcodeStructuredSessionAdapter } from './zcode-structured-session-adapter'
import {
  ZCODE_ERROR_CODES,
  ZCODE_INTERACTION_METHODS,
  ZCODE_SERVER_REQUEST_METHODS,
  type ZcodeProtocolServerRequest
} from './zcode-protocol'
import { zcodeRuntimePreferencesResponse } from './zcode-server-request-disposition'
import {
  MODEL_SELECTION,
  PROVIDER_SESSION_ID,
  TURN_ID,
  USER_MESSAGE,
  acquired,
  adapterFor,
  fakeZcode,
  identityFor,
  sessionEvent
} from './zcode-structured-session-adapter-fixture'

const PERMISSION_PARAMS = {
  requestId: 'perm-1',
  sessionId: PROVIDER_SESSION_ID,
  turnId: TURN_ID,
  toolCallId: 'tc-1',
  toolName: 'Write',
  reason: 'write spike.txt',
  riskLevel: 'medium',
  input: { command: 'printf hi > spike.txt' },
  options: [
    {
      optionId: 'allow_once',
      kind: 'allow_once',
      name: 'Allow Once',
      response: { decision: 'allow' }
    },
    {
      optionId: 'allow_project',
      kind: 'allow_always',
      name: 'Allow Project',
      response: { decision: 'allow', permissionUpdates: { tool: 'Write' } }
    },
    { optionId: 'deny', kind: 'deny', name: 'Deny', response: { decision: 'deny' } }
  ]
}

function serverRequest(
  id: number | string,
  method: string,
  params: unknown
): ZcodeProtocolServerRequest {
  return { kind: 'server-request', id, method, params }
}

function askPermission(
  zcode: ReturnType<typeof fakeZcode>,
  id: number | string,
  params: unknown = PERMISSION_PARAMS
): void {
  zcode.connections[0].handlers.onServerRequest?.(
    serverRequest(id, ZCODE_INTERACTION_METHODS.requestPermission, params)
  )
}

type RecordedAppend = {
  identity: AgentJournalItemIdentity
  body: AgentJournalItemBody
}

function recordingSink(
  admission: () =>
    | { accepted: true }
    | { accepted: false; reason: 'closed' | 'backpressure' | 'failed' } = () => ({
    accepted: true as const
  })
): {
  sink: StructuredAgentSessionEventSink
  appended: () => RecordedAppend[]
  rows: () => RecordedAppend[]
  published: () => StructuredAgentSessionAppendOptions[]
} {
  const appends: RecordedAppend[] = []
  const publishCalls: StructuredAgentSessionAppendOptions[] = []
  const byKey = new Map<string, RecordedAppend>()
  const record = (identity: AgentJournalItemIdentity, body: AgentJournalItemBody): void => {
    const row = { identity, body }
    appends.push(row)
    byKey.set(agentJournalItemKey(identity), row)
  }
  const sink: StructuredAgentSessionEventSink = {
    appendItem: record,
    appendTombstone: () => {},
    publish: (options) => {
      publishCalls.push(options ?? {})
    },
    tryAppendItem: (identity, body) => {
      const verdict = admission()
      if (verdict.accepted) {
        record(identity, body)
      }
      return verdict
    }
  }
  return {
    sink,
    appended: () => appends,
    rows: () => [...byKey.values()],
    published: () => publishCalls
  }
}

async function acquiredWithSink(
  zcode: ReturnType<typeof fakeZcode>,
  events: Parameters<typeof acquired>[1] = [],
  sink?: StructuredAgentSessionEventSink,
  modelSelection?: Parameters<typeof acquired>[2]
) {
  const adapter = adapterFor(zcode, {}, events, modelSelection)
  await adapter.acquire({
    identity: identityFor('session-1'),
    fence: 7,
    spawnToken: 'spawn-9',
    ...(sink ? { events: sink } : {})
  })
  return adapter
}

function approvalItemId(appended: () => RecordedAppend[]): string {
  const row = appended().find(({ body }) => body.kind === 'approval')
  if (!row) {
    throw new Error('test expected an approval row to be appended')
  }
  return agentJournalItemKey(row.identity)
}

describe('ZcodeStructuredSessionAdapter.acquire', () => {
  it('sends session/create then session/subscribe and reports the provider handle', async () => {
    const zcode = fakeZcode()
    const adapter = adapterFor(zcode)

    const acquisition = await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9'
    })

    expect(zcode.connections[0].calls.map((call) => call.method)).toEqual([
      'session/create',
      'session/subscribe'
    ])
    expect(zcode.connections[0].calls[0].params).toEqual({
      workspace: { workspacePath: '/work/repo', workspaceKey: 'ws-1' }
    })
    expect(zcode.connections[0].calls[1].params).toEqual({
      sessionId: PROVIDER_SESSION_ID,
      deliveryKind: 'desktop-continuous'
    })
    expect(acquisition.process).toEqual({
      hostId: 'host-1',
      pid: 4321,
      processStartTimeMs: 1_700_000_000_000,
      spawnToken: 'spawn-9'
    })
    expect(acquisition.link).toMatchObject({
      handle: { provider: 'zcode', sessionId: PROVIDER_SESSION_ID },
      origin: 'created',
      mintedAtFence: 7
    })
    expect(acquisition.acquisitionGeneration).toBe('generation-1')
  })

  it('names mode yolo on session/create only when the permission policy resolves yolo', async () => {
    const zcode = fakeZcode()
    const adapter = new ZcodeStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'zcode',
        args: ['app-server', '--stdio'],
        cwd: '/work/repo',
        resumeSessionId: null
      }),
      resolvePermissionMode: () => 'yolo',
      openConnection: zcode.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000
    })
    await adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })

    expect(zcode.connections[0].calls[0].params).toEqual({
      workspace: { workspacePath: '/work/repo', workspaceKey: 'ws-1' },
      mode: 'yolo'
    })
  })

  it('sends session/resume then session/subscribe and reports a resumed handle', async () => {
    const zcode = fakeZcode({
      'session/resume': () => ({
        session: {
          sessionId: PROVIDER_SESSION_ID,
          model: { providerId: 'bigmodel-test', modelId: 'GLM-5.3' }
        }
      })
    })
    const adapter = adapterFor(zcode, { resumeSessionId: PROVIDER_SESSION_ID })

    const acquisition = await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 9,
      spawnToken: 'spawn-11'
    })

    expect(zcode.connections[0].calls.map((call) => call.method)).toEqual([
      'session/resume',
      'session/subscribe'
    ])
    expect(zcode.connections[0].calls[0].params).toEqual({
      sessionId: PROVIDER_SESSION_ID,
      workspace: { workspacePath: '/work/repo', workspaceKey: 'ws-1' }
    })
    expect(zcode.connections[0].calls[1].params).toEqual({
      sessionId: PROVIDER_SESSION_ID,
      deliveryKind: 'desktop-continuous'
    })
    expect(acquisition.link).toMatchObject({
      handle: { provider: 'zcode', sessionId: PROVIDER_SESSION_ID },
      origin: 'resumed',
      mintedAtFence: 9
    })
  })

  it('refuses a resume that lands on another session and reaps the child', async () => {
    const zcode = fakeZcode({
      'session/resume': () => ({ session: { sessionId: 'sess_forked-under-resumes-name' } })
    })
    const adapter = adapterFor(zcode, { resumeSessionId: PROVIDER_SESSION_ID })

    // A resume that lands elsewhere is a fork wearing a resume's name; recording
    // it would make the durable handle chain lie about what this session proved.
    await expect(
      adapter.acquire({ identity: identityFor('session-1'), fence: 9, spawnToken: 'spawn-11' })
    ).rejects.toThrow(
      `zcode app-server resumed sess_forked-under-resumes-name instead of ${PROVIDER_SESSION_ID}`
    )
    expect(zcode.connections[0].closeCount).toBe(1)
  })

  it('restores persisted option overrides on a resumed session', async () => {
    const zcode = fakeZcode({
      'session/resume': () => ({ session: { sessionId: PROVIDER_SESSION_ID } })
    })
    const adapter = adapterFor(zcode, { resumeSessionId: PROVIDER_SESSION_ID })

    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 9,
      spawnToken: 'spawn-11',
      options: { model: 'bigmodel-test/GLM-5.3-Flash', effort: 'medium' }
    })

    await expect(
      adapter.readOptions?.({ sessionId: 'session-1', fence: 9 })
    ).resolves.toMatchObject({
      current: { model: 'bigmodel-test/GLM-5.3-Flash', effort: 'medium' }
    })
  })

  it('refuses a create result that names no session and reaps the child', async () => {
    const zcode = fakeZcode({ 'session/create': () => ({}) })
    const adapter = adapterFor(zcode)

    await expect(
      adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })
    ).rejects.toThrow('did not name a session')
    expect(zcode.connections[0].closeCount).toBe(1)
  })

  it('answers runtime preferences immediately so session/create is not stalled', async () => {
    const zcode = fakeZcode()
    await acquired(zcode)

    zcode.connections[0].handlers.onServerRequest?.(
      serverRequest('server-1', ZCODE_SERVER_REQUEST_METHODS.requestRuntimePreferences, {
        sessionId: PROVIDER_SESSION_ID
      })
    )

    expect(zcode.connections[0].replies).toEqual([
      { id: 'server-1', result: zcodeRuntimePreferencesResponse() }
    ])
  })

  it('answers runtime preferences while session/create is still pending', async () => {
    // Real zcode sends this server-request DURING session/create; the acquisition
    // window must not buffer it or the CLI times create out after 15s (-32022).
    const zcode = fakeZcode({ 'session/create': () => new Promise(() => {}) })
    const adapter = adapterFor(zcode)
    void adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-1' })
    await vi.waitFor(() => {
      expect(zcode.connections[0]?.calls.map((call) => call.method)).toContain('session/create')
    })

    zcode.connections[0].handlers.onServerRequest?.(
      serverRequest('server-9', ZCODE_SERVER_REQUEST_METHODS.requestRuntimePreferences, {
        sessionId: PROVIDER_SESSION_ID
      })
    )

    expect(zcode.connections[0].replies).toEqual([
      { id: 'server-9', result: zcodeRuntimePreferencesResponse() }
    ])
  })
})

describe('ZcodeStructuredSessionAdapter.dispatch', () => {
  it('sends session/send with the message text and the resolved model selection', async () => {
    const zcode = fakeZcode()
    const adapter = await acquired(zcode, [], MODEL_SELECTION)

    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: {
        kind: 'message',
        role: 'user',
        blocks: [
          { type: 'text', text: 'ship ' },
          { type: 'image-ref', path: '/tmp/shot.png' },
          { type: 'text', text: 'it' }
        ]
      },
      fence: 7
    })

    expect(outcome).toEqual({ state: 'admitted' })
    expect(zcode.connections[0].calls[2]).toEqual({
      method: 'session/send',
      params: {
        sessionId: PROVIDER_SESSION_ID,
        content: 'ship \nit',
        modelSelection: MODEL_SELECTION
      }
    })
  })

  it('derives model selection from the create-result echo when no resolver is injected', async () => {
    const zcode = fakeZcode({
      'session/create': () => ({
        session: {
          sessionId: PROVIDER_SESSION_ID,
          model: { providerId: 'bigmodel-test', modelId: 'GLM-5.3' }
        }
      })
    })
    const adapter = await acquired(zcode)

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(zcode.connections[0].calls[2].params).toMatchObject({
      modelSelection: {
        providerId: 'bigmodel-test',
        modelId: 'GLM-5.3',
        options: { reasoningLevel: 'max' }
      }
    })
  })

  it('reports a send the server declined as rejected', async () => {
    const zcode = fakeZcode({
      'session/send': () => {
        throw new ZcodeAppServerRequestError('session/send', -32602, 'turn already running')
      }
    })
    const adapter = await acquired(zcode, [], MODEL_SELECTION)

    const outcome = await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(outcome).toEqual({ state: 'rejected', reason: 'turn already running' })
  })

  it('settles the outstanding send when turn.started names the user input', async () => {
    const zcode = fakeZcode()
    const settled: { clientMessageId: string; providerItemId: string }[] = []
    const adapter = new ZcodeStructuredSessionAdapter({
      resolveLaunch: async () => ({
        command: 'zcode',
        args: ['app-server', '--stdio'],
        cwd: '/work/repo',
        resumeSessionId: null
      }),
      resolvePermissionMode: () => 'default',
      resolveModelSelection: async () => MODEL_SELECTION,
      openConnection: zcode.openConnection,
      readProcessStartTime: async () => 1_700_000_000_000,
      onDispatchSettledLate: ({ clientMessageId, providerIdentity }) =>
        settled.push({ clientMessageId, providerItemId: agentJournalItemKey(providerIdentity) })
    })
    await adapter.acquire({ identity: identityFor('session-1'), fence: 7, spawnToken: 'spawn-9' })

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })
    zcode.connections[0].handlers.onNotification?.(
      'session/event',
      sessionEvent('turn.started', { messageId: 'msg-1', inputId: 'input-1' })
    )

    expect(settled).toEqual([
      {
        clientMessageId: 'client-1',
        providerItemId: agentJournalItemKey({
          provider: 'orca',
          clientMessageId: `zcode-item:${PROVIDER_SESSION_ID}:msg-1`
        })
      }
    ])
  })
})

describe('ZcodeStructuredSessionAdapter prompts', () => {
  it('turns a permission request into a journal prompt and answers with the option response', async () => {
    const zcode = fakeZcode()
    const { sink, appended } = recordingSink()
    const adapter = await acquiredWithSink(zcode, [], sink)

    askPermission(zcode, 'server-3')

    const approval = appended().find(({ body }) => body.kind === 'approval')
    expect(approval?.body).toMatchObject({ kind: 'approval', title: 'Allow Write?' })
    const itemId = approvalItemId(appended)
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId,
      kind: 'approval',
      optionId: 'allow_once',
      fence: 7,
      commit: async () => undefined
    })

    expect(zcode.connections[0].replies).toEqual([
      { id: 'server-3', result: { decision: 'allow' } }
    ])
  })

  it('publishes the journal checkpoint right after admitting a permission prompt', async () => {
    const zcode = fakeZcode()
    const { sink, published } = recordingSink()
    await acquiredWithSink(zcode, [], sink)

    expect(published()).toHaveLength(0)
    askPermission(zcode, 'server-3')

    expect(published()).toEqual([{ lifecycle: true }])
  })

  it('responds to the latest frame and never twice for one requestId', async () => {
    const zcode = fakeZcode()
    const { sink, appended } = recordingSink()
    const events: Parameters<typeof acquired>[1] = []
    const adapter = await acquiredWithSink(zcode, events, sink)

    askPermission(zcode, 'server-3')
    // The CLI re-sends the same requestId every second until it is answered.
    askPermission(zcode, 'server-4')

    expect(events.filter((event) => event.type === 'prompt')).toHaveLength(1)
    expect(appended().filter(({ body }) => body.kind === 'approval')).toHaveLength(1)

    const itemId = approvalItemId(appended)
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId,
      kind: 'approval',
      optionId: 'allow_once',
      fence: 7,
      commit: async () => undefined
    })
    expect(zcode.connections[0].replies).toEqual([
      { id: 'server-4', result: { decision: 'allow' } }
    ])

    // A stale second answer (double-click race) must not reply again.
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId,
      kind: 'approval',
      optionId: 'deny',
      fence: 7,
      commit: async () => undefined
    })
    expect(zcode.connections[0].replies).toHaveLength(1)
  })

  it('does not re-surface an answered prompt when its frame is re-sent late', async () => {
    const zcode = fakeZcode()
    const { sink, appended } = recordingSink()
    const events: Parameters<typeof acquired>[1] = []
    const adapter = await acquiredWithSink(zcode, events, sink)

    askPermission(zcode, 'server-3')
    const itemId = approvalItemId(appended)
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId,
      kind: 'approval',
      optionId: 'allow_once',
      fence: 7,
      commit: async () => undefined
    })

    askPermission(zcode, 'server-9')

    expect(events.filter((event) => event.type === 'prompt')).toHaveLength(1)
    expect(appended().filter(({ body }) => body.kind === 'approval')).toHaveLength(1)
    expect(zcode.connections[0].replies).toHaveLength(1)
  })

  it('rejects a malformed permission request with invalid params', async () => {
    const zcode = fakeZcode()
    const events: Parameters<typeof acquired>[1] = []
    await acquiredWithSink(zcode, events)

    askPermission(zcode, 'server-3', {
      requestId: 'perm-bad',
      sessionId: PROVIDER_SESSION_ID,
      toolCallId: 'tc-1',
      toolName: 'Write',
      reason: 'no options',
      riskLevel: 'low',
      options: []
    })

    expect(zcode.connections[0].replies).toEqual([
      {
        id: 'server-3',
        code: ZCODE_ERROR_CODES.invalidParams,
        message: expect.stringContaining('could not register interaction/requestPermission')
      }
    ])
    expect(events.filter((event) => event.type === 'prompt')).toHaveLength(0)
  })

  it('auto-denies an unrecognized server request with method-not-found', async () => {
    const zcode = fakeZcode()
    await acquired(zcode)

    zcode.connections[0].handlers.onServerRequest?.(
      serverRequest('server-9', 'session/somethingElse', {})
    )

    expect(zcode.connections[0].replies).toEqual([
      {
        id: 'server-9',
        code: ZCODE_ERROR_CODES.methodNotFound,
        message: expect.stringContaining('does not recognize zcode server request')
      }
    ])
  })

  it('answers an error when the prompt row cannot be admitted to the journal', async () => {
    const zcode = fakeZcode()
    const { sink, published } = recordingSink(() => ({
      accepted: false as const,
      reason: 'closed' as const
    }))
    const events: Parameters<typeof acquired>[1] = []
    const adapter = await acquiredWithSink(zcode, events, sink)

    askPermission(zcode, 'server-3')

    expect(zcode.connections[0].replies).toEqual([
      {
        id: 'server-3',
        code: ZCODE_ERROR_CODES.internal,
        message: expect.stringContaining('could not durably record')
      }
    ])
    expect(published()).toHaveLength(0)
    expect(events.filter((event) => event.type === 'prompt')).toHaveLength(0)
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId: 'zcode-item:perm-1',
        kind: 'approval',
        optionId: 'allow_once',
        fence: 7,
        commit: async () => undefined
      })
    ).rejects.toThrow('no longer waiting')
  })

  it('surfaces a prompt that arrived while the session was still being acquired', async () => {
    const zcode = fakeZcode()
    const { sink, appended } = recordingSink()
    const events: Parameters<typeof acquired>[1] = []
    zcode.routes['session/create'] = () => {
      // The CLI can ask before the adapter has published the session.
      zcode.connections[0].handlers.onServerRequest?.(
        serverRequest('server-2', ZCODE_INTERACTION_METHODS.requestPermission, PERMISSION_PARAMS)
      )
      return { session: { sessionId: PROVIDER_SESSION_ID } }
    }
    const adapter = await acquiredWithSink(zcode, events, sink)

    expect(events.filter((event) => event.type === 'prompt')).toHaveLength(1)
    const itemId = approvalItemId(appended)
    await adapter.answerPrompt({
      sessionId: 'session-1',
      itemId,
      kind: 'approval',
      optionId: 'allow_once',
      fence: 7,
      commit: async () => undefined
    })
    expect(zcode.connections[0].replies).toEqual([
      { id: 'server-2', result: { decision: 'allow' } }
    ])
  })
})

describe('ZcodeStructuredSessionAdapter event reflow', () => {
  it('turns session events into journal rows across the translation arms', async () => {
    const zcode = fakeZcode()
    const { sink, rows } = recordingSink()
    const events: Parameters<typeof acquired>[1] = []
    await acquiredWithSink(zcode, events, sink)
    const notify = (frame: Record<string, unknown>): void =>
      zcode.connections[0].handlers.onNotification?.('session/event', frame)

    notify(sessionEvent('turn.started', { messageId: 'msg-1', inputId: 'input-1' }))
    notify(
      sessionEvent('model.streaming', {
        assistantMessageId: 'am-1',
        kind: 'text_delta',
        delta: 'Hello'
      })
    )
    notify(
      sessionEvent('model.streaming', {
        assistantMessageId: 'am-1',
        kind: 'text_delta',
        delta: ' there'
      })
    )
    notify(
      sessionEvent('model.streaming', {
        kind: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'Write',
        input: { path: 'spike.txt' }
      })
    )
    notify(
      sessionEvent('tool.updated', {
        kind: 'result',
        toolCallId: 'tc-1',
        result: { success: true, content: 'wrote spike.txt' },
        duration: 5
      })
    )
    notify(sessionEvent('turn.completed', { resultType: 'success', duration: 120 }))

    // The journal upserts by item key, so the row view shows each merged body
    // in its final state: the streamed message accumulated, the tool call
    // completed with its output, and the turn completed keeping its user item.
    const bodies = rows().map(({ body }) => body)
    expect(bodies.filter((body) => body.kind === 'turn')).toMatchObject([
      {
        kind: 'turn',
        turnId: TURN_ID,
        state: 'completed',
        outcome: 'success',
        durationMs: 120,
        userItemId: expect.any(String)
      }
    ])
    expect(bodies.filter((body) => body.kind === 'message')).toMatchObject([
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Hello there' }] }
    ])
    expect(bodies.filter((body) => body.kind === 'tool-call')).toMatchObject([
      {
        kind: 'tool-call',
        name: 'Write',
        callId: 'tc-1',
        state: 'completed',
        output: { head: 'wrote spike.txt', truncated: false }
      }
    ])
    expect(events.filter((event) => event.type === 'session-event')).toHaveLength(6)
  })

  it('resolves a prompt row when permission.resolved arrives from another device', async () => {
    const zcode = fakeZcode()
    const { sink, appended } = recordingSink()
    const adapter = await acquiredWithSink(zcode, [], sink)

    askPermission(zcode, 'server-3')
    zcode.connections[0].handlers.onNotification?.(
      'session/event',
      sessionEvent('permission.resolved', { requestId: 'perm-1', decision: 'deny' })
    )

    const approvals = appended().filter(({ body }) => body.kind === 'approval')
    expect(approvals.at(-1)?.body).toMatchObject({
      resolution: { state: 'resolved', selectedOptionId: 'deny' }
    })
    // The server already resolved it, so a late host answer finds nothing to claim.
    const itemId = agentJournalItemKey(approvals[0].identity)
    await expect(
      adapter.answerPrompt({
        sessionId: 'session-1',
        itemId,
        kind: 'approval',
        optionId: 'allow_once',
        fence: 7,
        commit: async () => undefined
      })
    ).rejects.toThrow('no longer waiting')
  })

  it('force-closes the session when a journal row cannot be admitted', async () => {
    const zcode = fakeZcode()
    const { sink } = recordingSink(() => ({ accepted: false as const, reason: 'closed' as const }))
    const events: Parameters<typeof acquired>[1] = []
    await acquiredWithSink(zcode, events, sink)

    zcode.connections[0].handlers.onNotification?.(
      'session/event',
      sessionEvent('model.streaming', {
        assistantMessageId: 'am-1',
        kind: 'text_delta',
        delta: 'x'
      })
    )

    expect(zcode.connections[0].closeCount).toBe(1)
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'ended')).toMatchObject([
        { cause: 'unexpected-exit', fence: 7 }
      ])
    )
  })
})

describe('ZcodeStructuredSessionAdapter lifecycle', () => {
  it('sends session/stop on cancelTurn', async () => {
    const zcode = fakeZcode()
    const adapter = await acquired(zcode)

    const result = await adapter.cancelTurn({ sessionId: 'session-1', turnId: TURN_ID, fence: 7 })

    expect(result).toEqual({ cancelled: true })
    expect(zcode.connections[0].calls.at(-1)).toEqual({
      method: 'session/stop',
      params: { sessionId: PROVIDER_SESSION_ID }
    })
  })

  it('closes the connection and reports a requested-close ended event', async () => {
    const zcode = fakeZcode()
    const events: Parameters<typeof acquired>[1] = []
    const adapter = await acquired(zcode, events)

    const closed = await adapter.closeSession('session-1')

    expect(closed).toBe(true)
    expect(zcode.connections[0].closeCount).toBe(1)
    expect(events.filter((event) => event.type === 'ended')).toMatchObject([
      { cause: 'requested-close', fence: 7 }
    ])
  })

  it('rejects a session option zcode does not have', async () => {
    const zcode = fakeZcode()
    const adapter = await acquired(zcode)

    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'approvalPolicy', value: 'never', fence: 7 })
    ).rejects.toThrow('no session option named approvalPolicy')
  })

  it('marks the session ended when the child exits on its own', async () => {
    const zcode = fakeZcode()
    const events: Parameters<typeof acquired>[1] = []
    const adapter = await acquired(zcode, events)

    zcode.connections[0].handlers.onExit?.(new Error('zcode app-server connection ended: boom'))

    expect(events.filter((event) => event.type === 'ended')).toMatchObject([
      { cause: 'unexpected-exit', reason: expect.stringContaining('boom') }
    ])
    await expect(
      adapter.dispatch({
        sessionId: 'session-1',
        clientMessageId: 'client-1',
        body: USER_MESSAGE,
        fence: 7
      })
    ).rejects.toThrow('no live zcode app-server')
  })
})
