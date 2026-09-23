import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('../windows/windows-process-table', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isWindowsProcessStartTimeAvailable: vi.fn(() => true)
}))

/** The location/resolve overrides every intent test needs: the intent resolver asks the runtime
 *  for a location and a workspace path before it can name an account home. */
function stubLocationResolution(
  runtime: OrcaRuntimeService,
  wslDistro: string | null = null
): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reaches the runtime's own protected location resolver for test override; the override only ever assigns vi.fn doubles with the declared shape.
  const internal = runtime as unknown as {
    resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
      executionHostId: string
      wslDistro: string | null
      workspaceId: string
      workspaceKind: 'git-worktree'
    }>
    resolveRuntimeFileTarget: (selector: string) => Promise<{
      worktree: { path: string }
    }>
  }
  internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
    executionHostId: 'local',
    wslDistro,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree' as const
  }))
  internal.resolveRuntimeFileTarget = vi.fn(async () => ({
    worktree: { path: '/repos/workspace-1' }
  }))
}

function runtimeForIntentTest(settings: object): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService's first parameter is a large collaborator bundle; the intent resolver under test reads only getSettings, which this stub provides in full.
  return new OrcaRuntimeService({ getSettings: () => settings } as never, undefined, {
    prepareCodexStructuredLaunch: vi.fn()
  })
}

describe('structured agent-session create intent', () => {
  it('pins the selected Codex launch home after normal launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn(() => '/accounts/selected/home')
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: { codex: { CODEX_HOME: '/configured/home' } },
          nativeChatSessionOptions: {
            codex: {
              model: 'gpt-5.6-sol',
              valuesByModel: {
                'gpt-5.6-sol': { effort: 'medium', fastMode: true, personality: 'concise' }
              }
            }
          }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'codex'
    })

    expect(prepareCodexStructuredLaunch).toHaveBeenCalledWith({
      workspacePath: '/repos/workspace-1',
      launchEnv: expect.objectContaining({ CODEX_HOME: '/configured/home' })
    })
    expect(intent.accountHome).toEqual({
      variable: 'CODEX_HOME',
      path: '/accounts/selected/home'
    })
    expect(intent.options).toEqual({ model: 'gpt-5.6-sol', effort: 'medium', fastMode: 'true' })
  })

  it('pins the configured Claude launch home without Codex launch preparation', async () => {
    const prepareCodexStructuredLaunch = vi.fn()
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: {
            claude: { CLAUDE_CONFIG_DIR: '/configured/claude-home' }
          },
          nativeChatSessionOptions: {
            claude: {
              model: 'opus',
              valuesByModel: { opus: { effort: 'high', fastMode: true } }
            }
          }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })

    expect(prepareCodexStructuredLaunch).not.toHaveBeenCalled()
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/configured/claude-home'
    })
    expect(intent.options).toEqual({ model: 'opus', effort: 'high', fastMode: 'true' })
  })

  it('uses the managed Claude launch home before falling back to ~/.claude', async () => {
    const prepareCodexStructuredLaunch = vi.fn()
    const getRuntimeConfigDir = vi.fn(() => '/accounts/managed/claude-home')
    const runtime = new OrcaRuntimeService(
      {
        getSettings: () => ({
          agentDefaultEnv: { claude: {} }
        })
      } as never,
      undefined,
      { prepareCodexStructuredLaunch }
    )
    runtime.setAccountServices({
      claudeAccounts: { getRuntimeConfigDir } as never,
      codexAccounts: {} as never,
      rateLimits: {} as never
    })
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    const internal = runtime as unknown as {
      resolveStructuredAgentSessionLocation: (selector: string) => Promise<{
        executionHostId: string
        wslDistro: null
        workspaceId: string
        workspaceKind: 'git-worktree'
      }>
      resolveRuntimeFileTarget: (selector: string) => Promise<{
        worktree: { path: string }
      }>
    }
    internal.resolveStructuredAgentSessionLocation = vi.fn(async () => ({
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }))
    internal.resolveRuntimeFileTarget = vi.fn(async () => ({
      worktree: { path: '/repos/workspace-1' }
    }))

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'claude'
    })

    expect(getRuntimeConfigDir).toHaveBeenCalledTimes(1)
    expect(intent.accountHome).toEqual({
      variable: 'CLAUDE_CONFIG_DIR',
      path: '/accounts/managed/claude-home'
    })
  })
})

describe('structured agent-session zcode create', () => {
  it('resolves a zcode intent against the user zcode home with no adoption', async () => {
    const runtime = runtimeForIntentTest({ agentDefaultEnv: {} })
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    stubLocationResolution(runtime)

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'zcode'
    })

    // Zcode has no managed home: app-server reads the user's real ~/.zcode, and the launch
    // resolver deliberately never reads this value back — it exists so the durable record and
    // the wire agree on where the conversation's credentials live.
    expect(intent.accountHome).toEqual({
      variable: 'ZCODE_HOME',
      path: join(homedir(), '.zcode')
    })
    expect(intent.provider).toBe('zcode')
    expect(intent.agent).toBe('zcode')
    expect(intent.adopt).toBeUndefined()
  })

  it('seeds a zcode resume with the opaque handle and no transcript adoption', async () => {
    const runtime = runtimeForIntentTest({ agentDefaultEnv: {} })
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    stubLocationResolution(runtime)

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'zcode',
      resumeFrom: { providerSessionId: 'provider-session-1' }
    })

    // ZCode has no transcript to adopt by path; the reservation seeds the chain
    // and session/resume proves the identity when the adapter acquires.
    expect(intent.accountHome).toEqual({
      variable: 'ZCODE_HOME',
      path: join(homedir(), '.zcode')
    })
    expect(intent.adopt).toEqual({
      providerHandle: { kind: 'opaque', agent: 'zcode', value: 'provider-session-1' }
    })
  })

  it('pins the configured ZCODE_HOME for a zcode resume before the user default', async () => {
    const runtime = runtimeForIntentTest({
      agentDefaultEnv: { zcode: { ZCODE_HOME: '/configured/zcode-home' } }
    })
    vi.spyOn(runtime, 'getStructuredAgentSessionCreateSupport').mockResolvedValue({
      supported: true
    })
    stubLocationResolution(runtime)

    const intent = await runtime.resolveStructuredAgentSessionCreateIntent({
      envelope: { sessionId: 'session-1', clientOperationId: 'operation-1' },
      worktree: 'id:workspace-1',
      agent: 'zcode',
      resumeFrom: { providerSessionId: 'provider-session-1' }
    })

    expect(intent.accountHome).toEqual({
      variable: 'ZCODE_HOME',
      path: '/configured/zcode-home'
    })
  })

  it('reports zcode create support on a local non-WSL workspace', async () => {
    const runtime = runtimeForIntentTest({})
    stubLocationResolution(runtime)

    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'zcode')
    ).resolves.toEqual({ supported: true })
  })

  it('keeps zcode create support refused for a WSL workspace', async () => {
    const runtime = runtimeForIntentTest({})
    stubLocationResolution(runtime, 'Ubuntu')

    await expect(
      runtime.getStructuredAgentSessionCreateSupport('id:workspace-1', 'zcode')
    ).resolves.toEqual({ supported: false, reason: 'wsl' })
  })
})
