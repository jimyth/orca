import { useCallback } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-file-open-routing'
import { routeNativeChatHref } from '../../../../shared/native-chat-href-routing'
import { resolveNativeChatFileLink, type NativeChatFileLinkContext } from './native-chat-file-link'
import { openFileLinkBySearch, showFileLinkNotFoundToast } from './native-chat-file-link-search'

export function useNativeChatFileLinkClick(
  context: NativeChatFileLinkContext | null
): CommentMarkdownLinkClickHandler | undefined {
  const openFileLink = useCallback<CommentMarkdownLinkClickHandler>(
    (event, href) => {
      if (!context) {
        return
      }
      const target = resolveNativeChatFileLink(href, context)
      if (!target) {
        const route = routeNativeChatHref(href)
        if (route.kind === 'file') {
          // Why: e.g. `~/x` when the home folder cannot be inferred; never a dead click.
          event.preventDefault()
          showFileLinkNotFoundToast(route.pathText)
        }
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const { searchPath } = target
      openDetectedFilePath(target.absolutePath, target.line, target.column, {
        worktreeId: context.worktreeId,
        worktreePath: context.worktreePath,
        runtimeEnvironmentId: context.runtimeEnvironmentId,
        openWithSystemDefault: event.shiftKey,
        // Why: agents name files relative to their own cwd, or by basename alone.
        onMissingPath: searchPath
          ? (isCurrent) =>
              void openFileLinkBySearch({
                searchPath,
                line: target.line,
                column: target.column,
                context,
                openWithSystemDefault: event.shiftKey,
                isCurrent
              })
          : () => showFileLinkNotFoundToast(target.absolutePath)
      })
    },
    [context]
  )
  return context ? openFileLink : undefined
}
