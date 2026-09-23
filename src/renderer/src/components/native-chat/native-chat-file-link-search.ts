import { requestQuickOpenFileListing } from '@/components/quick-open-file-listing-request'
import { getNestedWorktreeExcludePaths } from '@/components/quick-open-file-list'
import { toast } from 'sonner'
import {
  getTerminalFileContext,
  openDetectedFilePath
} from '@/components/terminal-pane/terminal-file-open-routing'
import { translate } from '@/i18n/i18n'
import { basename, joinPath } from '@/lib/path'
import { activateAndRevealWorkspace } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import type { NativeChatFileLinkContext } from './native-chat-file-link'

const ROOTED_PATH_PATTERN = /^(?:~[\\/]|[\\/]|[A-Za-z]:[\\/])/

export function showFileLinkNotFoundToast(filePath: string): void {
  toast.error(
    translate('components.native-chat.fileLinks.notFound', 'File not found: {{value0}}', {
      value0: filePath
    })
  )
}

/** Worktree-relative text to search for when an unrooted link misses at the root; null when rooted. */
export function toFileLinkSearchPath(pathText: string): string | null {
  if (ROOTED_PATH_PATTERN.test(pathText)) {
    return null
  }
  const normalized = pathText
    .replace(/\\/g, '/')
    .replace(/^(?:\.{1,2}\/)+/, '')
    .replace(/\/+$/, '')
  return normalized || null
}

export function findFileLinkSearchMatches(files: readonly string[], searchPath: string): string[] {
  return files.filter((file) => {
    const normalized = file.replace(/\\/g, '/')
    return normalized === searchPath || normalized.endsWith(`/${searchPath}`)
  })
}

async function listWorkspaceFiles(
  context: NativeChatFileLinkContext,
  searchPath: string
): Promise<string[]> {
  const state = useAppStore.getState()
  const repoId = state.getKnownWorktreeById(context.worktreeId)?.repoId
  const excludePaths = getNestedWorktreeExcludePaths(
    context.worktreeId,
    context.worktreePath,
    (repoId ? state.worktreesByRepo[repoId] : undefined) ?? []
  )
  const listing = await requestQuickOpenFileListing(
    {
      ...getTerminalFileContext(
        context.worktreeId,
        context.worktreePath,
        context.runtimeEnvironmentId
      ),
      worktreePath: context.worktreePath
    },
    {
      query: basename(searchPath),
      ...(excludePaths.length > 0 ? { excludePaths } : {})
    }
  )
  return listing.files
}

/**
 * Agents often name a file by basename or by a path relative to their own cwd. A unique
 * workspace match opens directly; anything else lands in Quick Open, so the click is never dead.
 */
export async function openFileLinkBySearch(args: {
  searchPath: string
  line: number | null
  column: number | null
  context: NativeChatFileLinkContext
  openWithSystemDefault: boolean
  isCurrent: () => boolean
}): Promise<void> {
  const { context, searchPath } = args
  let matches: string[] = []
  try {
    matches = findFileLinkSearchMatches(await listWorkspaceFiles(context, searchPath), searchPath)
  } catch {
    // Quick Open below reports its own listing error.
  }
  if (!args.isCurrent()) {
    return
  }
  if (matches.length === 1) {
    const absolutePath = joinPath(context.worktreePath, matches[0])
    openDetectedFilePath(absolutePath, args.line, args.column, {
      worktreeId: context.worktreeId,
      worktreePath: context.worktreePath,
      runtimeEnvironmentId: context.runtimeEnvironmentId,
      openWithSystemDefault: args.openWithSystemDefault,
      // Why: the listing can be stale; never fall back into another search.
      onMissingPath: () => showFileLinkNotFoundToast(absolutePath)
    })
    return
  }
  const state = useAppStore.getState()
  if (state.activeWorktreeId !== context.worktreeId) {
    // Why: Quick Open lists the active workspace.
    activateAndRevealWorkspace(context.worktreeId)
  }
  useAppStore.getState().openModal('quick-open', { initialQuery: searchPath })
}
