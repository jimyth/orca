/**
 * Who presents the surface `agent.launch` creates.
 *
 * The method has always driven a reveal nobody asked it for: it passes no `presentation`, so
 * `resolveTerminalPresentation` answers `undefined`, the gate at orca-runtime-create-terminal.ts:256
 * reads `undefined !== 'background'` as true, and the renderer's bridge mints a tab. A caller that
 * draws its own tab from the `paneKey` the outcome reports would get a second one.
 *
 * So the tests that matter here come in pairs: the opt-out reaches the runtime, AND the launch that
 * sends nothing asks for exactly what it asked for before. The second half is the load-bearing one
 * — mobile, orchestration and the CLI all send nothing, and an older client cannot send anything.
 *
 * `presentation` is not placement. Nothing below asks for a group, an order or a focus target.
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

    // Absent, not `undefined` under a present key: `resolveTerminalPresentation` reads the key's
    // value, but an explicit `presentation: undefined` would also reach the reveal payload's
    // `...(presentation ? ... : {})` spread differently from how today's callers reach it.
    expect(terminalOptions(runtime)).not.toHaveProperty('presentation')
  })

  it('refuses a focused presentation at the wire rather than routing it', async () => {
    // `focused` would send the create down the renderer-backed path, which reports no `paneKey`
    // and fires no `agent_started`. The schema is the whole guard — there is no clamp behind it.
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await expect(launch({ ...EXISTING_LAUNCH, presentation: 'focused' }, runtime)).rejects.toThrow()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('keeps the opt-out through a downgrade from structured to terminal', async () => {
    // The downgrade builds its terminal through the same factory. A caller that already drew its
    // tab does not stop owning it because the host could not give it a chat.
    const runtime = runtimeStub({ createSupport: { supported: false, reason: 'wsl' } })

    const result = await launch({ ...EXISTING_LAUNCH, presentation: 'background' }, runtime)

    expect(result.receipt).toMatchObject({ mode: 'terminal', reason: 'wsl_execution_runtime' })
    expect(terminalOptions(runtime).presentation).toBe('background')
  })

  it('still reports the pane the caller needs in order to present it', async () => {
    // The opt-out is only usable together with the identity #22108 added: suppressing the reveal
    // without naming the pane would leave a client with nothing to draw.
    const PANE_KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
    const runtime = runtimeStub({ settings: TERMINAL_ONLY, terminalPaneKey: PANE_KEY })

    const result = await launch({ ...EXISTING_LAUNCH, presentation: 'background' }, runtime)

    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_1', paneKey: PANE_KEY })
  })
})

describe('a launch that creates its workspace', () => {
  it('carries the opt-out to the startup terminal the create spawns', async () => {
    // The other terminal this method can create. Honouring the field on one path and not the other
    // would make it mean two different things depending on the target.
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

  it('keeps the opt-out out of the worktree-create payload itself', async () => {
    // A sibling of `create`, never a field inside it: suppressing this launch's reveal must not
    // become something a `worktree.create` caller can ask for.
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch({ ...CREATE_LAUNCH, presentation: 'background' }, runtime)

    const args = runtime.createManagedWorktree.mock.calls[0]?.[0] ?? {}
    expect(args).not.toHaveProperty('presentation')
  })
})

describe('a launch the host routes to a chat instead', () => {
  // Which route a launch takes is the host's decision and the caller cannot predict it. The opt-out
  // lands differently here — the chat tab is published either way and only its activation is
  // skipped — but a caller that said it presents the surface must not have one pulled in front of
  // it either. The factory is mocked below, so these two pin what the launch ASKS for, not what
  // `structured-agent-session-create` then does with it; that publish is pinned in its own tests.
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
