// How a durable session record becomes a zcode app-server process launch.
//
// Every input is read back from the record the store already made durable, not
// from the call that triggered the acquire. A client that attaches twice must
// land in the same working directory, and a launch never trusts a workspace the
// caller names that the record did not pin.

import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { resolveZcodeCommand } from '../../shared/node-cli-command-resolution'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'

export type ZcodeStructuredLaunch = {
  command: string
  args: string[]
  env?: Record<string, string>
  cwd: string
}

export type ZcodeStructuredLaunchResolverDeps = {
  /** The narrow slice of the durable session store a launch needs; the lease and
   *  adjudication surface belongs to the acquire path that calls this resolver. */
  store: Pick<AgentSessionRecordStore, 'getRecord'>
  /** Absolute path of a workspace on this host. Rejects when the workspace no
   *  longer resolves, which is the case a stale mobile client hits. */
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** Overridden in tests; production scans the boot-cached PATH and version-manager dirs. */
  resolveCommand?: (options?: { pathEnv?: string | null; homePath?: string }) => string
  /** Fresh shell/configured environment for this spawn; never written to the session record. */
  resolveEnvironment?: () => Promise<NodeJS.ProcessEnv>
}

function envOverlay(environment: NodeJS.ProcessEnv): Record<string, string> {
  const overlay: Record<string, string> = {}
  for (const [name, value] of Object.entries(environment)) {
    if (value !== undefined) {
      overlay[name] = value
    }
  }
  return overlay
}

export function createZcodeStructuredLaunchResolver(
  deps: ZcodeStructuredLaunchResolverDeps
): (input: { identity: AgentSessionJournalIdentity }) => Promise<ZcodeStructuredLaunch> {
  return async ({ identity }) => {
    const record = deps.store.getRecord(identity.sessionId)
    if (!record) {
      throw new Error(`no durable agent-session record for ${identity.sessionId}`)
    }
    const { location } = record
    if (record.provider !== 'zcode') {
      throw new Error(`session ${identity.sessionId} is a ${record.provider} session`)
    }
    // This adapter spawns a child on the machine the runtime itself runs on.
    // A session pinned elsewhere belongs to that host's runtime, and quietly
    // starting it here would put a second writer on the same session.
    if (location.executionHostId !== LOCAL_EXECUTION_HOST_ID || location.wslDistro !== null) {
      throw new Error(
        `zcode structured sessions run on the local host, not ${location.executionHostId}`
      )
    }
    // record.accountHome is deliberately not read: zcode has no managed home to pin —
    // app-server reads the user's real ~/.zcode, which is also where a Default
    // permission mode resolves from.
    const environment = await deps.resolveEnvironment?.()
    const pathEnv = environment?.PATH ?? environment?.Path ?? null
    const homePath = environment?.HOME ?? environment?.USERPROFILE
    return {
      command: (deps.resolveCommand ?? resolveZcodeCommand)({
        pathEnv,
        ...(homePath ? { homePath } : {})
      }),
      // The wire is JSON-RPC over stdio; there is no other transport to choose.
      args: ['app-server', '--stdio'],
      cwd: await deps.resolveWorkspacePath(location.workspaceId),
      ...(environment ? { env: envOverlay(environment) } : {})
    }
  }
}
