import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../../shared/quick-open-listing-limits'
import { listRuntimeFiles, searchRuntimeFilePaths } from '@/runtime/runtime-file-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'

export type QuickOpenFileListing = { files: string[]; truncated: boolean }

/** SSH and runtime hosts answer a query server-side; local listings are ranked in the renderer. */
export function usesRuntimeQuickOpenPathSearch(context: RuntimeFileOperationArgs): boolean {
  return Boolean(context.settings?.activeRuntimeEnvironmentId?.trim() || context.connectionId)
}

export function requestQuickOpenFileListing(
  context: RuntimeFileOperationArgs & { worktreePath: string },
  args: {
    /** Only sent to hosts that search server-side; a local listing answers every query. */
    query?: string
    excludePaths?: string[]
    requestToken?: string
    signal?: AbortSignal
  }
): Promise<QuickOpenFileListing> {
  if (args.query !== undefined && usesRuntimeQuickOpenPathSearch(context)) {
    return searchRuntimeFilePaths(context, {
      query: args.query,
      limit: 32,
      excludePaths: args.excludePaths,
      ...(context.connectionId && args.requestToken ? { requestToken: args.requestToken } : {}),
      signal: args.signal
    })
  }
  return listRuntimeFiles(context, {
    rootPath: context.worktreePath,
    excludePaths: args.excludePaths,
    requestToken: args.requestToken,
    maxResults: QUICK_OPEN_LISTING_MAX_RESULTS,
    signal: args.signal
  }).then((files) => ({
    // #12547: naming the cap is what makes a full page readable as "there is more". Reporting
    // false unconditionally is what made the truncation silent — the host bounds the scan to
    // the cap it is given, so a full page means there are more paths behind it.
    files,
    truncated: files.length >= QUICK_OPEN_LISTING_MAX_RESULTS
  }))
}
