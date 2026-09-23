import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session-mutation-envelope'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { AgentSessionRecordStore } from '../../agent-session-record-store'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter'
import { StructuredAgentSessionAdapterRouter } from '../../../native-chat/agent-session-wire/structured-agent-session-adapter-router'
import { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { fakeZcode } from '../../../zcode/zcode-structured-session-adapter-fixture'
import { ZcodeStructuredSessionAdapter } from '../../../zcode/zcode-structured-session-adapter'
import { createZcodeStructuredLaunchResolver } from '../../../zcode/zcode-structured-launch-resolution'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { STRUCTURED_AGENT_SESSION_METHODS } from './structured-agent-session'

const SESSION = 'zcode_resume_routing'
const PROVIDER_SESSION = 'sess_resume-routing-provider-session'
const WORKSPACE = 'workspace-1'
const OPERATION = `${Date.now()}-00000000000000000000000000000001`
const CLIENT = {
  clientId: 'device-a',
  clientKind: 'runtime' as const,
  clientCapabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}

let root: string
let host: StructuredAgentSessionHost

/** The lanes this create must never touch; routing to them is the failure mode under test. */
function refusingAdapter(): StructuredAgentSessionAdapter {
  return {
    acquire: vi.fn(async () => {
      throw new Error('routed to the wrong provider lane')
    }),
    dispatch: vi.fn(async () => {
      throw new Error('routed to the wrong provider lane')
    }),
    cancelTurn: vi.fn(async () => ({ cancelled: false })),
    answerPrompt: vi.fn(async () => {
      throw new Error('routed to the wrong provider lane')
    }),
    setOption: vi.fn(async () => undefined)
  }
}

function createParams(
  sessionId = SESSION,
  operationId = OPERATION,
  resumeFrom: { providerSessionId: string } | undefined = { providerSessionId: PROVIDER_SESSION }
) {
  const fields = {
    worktree: `id:${WORKSPACE}`,
    agent: 'zcode' as const,
    ...(resumeFrom ? { resumeFrom } : {})
  }
  return {
    envelope: {
      sessionId,
      clientOperationId: operationId,
      expectedRuntimeFence: null,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId,
        fields
      })
    },
    ...fields
  }
}

async function call(dispatcher: RpcDispatcher, params: unknown, client = CLIENT) {
  const replies: RpcResponse[] = []
  const request: RpcRequest = {
    id: `request-${replies.length + 1}`,
    authToken: 'token',
    method: 'agentSession.create',
    params
  }
  await dispatcher.dispatchStreaming(request, (raw) => replies.push(JSON.parse(raw)), client)
  return replies[0]
}

async function callCreate(params: unknown) {
  return await call(dispatcherForRuntime(), params)
}

let runtime: OrcaRuntimeService

function dispatcherForRuntime() {
  return new RpcDispatcher({ runtime, methods: STRUCTURED_AGENT_SESSION_METHODS })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-zcode-resume-routing-'))
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await host?.flushAllStreamedEvents()
  await host?.close(SESSION)
  await rm(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('zcode structured session resume routing', () => {
  it('routes an adopting create through session/resume and proves the adopted handle', async () => {
    const fake = fakeZcode({
      'session/resume': () => ({ session: { sessionId: PROVIDER_SESSION } })
    })
    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    const zcodeAdapter = new ZcodeStructuredSessionAdapter({
      resolveLaunch: createZcodeStructuredLaunchResolver({
        store,
        resolveWorkspacePath: async () => '/repos/workspace-1',
        resolveCommand: () => '/usr/local/bin/zcode'
      }),
      openConnection: fake.openConnection,
      readProcessStartTime: async () => 1_800_000_000_000
    })
    const adapter = new StructuredAgentSessionAdapterRouter(
      {
        claude: refusingAdapter(),
        codex: refusingAdapter(),
        zcode: zcodeAdapter
      },
      async () => undefined
    )
    host = new StructuredAgentSessionHost({
      store,
      adapter,
      journalRoot: root,
      claimKeyId: 'key-1'
    })
    setStructuredAgentSessionHost(host)

    runtime = new OrcaRuntimeService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService's first parameter is a large collaborator bundle; the create-intent path under test reads only getSettings, which this stub provides in full.
      {
        getSettings: () => ({
          experimentalStructuredNativeChat: true,
          agentDefaultEnv: {}
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch: vi.fn() }
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial client-settings stub; the structured-session gate reads only this flag.
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      experimentalStructuredNativeChat: true
    } as ReturnType<OrcaRuntimeService['getClientSettings']>)
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reaches the runtime's own protected location resolver for test override; the override only ever assigns vi.fn doubles with the declared shape.
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: () => Promise<{
        executionHostId: 'local'
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: () => Promise<{ worktree: { path: string } }>
      ensureStructuredAgentSessionHost: () => Promise<void>
      publishStructuredAgentSessionTab: () => Promise<void>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local' as const,
      wslDistro: null,
      workspaceId: WORKSPACE,
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))
    internal.ensureStructuredAgentSessionHost = vi.fn(async () => undefined)
    internal.publishStructuredAgentSessionTab = vi.fn(async () => undefined)

    const result = await callCreate(createParams())

    expect(result).toMatchObject({
      ok: true,
      result: { ok: true, replayed: false, value: { sessionId: SESSION } }
    })
    // The routing claim itself: adopt seeded the chain, the launch resolver read
    // it back from the durable record, and the adapter resumed instead of creating.
    expect(fake.connections[0].calls.map((call) => call.method)).toEqual([
      'session/resume',
      'session/subscribe'
    ])
    expect(fake.connections[0].calls[0].params).toEqual({
      sessionId: PROVIDER_SESSION,
      workspace: { workspacePath: '/repos/workspace-1', workspaceKey: WORKSPACE }
    })
    const record = store.getRecord(SESSION)
    expect(record?.providerHandleChain).toHaveLength(1)
    expect(record?.providerHandleChain[0]).toMatchObject({
      handle: { provider: 'zcode', sessionId: PROVIDER_SESSION },
      origin: 'adopted'
    })
    expect(record?.lease.claimStatus).toBe('live')
    expect(record?.lease.provenHandleLinkId).toBe(record?.providerHandleChain[0]?.linkId)
    expect(record?.accountHome).toEqual({ variable: 'ZCODE_HOME', path: join(homedir(), '.zcode') })

    // The exact committed operation replays from the durable identity without
    // touching the provider again.
    const replay = await callCreate(createParams())
    expect(replay).toMatchObject({ ok: true, result: { ok: true, replayed: true } })
    expect(fake.connections).toHaveLength(1)

    // One writer per conversation: a second session adopting the same provider
    // session is refused while the first lease admits a writer.
    const conflict = await callCreate(
      createParams('zcode_resume_conflict', `${Date.now()}-00000000000000000000000000000002`)
    )
    expect(conflict).toMatchObject({
      ok: true,
      result: { ok: false, refusal: { code: 'agent_session_conflict' } }
    })
  })
})
