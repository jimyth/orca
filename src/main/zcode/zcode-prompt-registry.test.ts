import { describe, expect, it } from 'vitest'
import { ZCODE_INTERACTION_METHODS } from './zcode-protocol'
import {
  MAX_ZCODE_PROMPT_REGISTRY_BYTES,
  MAX_ZCODE_PROMPT_REGISTRY_ENTRIES,
  ZcodePromptRegistry,
  type ZcodePendingPrompt,
  type ZcodePromptClaim
} from './zcode-prompt-registry'

type PermissionRequestOverrides = {
  requestId?: string
  sessionId?: string
  turnId?: string | null
  toolCallId?: string
  reason?: string
}

function permissionRequest(
  index: number,
  overrides: PermissionRequestOverrides = {}
): { id: string; method: string; params: unknown } {
  return {
    id: `server-${index}`,
    method: ZCODE_INTERACTION_METHODS.requestPermission,
    params: {
      requestId: overrides.requestId ?? `req-${index}`,
      sessionId: overrides.sessionId ?? 'sess-1',
      turnId: overrides.turnId === undefined ? 'turn-1' : overrides.turnId,
      toolCallId: overrides.toolCallId ?? `call-${index}`,
      toolName: 'Bash',
      reason: overrides.reason ?? `run command ${index}`,
      riskLevel: 'medium',
      options: [
        {
          optionId: 'allow_once',
          kind: 'allow_once',
          name: 'Allow once',
          response: { decision: 'allow' }
        },
        {
          optionId: 'deny',
          kind: 'deny',
          name: 'Deny',
          response: { decision: 'deny' }
        }
      ]
    }
  }
}

function userInputRequest(
  index: number,
  requestId = `user-req-${index}`
): { id: string; method: string; params: unknown } {
  return {
    id: `server-${index}`,
    method: ZCODE_INTERACTION_METHODS.requestUserInput,
    params: {
      requestId,
      sessionId: 'sess-1',
      turnId: 'turn-1',
      prompt: 'Pick a deploy target',
      questions: [
        {
          question: 'Which environment?',
          header: 'Environment',
          multiSelect: false,
          options: [
            { value: 'staging', label: 'Staging' },
            { value: 'prod', label: 'Production' }
          ]
        }
      ]
    }
  }
}

function registerPermission(
  registry: ZcodePromptRegistry,
  index: number,
  overrides: PermissionRequestOverrides = {}
): ZcodePendingPrompt {
  const prompt = registry.register(permissionRequest(index, overrides))
  if (!prompt) {
    throw new Error('Fixture prompt was refused')
  }
  return prompt
}

function claimOrThrow(claim: ZcodePromptClaim | null): ZcodePromptClaim {
  if (!claim) {
    throw new Error('Fixture prompt could not be claimed')
  }
  return claim
}

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

// Keeps no strong reference reachable from the test body across gc rounds.
function registerAndClaim(
  registry: ZcodePromptRegistry,
  index: number,
  overrides: PermissionRequestOverrides = {}
): WeakRef<ZcodePendingPrompt> {
  const prompt = registerPermission(registry, index, overrides)
  claimOrThrow(registry.claim(prompt.sessionId, prompt.requestId))
  return new WeakRef(prompt)
}

