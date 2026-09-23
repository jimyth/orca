/** The startup terminal an SSH-remote create spawns; each create path forwards presentation itself. */

import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeSetupLaunch } from '../../shared/worktree/launch-types'

const requestRuntimeRemoteWorktree = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      worktree: { id: string; path: string }
      setup?: WorktreeSetupLaunch
    }> => ({ worktree: { id: 'wt-remote', path: '/remote/wt' } })
  )
)

vi.mock('./runtime-remote-worktree-create-request', () => ({ requestRuntimeRemoteWorktree }))

const { createRuntimeRemoteManagedWorktree } =
  await import('./runtime-remote-managed-worktree-create')

type CreateParams = Parameters<typeof createRuntimeRemoteManagedWorktree>

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: 'blue',
  addedAt: 1,
  connectionId: 'conn-1'
}

function createDeps() {
  const createTerminal = vi
    .fn<CreateParams[2]['createTerminal']>()
    .mockResolvedValue({ handle: 'term-1' })
  const deps: CreateParams[2] = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create only forwards the store to the mocked request helper, which never reads it.
    store: {} as unknown as CreateParams[2]['store'],
    canSpawn: () => true,
    markTrusted: vi.fn(),
    createTerminal,
    pasteDraft: vi.fn(),
    sendFollowup: vi.fn(),
    provision: vi.fn().mockResolvedValue({ setupSpawned: false, setupTerminalHandle: null }),
    activate: vi.fn(),
    invalidateResolvedWorktrees: vi.fn(),
    invalidateWorktreeScan: vi.fn(),
    notifyWorktreesChanged: vi.fn()
  }
  return { createTerminal, deps }
}

async function startupTerminalOptions(
  startupPresentation?: 'background'
): Promise<Record<string, unknown>> {
  const { createTerminal, deps } = createDeps()
  await createRuntimeRemoteManagedWorktree(
    repo,
    {
      name: 'task',
      createdWithAgent: 'codex',
      startup: { command: 'codex' },
      ...(startupPresentation ? { startupPresentation } : {})
    },
    deps
  )
  return createTerminal.mock.calls[0]?.[1] ?? {}
}

describe('a remote managed create with a startup agent', () => {
  it('asks the runtime not to reveal when the caller presents the terminal itself', async () => {
    expect(await startupTerminalOptions('background')).toMatchObject({
      presentation: 'background'
    })
  })

  it('leaves the reveal in place when no presentation was asked for', async () => {
    expect(await startupTerminalOptions()).not.toHaveProperty('presentation')
  })

  it.each([
    ['background', null],
    [undefined, 'term-1']
  ] as const)(
    'with startupPresentation %s, offers %s to setup as its split target',
    async (startupPresentation, expectedPrimary) => {
      for (const activate of [true, false]) {
        requestRuntimeRemoteWorktree.mockResolvedValueOnce({
          worktree: { id: 'wt-remote', path: '/remote/wt' },
          setup: { runnerScriptPath: '/remote/wt/.orca/setup.sh', envVars: {} }
        })
        const { deps } = createDeps()
        await createRuntimeRemoteManagedWorktree(
          repo,
          {
            name: 'task',
            activate,
            createdWithAgent: 'codex',
            startup: { command: 'codex' },
            ...(startupPresentation ? { startupPresentation } : {})
          },
          deps
        )
        expect(deps.provision).toHaveBeenCalledWith(
          expect.objectContaining({
            primaryTerminalHandle: expectedPrimary,
            hasStartupTerminal: true
          })
        )
      }
    }
  )
})
