// Runtime-facing assembly for the zcode structured adapter, mirroring
// structured-claude-runtime-adapter.ts: the launch resolver, env overlay, and
// injectable transports live here so structured-agent-session-runtime.ts stays
// inside its line budget while the deps it forwards stay typechecked.

import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import {
  createZcodeStructuredLaunchResolver,
  type ZcodeStructuredLaunchResolverDeps
} from '../zcode/zcode-structured-launch-resolution'
import type { ZcodeStructuredPermissionMode } from '../zcode/zcode-structured-permission-policy'
import { ZcodeStructuredSessionAdapter } from '../zcode/zcode-structured-session-adapter'
import type {
  ZcodeStructuredSessionAdapterDeps,
  ZcodeStructuredSessionEvent
} from '../zcode/zcode-structured-session-state'
import type { ZcodeSessionSendParams } from '../zcode/zcode-protocol'

export type StructuredZcodeRuntimeAdapterDeps = {
  /** The narrow store slice the launch resolver reads; the runtime owns the full store. */
  store: ZcodeStructuredLaunchResolverDeps['store']
  resolveWorkspacePath: (workspaceId: string) => Promise<string>
  /** Boot environment (login shell) the zcode child inherits. */
  bootEnvironment: () => Promise<NodeJS.ProcessEnv>
  resolveZcodeCommand?: ZcodeStructuredLaunchResolverDeps['resolveCommand']
  /** Per-agent overlay from the user's agent env settings. */
  resolveZcodeLaunchEnv?: () => Promise<Record<string, string>> | Record<string, string>
  /** The user's Agent Permissions setting as the session/create permission mode. */
  resolveZcodePermissionMode?: () => ZcodeStructuredPermissionMode
  /** Zcode session/send model selection from the user's environment. Absent means the
   *  adapter prefers the create-result echo (empirically the reliable path on a real
   *  app-server) and falls back to its shipped default; a settings-backed source lands
   *  here once the model-selection catalog exists (follow-up FU3). */
  resolveZcodeModelSelection?: () =>
    | Promise<ZcodeSessionSendParams['modelSelection']>
    | ZcodeSessionSendParams['modelSelection']
  openZcodeConnection?: ZcodeStructuredSessionAdapterDeps['openConnection']
  readProcessStartTime?: ZcodeStructuredSessionAdapterDeps['readProcessStartTime']
  onUnexpectedExit: (event: StructuredAgentSessionLifecycleEvent) => void
  onDispatchSettledLate?: ZcodeStructuredSessionAdapterDeps['onDispatchSettledLate']
}

export function createStructuredZcodeRuntimeAdapter(
  deps: StructuredZcodeRuntimeAdapterDeps
): ZcodeStructuredSessionAdapter {
  const resolveEnvironment = async (): Promise<NodeJS.ProcessEnv> => ({
    ...(await deps.bootEnvironment()),
    ...(await deps.resolveZcodeLaunchEnv?.())
  })
  return new ZcodeStructuredSessionAdapter({
    resolveLaunch: createZcodeStructuredLaunchResolver({
      store: deps.store,
      resolveWorkspacePath: deps.resolveWorkspacePath,
      resolveEnvironment,
      ...(deps.resolveZcodeCommand ? { resolveCommand: deps.resolveZcodeCommand } : {})
    }),
    ...(deps.resolveZcodePermissionMode
      ? { resolvePermissionMode: () => deps.resolveZcodePermissionMode!() }
      : {}),
    ...(deps.resolveZcodeModelSelection
      ? { resolveModelSelection: async () => await deps.resolveZcodeModelSelection!() }
      : {}),
    ...(deps.openZcodeConnection ? { openConnection: deps.openZcodeConnection } : {}),
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    ...(deps.onDispatchSettledLate ? { onDispatchSettledLate: deps.onDispatchSettledLate } : {}),
    onEvent: (event: ZcodeStructuredSessionEvent) => {
      if (event.type === 'ended' && 'cause' in event && event.cause === 'unexpected-exit') {
        deps.onUnexpectedExit(event)
      }
    }
  })
}