describe('ZcodePromptRegistry', () => {
  it('ignores a request that is not an interaction prompt or names no stable identity', () => {
    const registry = new ZcodePromptRegistry()

    expect(
      registry.register({
        id: 'server-1',
        method: 'session/requestRuntimePreferences',
        params: { sessionId: 'sess-1', scope: 'runtime-materialization' }
      })
    ).toBeNull()
    expect(
      registry.register({
        id: 'server-2',
        method: 'browser/list',
        params: { requestId: 'req-1', sessionId: 'sess-1' }
      })
    ).toBeNull()
    expect(
      registry.register({
        id: 'server-3',
        method: ZCODE_INTERACTION_METHODS.requestPermission,
        params: {}
      })
    ).toBeNull()
    expect(
      registry.register({
        id: 'server-4',
        method: ZCODE_INTERACTION_METHODS.requestPermission,
        params: { requestId: 'req-1' }
      })
    ).toBeNull()
    expect(
      registry.register({
        id: 'server-5',
        method: ZCODE_INTERACTION_METHODS.requestPermission,
        params: { sessionId: 'sess-1' }
      })
    ).toBeNull()
    expect(registry.sizes).toEqual({ prompts: 0 })
  })

  it('returns the existing prompt when the CLI re-sends a known requestId', () => {
    const registry = new ZcodePromptRegistry()
    const first = registerPermission(registry, 1, { requestId: 'req-1' })

    // The CLI re-sends the same params.requestId every 1s until answered, each
    // resend under a fresh wire id; a second prompt would fork the pending ask.
    const resent = registry.register(permissionRequest(99, { requestId: 'req-1' }))

    expect(resent).toBe(first)
    expect(resent?.frameId).toBe('server-99')
    expect(registry.sizes).toEqual({ prompts: 1 })
  })

  it('keeps two prompts that share one tool call apart', () => {
    const registry = new ZcodePromptRegistry()
    registerPermission(registry, 1, { requestId: 'req-a', toolCallId: 'call-1' })
    registerPermission(registry, 2, { requestId: 'req-b', toolCallId: 'call-1' })

    expect(registry.find('sess-1', 'req-a')?.requestId).toBe('req-a')
    expect(registry.find('sess-1', 'req-b')?.requestId).toBe('req-b')
    expect(registry.sizes).toEqual({ prompts: 2 })
  })

  it('claims a prompt exclusively and releases it for the next claimant', () => {
    const registry = new ZcodePromptRegistry()
    registerPermission(registry, 1, { requestId: 'req-1' })
    const claim = claimOrThrow(registry.claim('sess-1', 'req-1'))

    expect(claim.prompt.requestId).toBe('req-1')
    expect(registry.claim('sess-1', 'req-1')).toBeNull()
    expect(registry.claim('sess-1', 'req-1', 'user-input')).toBeNull()
    expect(registry.ownsClaim(claim)).toBe(true)

    registry.releaseClaim(claim)
    expect(registry.claim('sess-1', 'req-1')).not.toBeNull()
  })

  it('rejects a claim whose kind does not match the prompt method', () => {
    const registry = new ZcodePromptRegistry()
    const permission = registry.register(permissionRequest(1, { requestId: 'req-1' }))
    const userInput = registry.register(userInputRequest(2, 'user-req-2'))

    expect(registry.claim('sess-1', 'req-1', 'permission')?.prompt).toBe(permission)
    expect(registry.claim('sess-1', 'user-req-2', 'user-input')?.prompt).toBe(userInput)
    expect(registry.claim('sess-1', 'user-req-2', 'permission')).toBeNull()
  })

  it('forgets a prompt, dropping its claim and address', () => {
    const registry = new ZcodePromptRegistry()
    const prompt = registerPermission(registry, 1, { requestId: 'req-1' })
    const claim = claimOrThrow(registry.claim('sess-1', 'req-1'))

    registry.forget(prompt)

    expect(registry.find('sess-1', 'req-1')).toBeNull()
    expect(registry.ownsClaim(claim)).toBe(false)
    expect(registry.sizes).toEqual({ prompts: 0 })
  })

  it('clears only prompts belonging to a settled session turn', () => {
    const registry = new ZcodePromptRegistry()
    registerPermission(registry, 1, { requestId: 'req-turn-1', turnId: 'turn-1' })
    registerPermission(registry, 2, { requestId: 'req-turn-2', turnId: 'turn-2' })
    registerPermission(registry, 3, {
      requestId: 'req-other-session',
      sessionId: 'sess-2',
      turnId: 'turn-1'
    })
    registerPermission(registry, 4, { requestId: 'req-turnless', turnId: null })

    registry.clearTurn('sess-1', 'turn-1')

    expect(registry.find('sess-1', 'req-turn-1')).toBeNull()
    expect(registry.find('sess-1', 'req-turn-2')).not.toBeNull()
    expect(registry.find('sess-2', 'req-other-session')).not.toBeNull()
    expect(registry.find('sess-1', 'req-turnless')).not.toBeNull()
  })

  it('bounds retained prompts to the entry cap, evicting the oldest first', () => {
    const registry = new ZcodePromptRegistry()
    registerPermission(registry, 0, { requestId: 'req-oldest' })
    for (let index = 1; index < MAX_ZCODE_PROMPT_REGISTRY_ENTRIES; index += 1) {
      registerPermission(registry, index)
    }
    expect(registry.sizes).toEqual({ prompts: MAX_ZCODE_PROMPT_REGISTRY_ENTRIES })

    registerPermission(registry, 5_000, { requestId: 'req-newest' })

    expect(registry.find('sess-1', 'req-oldest')).toBeNull()
    expect(registry.find('sess-1', 'req-newest')).not.toBeNull()
    expect(registry.sizes).toEqual({ prompts: MAX_ZCODE_PROMPT_REGISTRY_ENTRIES })
  })

  it('refuses a single prompt larger than the registry byte cap', () => {
    const registry = new ZcodePromptRegistry()

    expect(
      registry.register(
        permissionRequest(1, {
          requestId: 'req-huge',
          reason: 'r'.repeat(MAX_ZCODE_PROMPT_REGISTRY_BYTES)
        })
      )
    ).toBeNull()
    expect(registry.sizes).toEqual({ prompts: 0 })
  })

  it('evicts old prompts to fit a new one within the byte cap', () => {
    const registry = new ZcodePromptRegistry()
    const reason = 'r'.repeat(Math.floor(MAX_ZCODE_PROMPT_REGISTRY_BYTES / 3))
    registerPermission(registry, 1, { requestId: 'req-old-1', reason })
    registerPermission(registry, 2, { requestId: 'req-old-2', reason })

    const accepted = registry.register(permissionRequest(3, { requestId: 'req-new', reason }))

    expect(accepted).not.toBeNull()
    expect(registry.find('sess-1', 'req-old-1')).toBeNull()
    expect(registry.find('sess-1', 'req-old-2')).not.toBeNull()
    expect(registry.find('sess-1', 'req-new')).not.toBeNull()
  })

  it('retains malformed interaction params as bounded, empty prompt surfaces', () => {
    const registry = new ZcodePromptRegistry()

    const permission = registry.register({
      id: 'server-1',
      method: ZCODE_INTERACTION_METHODS.requestPermission,
      params: { requestId: 'req-1', sessionId: 'sess-1', options: 'not-an-array' }
    })
    const userInput = registry.register({
      id: 'server-2',
      method: ZCODE_INTERACTION_METHODS.requestUserInput,
      params: {
        requestId: 'user-req-2',
        sessionId: 'sess-1',
        questions: [
          {
            question: 'Which environment?',
            header: 'Environment',
            options: [
              { value: '', label: 'empty value is skipped' },
              { value: 'yes', label: 'Yes' }
            ]
          }
        ]
      }
    })

    expect(permission?.options).toEqual([])
    expect(userInput?.questions[0]?.options).toEqual([{ value: 'yes', label: 'Yes' }])
  })

  it('releases an evicted claim only when its exact session turn completes', async () => {
    const registry = new ZcodePromptRegistry()
    const reference = registerAndClaim(registry, 1, { requestId: 'req-1' })
    for (let index = 0; index < MAX_ZCODE_PROMPT_REGISTRY_ENTRIES; index += 1) {
      registerPermission(registry, index + 1_000, { sessionId: 'sess-2', turnId: 'turn-2' })
    }
    expect(registry.find('sess-1', 'req-1')).toBeNull()

    registry.clearTurn('sess-2', 'turn-2')
    await collect()
    expect(reference.deref()).toBeDefined()

    registry.clearTurn('sess-1', 'turn-1')
    await collect()
    expect(reference.deref()).toBeUndefined()
  })

  it('releases every prompt when the registry is cleared', async () => {
    const registry = new ZcodePromptRegistry()
    const reference = registerAndClaim(registry, 1, { requestId: 'req-1' })

    registry.clear()
    await collect()

    expect(reference.deref()).toBeUndefined()
    expect(registry.sizes).toEqual({ prompts: 0 })
  })
})
