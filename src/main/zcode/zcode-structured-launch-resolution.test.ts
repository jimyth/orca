import { describe, expect, it, vi } from 'vitest'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { createZcodeStructuredLaunchResolver } from './zcode-structured-launch-resolution'

const SESSION_ID = 'session-1'
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: SESSION_ID,
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'zcode',
  // The journal-side handle union has no zcode member yet; opaque is the honest
  // spelling today. The resolver reads only identity.sessionId.
  providerHandle: { kind: 'opaque', agent: 'zcode', value: 'provider-session-1' }
}

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  const base: AgentSessionRecord = {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: SESSION_ID,
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'zcode',
    providerHandleChain: [],
    accountHome: { variable: 'CODEX_HOME', path: '/home/work/.zcode' },
    lease: {
      sessionId: SESSION_ID,
      runtimeKind: 'native',
      runtimeFence: 1,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: 0,
      lastRenewedAt: 0,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'claim-key-1',
      claimStatus: 'live',
      unreconciled: false,
      deathEvidence: null
    },
    createdAt: 0,
    updatedAt: 0
  }
  return { ...base, ...overrides }
}

function resolverFor(
  value: AgentSessionRecord | null,
  resolveWorkspacePath: (workspaceId: string) => Promise<string> = async (id) => `/repos/${id}`
) {
  return createZcodeStructuredLaunchResolver({
    store: { getRecord: () => value },
    resolveWorkspacePath,
    resolveCommand: () => '/usr/local/bin/zcode'
  })
}

describe('zcode structured launch resolution', () => {
  it('launches the app server over stdio in the workspace the record pinned', async () => {
    const launch = await resolverFor(record())({ identity: IDENTITY })

    expect(launch).toEqual({
      command: '/usr/local/bin/zcode',
      args: ['app-server', '--stdio'],
      cwd: '/repos/workspace-1',
      resumeSessionId: null
    })
  })

  it('resumes the last provider session this record actually proved, not one a caller names', async () => {
    const launch = await resolverFor(
      record({
        providerHandleChain: [
          {
            linkId: 'zcode-1-provider-session-old',
            handle: { provider: 'zcode', sessionId: 'provider-session-old' },
            origin: 'created',
            mintedAtFence: 1,
            observedAt: 1_700_000_000_000
          },
          {
            linkId: 'zcode-3-provider-session-9',
            handle: { provider: 'zcode', sessionId: 'provider-session-9' },
            origin: 'resumed',
            mintedAtFence: 3,
            observedAt: 1_700_000_000_500
          }
        ]
      })
    )({ identity: IDENTITY })

    expect(launch.resumeSessionId).toBe('provider-session-9')
  })

  it('ignores a chain head this adapter does not speak for rather than resuming it', async () => {
    const launch = await resolverFor(
      record({
        providerHandleChain: [
          {
            linkId: 'codex-1-thread-1',
            handle: { provider: 'codex', threadId: 'thread-1' },
            origin: 'created',
            mintedAtFence: 1,
            observedAt: 1_700_000_000_000
          }
        ]
      })
    )({ identity: IDENTITY })

    expect(launch.resumeSessionId).toBeNull()
  })

  it('passes a Windows .cmd path containing cmd syntax directly to the safe spawn layer', async () => {
    const command = String.raw`C:\Users\r&d\npm-prefix\zcode.cmd`

    await withPlatform('win32', async () => {
      const resolveLaunch = createZcodeStructuredLaunchResolver({
        store: { getRecord: () => record() },
        resolveWorkspacePath: async () => String.raw`C:\workspaces\orca`,
        resolveCommand: () => command
      })

      await expect(resolveLaunch({ identity: IDENTITY })).resolves.toMatchObject({
        command,
        args: ['app-server', '--stdio']
      })
    })
  })

  it('resolves the command against the fresh environment PATH before any install-dir scan', async () => {
    const resolveCommand = vi.fn(() => '/usr/local/bin/zcode')
    const resolveLaunch = createZcodeStructuredLaunchResolver({
      store: { getRecord: () => record() },
      resolveWorkspacePath: async () => '/repos/workspace-1',
      resolveCommand,
      resolveEnvironment: async () => ({ PATH: '/fresh/bin:/usr/bin', HOME: '/home/work' })
    })

    await resolveLaunch({ identity: IDENTITY })

    expect(resolveCommand).toHaveBeenCalledWith({
      pathEnv: '/fresh/bin:/usr/bin',
      homePath: '/home/work'
    })
  })

  it('carries the resolved environment as an overlay when one is provided', async () => {
    const resolveLaunch = createZcodeStructuredLaunchResolver({
      store: { getRecord: () => record() },
      resolveWorkspacePath: async () => '/repos/workspace-1',
      resolveCommand: () => '/usr/local/bin/zcode',
      resolveEnvironment: async () => ({ PATH: '/fresh/bin', ZCODE_EXTRA: '1' })
    })

    await expect(resolveLaunch({ identity: IDENTITY })).resolves.toMatchObject({
      env: { PATH: '/fresh/bin', ZCODE_EXTRA: '1' }
    })
  })

  it('refuses a record this adapter does not speak for', async () => {
    await expect(
      resolverFor(record({ provider: 'claude' }))({ identity: IDENTITY })
    ).rejects.toThrow(/is a claude session/)
  })

  it('refuses a session pinned to another host rather than starting a second writer here', async () => {
    await expect(
      resolverFor(record({ location: { ...record().location, executionHostId: 'ssh:build-box' } }))(
        { identity: IDENTITY }
      )
    ).rejects.toThrow(/local host/)
  })

  it('refuses a WSL session, which is a separate filesystem and process namespace', async () => {
    await expect(
      resolverFor(record({ location: { ...record().location, wslDistro: 'Ubuntu' } }))({
        identity: IDENTITY
      })
    ).rejects.toThrow(/local host/)
  })

  it('refuses to launch for a session the store has no record of', async () => {
    await expect(resolverFor(null)({ identity: IDENTITY })).rejects.toThrow(/no durable/)
  })

  it('surfaces a workspace that no longer resolves instead of falling back to a default cwd', async () => {
    await expect(
      resolverFor(record(), async () => {
        throw new Error('workspace-1 is gone')
      })({ identity: IDENTITY })
    ).rejects.toThrow('workspace-1 is gone')
  })
})
