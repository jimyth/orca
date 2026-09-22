import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolvedTuiAgentArgsBypassPermissions } from '../../shared/tui-agent-launch-defaults'

export type ZcodeStructuredPermissionMode = 'yolo' | 'default'

/**
 * The Agent Permissions setting as zcode `session/create` mode.
 *
 * Yolo answers session/create with `mode: 'yolo'` — the one mode zcode's permission
 * service lets skip every prompt (`mode.yolo` in core/src/permission/service.ts).
 *
 * Default OMITS the field rather than naming a mode, and that is deliberate: an omitted
 * mode resolves through the user's own zcode config `permission.mode`
 * (runtime-config.ts: `runtimeConfig?.mode ?? persistedMode ?? config.permission.mode`),
 * whose shipped default is `build` — an approval posture (read-only tools pass,
 * high/critical risk asks). Unlike codex, where an omitted field fell through to a
 * config.toml Orca mirrors into the managed home and a stray `approval_policy = "never"`
 * silently un-Manualled the session, zcode's app-server reads the user's real `~/.zcode`:
 * the only way Default stops being approval-gated is the user configuring it that way,
 * and Orca naming a concrete mode would override that deliberate choice.
 */
export function zcodeStructuredPermissionModeForSettings(
  settings:
    | Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'terminalWindowsShell'>>
    | null
    | undefined
): ZcodeStructuredPermissionMode {
  return resolvedTuiAgentArgsBypassPermissions('zcode', settings, process.platform)
    ? 'yolo'
    : 'default'
}
