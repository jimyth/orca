/**
 * Who presents the surface `agent.launch` creates. Tests come in pairs: the opt-out reaches the
 * runtime, and a launch that sends nothing asks for exactly what it did before.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  type AgentLaunchRuntimeStub as RuntimeStub
} from './agent-launch.test-fixture'

const createStructuredSession = vi.hoisted(() =>
  vi.fn(async (_args: Record<string, unknown>) => ({ ok: true, value: { sessionId: 'sess-1' } }))
)

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: createStructuredSession
}))

beforeEach(() => {
  createStructuredSession.mockClear()
})

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')

/** No structured preference, so every launch here settles as a terminal. */
const TERMINAL_ONLY = {}

const EXISTING_LAUNCH = {
  agent: 'claude',
  target: { kind: 'existing', worktree: 'id:wt-7' }
}

const PANE_KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'

const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}

async function launch(params: unknown, runtime: RuntimeStub, context: Partial<RpcContext> = {}) {
  const parsed = AGENT_LAUNCH.params.safeParse(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, { ...CAPABLE_CLIENT, ...context }))
}

/** The options object the launch handed `createTerminal`. */
function terminalOptions(runtime: RuntimeStub): Record<string, unknown> {
  const call = runtime.createTerminal.mock.calls[0]
  if (!call) {
    throw new Error('createTerminal was never called')
  }
  return call[1] ?? {}
}

describe('a launch into an existing workspace', () => {
  it('asks the runtime not to reveal when the caller presents its own surface', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch({ ...EXISTING_LAUNCH, presentation: 'background' }, runtime)

    expect(terminalOptions(runtime).presentation).toBe('background')
  })

  it('leaves the runtime reveal in place when the caller sends nothing', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch(EXISTING_LAUNCH, runtime)

    // Absent, not `undefined` under a present key: today's options object, unchanged.
    expect(terminalOptions(runtime)).not.toHaveProperty('presentation')
  })

  it('refuses a focused presentation at the wire rather than routing it', async () => {
    // `focused` would take the renderer-backed path: no `paneKey`, no `agent_started`.
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await expect(launch({ ...EXISTING_LAUNCH, presentation: 'focused' }, runtime)).rejects.toThrow()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('keeps the opt-out through a downgrade from structured to terminal', async () => {
    const runtime = runtimeStub({ createSupport: { supported: false, reason: 'wsl' } })

    const result = await launch({ ...EXISTING_LAUNCH, presentation: 'background' }, runtime)

    expect(result.receipt).toMatchObject({ mode: 'terminal', reason: 'wsl_execution_runtime' })
    expect(terminalOptions(runtime).presentation).toBe('background')
  })

  it('still reports the pane the caller needs in order to present it', async () => {
    const runtime = runtimeStub({
      settings: TERMINAL_ONLY,
      terminalPaneKey: PANE_KEY,
      terminalSurface: 'background'
    })

    const result = await launch({ ...EXISTING_LAUNCH, presentation: 'background' }, runtime)

    expect(result.outcome).toEqual({
      kind: 'terminal',
      handle: 'term_1',
      paneKey: PANE_KEY,
      surface: 'background'
    })
  })

  // The request is what the caller asked for; only the runtime knows whether a reveal happened.
  it.each(['visible', 'background'] as const)(
    'reports the surface the runtime says it produced (%s), whatever was requested',
    async (terminalSurface) => {
      const runtime = runtimeStub({ settings: TERMINAL_ONLY, terminalSurface })

      const result = await launch(EXISTING_LAUNCH, runtime)

      expect(result.outcome).toEqual({
        kind: 'terminal',
        handle: 'term_1',
        surface: terminalSurface
      })
    }
  )
})

describe('a launch that creates its workspace', () => {
  it('carries the opt-out to the startup terminal the create spawns', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch({ ...CREATE_LAUNCH, presentation: 'background' }, runtime)

    expect(runtime.createManagedWorktree.mock.calls[0]?.[0]).toMatchObject({
      startupPresentation: 'background'
    })
  })

  it('sends no presentation when the caller asked for none', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch(CREATE_LAUNCH, runtime)

    expect(runtime.createManagedWorktree.mock.calls[0]?.[0]).not.toHaveProperty(
      'startupPresentation'
    )
  })

  it.each(['visible', 'background'] as const)(
    'reports whether the create revealed its startup terminal (%s)',
    async (startupTerminalSurface) => {
      const runtime = runtimeStub({ settings: TERMINAL_ONLY, startupTerminalSurface })

      const result = await launch({ ...CREATE_LAUNCH, presentation: 'background' }, runtime)

      expect(result.outcome).toEqual({
        kind: 'terminal',
        handle: 'term_agent_first',
        surface: startupTerminalSurface
      })
    }
  )

  it('names the sibling startupPresentation, not a bare presentation, on the runtime args', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch({ ...CREATE_LAUNCH, presentation: 'background' }, runtime)

    const args = runtime.createManagedWorktree.mock.calls[0]?.[0] ?? {}
    expect(args).not.toHaveProperty('presentation')
  })
})

describe('a launch the host routes to a chat instead', () => {
  // The structured create is mocked, so these pin what the launch asks for, not the publish.
  it('hands the structured create `activate: false` when the caller presents its own surface', async () => {
    const runtime = runtimeStub()

    const result = await launch({ ...EXISTING_LAUNCH, presentation: 'background' }, runtime)

    expect(result.outcome).toMatchObject({ kind: 'structured' })
    expect(createStructuredSession.mock.calls[0]?.[0]).toMatchObject({ activate: false })
  })

  it('hands the structured create `activate: true` when the caller asked for nothing', async () => {
    const runtime = runtimeStub()

    await launch(EXISTING_LAUNCH, runtime)

    expect(createStructuredSession.mock.calls[0]?.[0]).toMatchObject({ activate: true })
  })
})

describe('a launch that creates no surface', () => {
  it('creates no terminal to present when it reuses a running one', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    const result = await launch(
      { ...EXISTING_LAUNCH, presentation: 'background', reuseTerminal: { handle: 'term_live' } },
      runtime
    )

    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_live' })
  })
})
