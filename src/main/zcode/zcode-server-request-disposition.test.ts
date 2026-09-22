import { describe, expect, it } from 'vitest'
import {
  ZCODE_INTERACTION_METHODS,
  ZCODE_SERVER_REQUEST_METHODS,
  type ZcodeProtocolServerRequest
} from './zcode-protocol'
import {
  disposeZcodeServerRequest,
  zcodeRuntimePreferencesResponse
} from './zcode-server-request-disposition'

function serverRequest(method: string, params?: unknown): ZcodeProtocolServerRequest {
  return { kind: 'server-request', id: 'server-1', method, params }
}

const permissionParams = {
  requestId: 'req-1',
  sessionId: 'sess-1',
  toolCallId: 'call-1',
  toolName: 'Bash',
  reason: 'run a command',
  riskLevel: 'high',
  options: [
    {
      optionId: 'allow_once',
      kind: 'allow_once',
      name: 'Allow once',
      response: { decision: 'allow' }
    }
  ]
}

const userInputParams = {
  requestId: 'req-2',
  sessionId: 'sess-1',
  questions: [
    {
      question: 'Continue?',
      header: 'Confirm',
      options: [{ value: 'yes', label: 'Yes' }]
    }
  ]
}

describe('Zcode server request dispositions', () => {
  it.each([
    [ZCODE_INTERACTION_METHODS.requestPermission, permissionParams, 'permission-prompt'],
    [ZCODE_INTERACTION_METHODS.requestUserInput, userInputParams, 'user-input-prompt'],
    [
      ZCODE_SERVER_REQUEST_METHODS.requestRuntimePreferences,
      { sessionId: 'sess-1', scope: 'runtime-materialization' },
      'runtime-preferences'
    ]
  ] as const)('routes %s to %s', (method, params, kind) => {
    expect(disposeZcodeServerRequest(serverRequest(method, params))).toEqual({ kind })
  })

  it.each(['browser/list', 'workspace/updateOffPeakToolPolicy'])(
    'auto-denies unrecognized method %s with the method named in the reason',
    (method) => {
      const disposition = disposeZcodeServerRequest(serverRequest(method, { opaque: true }))

      expect(disposition).toMatchObject({
        kind: 'auto-deny',
        reason: expect.stringContaining(method)
      })
    }
  )

  it('never auto-denies session/requestRuntimePreferences, whose timeout fails session/create', () => {
    for (const scope of ['runtime-materialization', 'user-execution'] as const) {
      const disposition = disposeZcodeServerRequest(
        serverRequest(ZCODE_SERVER_REQUEST_METHODS.requestRuntimePreferences, {
          sessionId: 'sess-1',
          scope
        })
      )

      expect(disposition).toEqual({ kind: 'runtime-preferences' })
      expect(disposition.kind).not.toBe('auto-deny')
    }
    // Even a frame with no params at all stays answerable rather than denied.
    expect(
      disposeZcodeServerRequest(
        serverRequest(ZCODE_SERVER_REQUEST_METHODS.requestRuntimePreferences)
      ).kind
    ).toBe('runtime-preferences')
  })
})

describe('zcodeRuntimePreferencesResponse', () => {
  // Field set mirrors zcodeSessionRuntimePreferencesResultSchema (ZCode repo
  // packages/shared/src/zcode-protocol/index.ts): the schema is .strict(), so
  // any key outside these five fails validation on the CLI side.
  const SCHEMA_FIELDS = [
    'nativeSearchEnhancementsEnabled',
    'memoryEnabled',
    'askUserQuestionAutoResolutionEnabled',
    'integratedTerminalShell',
    'modelContextBudgetStrategy'
  ]

  it('matches the spike-proven reply that let session/create complete', () => {
    expect(zcodeRuntimePreferencesResponse()).toEqual({
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: true,
      modelContextBudgetStrategy: 'preflight-v1'
    })
  })

  it('stays inside the strict schema field set with schema-typed values', () => {
    const response = zcodeRuntimePreferencesResponse()

    for (const key of Object.keys(response)) {
      expect(SCHEMA_FIELDS).toContain(key)
    }
    expect(typeof response.nativeSearchEnhancementsEnabled).toBe('boolean')
    expect(typeof response.memoryEnabled).toBe('boolean')
    expect(typeof response.askUserQuestionAutoResolutionEnabled).toBe('boolean')
    expect(['legacy', 'preflight-v1']).toContain(response.modelContextBudgetStrategy)
  })

  it('returns a fresh object per call', () => {
    const first = zcodeRuntimePreferencesResponse()
    const second = zcodeRuntimePreferencesResponse()

    expect(first).not.toBe(second)
    first.nativeSearchEnhancementsEnabled = true
    expect(second.nativeSearchEnhancementsEnabled).toBe(false)
  })
})
