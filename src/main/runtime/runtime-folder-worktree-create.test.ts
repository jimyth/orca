/** The startup terminal a folder workspace's create spawns; this path forwards presentation itself. */

import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { createRuntimeFolderWorktree } from './runtime-folder-worktree-create'

type CreateArgs = Parameters<typeof createRuntimeFolderWorktree>[0]

const repo: Repo = {
  id: 'repo-1',
  path: '/folder',
  displayName: 'folder',
  badgeColor: 'blue',
  addedAt: 1
}

function createDeps() {
  const createTerminal = vi
    .fn<CreateArgs['deps']['createTerminal']>()
    .mockResolvedValue({ handle: 'term-1', worktreeId: 'folder-1', title: null })
  const store = {
    getSettings: () => ({ workspaceDir: '/ws', nestWorkspaces: false }),
    setWorktreeMeta: (_id: string, meta: Record<string, unknown>) => meta,
    getProjectHostSetups: () => []
  }
  const deps: CreateArgs['deps'] = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create reads only these three store methods; any other would throw on call rather than read a wrong value.
    store: store as unknown as CreateArgs['deps']['store'],
    ptySpawnAvailable: true,
    createTerminal,
    markTrusted: vi.fn(),
    pasteDraft: vi.fn(),
    sendFollowup: vi.fn(),
    invalidateResolvedWorktrees: vi.fn(),
    notifyWorktreesChanged: vi.fn(),
    emitCreated: vi.fn(),
    activate: vi.fn()
  }
  return { createTerminal, deps }
}

async function startupTerminalOptions(
  startupPresentation?: 'background'
): Promise<Record<string, unknown>> {
  const { createTerminal, deps } = createDeps()
  await createRuntimeFolderWorktree({
    request: {
      repoSelector: `id:${repo.id}`,
      name: 'task',
      ...(startupPresentation ? { startupPresentation } : {})
    },
    repo,
    createdWithAgent: 'codex',
    startup: { command: 'codex' },
    deps
  })
  return createTerminal.mock.calls[0]?.[1] ?? {}
}

describe('a folder workspace create with a startup agent', () => {
  it('asks the runtime not to reveal when the caller presents the terminal itself', async () => {
    expect(await startupTerminalOptions('background')).toMatchObject({
      presentation: 'background'
    })
  })

  it('leaves the reveal in place when no presentation was asked for', async () => {
    expect(await startupTerminalOptions()).not.toHaveProperty('presentation')
  })
})
