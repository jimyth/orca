import {
  ZCODE_INTERACTION_METHODS,
  ZCODE_SERVER_REQUEST_METHODS,
  type ZcodeProtocolServerRequest
} from './zcode-protocol'

// Field set mirrors zcodeSessionRuntimePreferencesResultSchema
// (ZCode repo packages/shared/src/zcode-protocol/index.ts): the schema is
// .strict(), so a reply may only carry these five fields. integratedTerminalShell
// is optional and deliberately omitted — Orca hosts no zcode integrated terminal.
export type ZcodeRuntimePreferencesResponse = {
  nativeSearchEnhancementsEnabled: boolean
  memoryEnabled: boolean
  askUserQuestionAutoResolutionEnabled: boolean
  modelContextBudgetStrategy: 'legacy' | 'preflight-v1'
}

/**
 * The reply Orca sends to session/requestRuntimePreferences. The request is
 * mandatory: it goes unanswered for 15s the CLI fails session/create with
 * -32022, so it must never be auto-denied. Values follow the spike-proven
 * reply (scripts/spike/zcode-app-server-transcript.mjs) and the schema
 * defaults: nothing opts the user into memory or native search enhancements
 * without their consent, and the shared default budget strategy applies.
 */
export function zcodeRuntimePreferencesResponse(): ZcodeRuntimePreferencesResponse {
  return {
    nativeSearchEnhancementsEnabled: false,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
    modelContextBudgetStrategy: 'preflight-v1'
  }
}

export type ZcodeServerRequestDisposition =
  | { kind: 'permission-prompt' }
  | { kind: 'user-input-prompt' }
  | { kind: 'runtime-preferences' }
  | { kind: 'auto-deny'; reason: string }

/**
 * Pure classification of a server-initiated request. Callers turn prompts into
 * registry entries and answered requests into replies; every unrecognized
 * method is auto-denied (respondWithError -32601) rather than left pending,
 * because the CLI blocks the owning flow until every request is answered.
 */
export function disposeZcodeServerRequest(
  frame: ZcodeProtocolServerRequest
): ZcodeServerRequestDisposition {
  if (frame.method === ZCODE_INTERACTION_METHODS.requestPermission) {
    return { kind: 'permission-prompt' }
  }
  if (frame.method === ZCODE_INTERACTION_METHODS.requestUserInput) {
    return { kind: 'user-input-prompt' }
  }
  if (frame.method === ZCODE_SERVER_REQUEST_METHODS.requestRuntimePreferences) {
    return { kind: 'runtime-preferences' }
  }
  return {
    kind: 'auto-deny',
    reason: `Orca does not recognize zcode server request ${frame.method}`
  }
}
