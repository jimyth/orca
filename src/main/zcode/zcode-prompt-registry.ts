import { ZCODE_INTERACTION_METHODS, type ZcodeProtocolRequestId } from './zcode-protocol'
import {
  MAX_ZCODE_PROMPT_REGISTRY_BYTES,
  MAX_ZCODE_PROMPT_REGISTRY_ENTRIES,
  readZcodeParamString,
  readZcodePermissionInput,
  readZcodePermissionOptions,
  readZcodeUserInputQuestions,
  type ZcodePromptOption,
  type ZcodePromptQuestion,
  zcodePromptRegistryEntryBytes
} from './zcode-prompt-registry-bounds'

export {
  MAX_ZCODE_PROMPT_REGISTRY_BYTES,
  MAX_ZCODE_PROMPT_REGISTRY_ENTRIES,
  ZCODE_PROMPT_MAX_INPUT_BYTES,
  zcodePromptRegistryEntryBytes
} from './zcode-prompt-registry-bounds'

export type ZcodePendingPrompt = {
  /** Wire id of the latest frame carrying this requestId; refreshed per resend. */
  frameId: ZcodeProtocolRequestId
  /** Stable identity from params — the CLI reuses it across 1s resends. */
  requestId: string
  method: string
  sessionId: string
  turnId: string | null
  toolCallId: string | null
  toolName: string | null
  reason: string
  riskLevel: string | null
  /** Serialized permission input (params.input), truncated to the input byte cap. */
  input: string | null
  options: readonly ZcodePromptOption[]
  questions: readonly ZcodePromptQuestion[]
  answers: Map<string, string>
}

export type ZcodePromptClaim = {
  readonly sessionId: string
  readonly requestId: string
  readonly prompt: ZcodePendingPrompt
}

export type ZcodePromptKind = 'permission' | 'user-input'

export function isZcodePromptMethod(method: string): boolean {
  return (
    method === ZCODE_INTERACTION_METHODS.requestPermission ||
    method === ZCODE_INTERACTION_METHODS.requestUserInput
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Session-local callback ownership; none of this state survives a restart. */
export class ZcodePromptRegistry {
  private readonly byAddress = new Map<string, ZcodePendingPrompt>()
  private readonly claims = new Map<ZcodePendingPrompt, ZcodePromptClaim>()

  get sizes(): { prompts: number } {
    return { prompts: this.byAddress.size }
  }

  get bytes(): number {
    let total = 0
    for (const prompt of this.byAddress.values()) {
      total += zcodePromptRegistryEntryBytes(prompt)
    }
    return total
  }

  register(request: {
    id: ZcodeProtocolRequestId
    method: string
    params: unknown
  }): ZcodePendingPrompt | null {
    if (!isZcodePromptMethod(request.method)) {
      return null
    }
    const requestId = readZcodeParamString(request.params, 'requestId')
    const sessionId = readZcodeParamString(request.params, 'sessionId')
    if (!requestId || !sessionId) {
      return null
    }
    // Why: unlike codex, the CLI re-sends the same params.requestId every 1s
    // until answered, so a known id must return the existing prompt (with its
    // wire id refreshed) instead of forking a second pending ask.
    const address = this.address(sessionId, requestId)
    const existing = this.byAddress.get(address)
    if (existing) {
      // A frame reusing a live requestId under a different method is malformed
      // and must not refresh the wire id of the prompt actually pending.
      if (existing.method !== request.method) {
        return null
      }
      existing.frameId = request.id
      // Mirror codex's delete+set: re-insertion keeps a resent prompt at the
      // fresh end of the FIFO eviction order instead of aging out mid-ask.
      this.byAddress.delete(address)
      this.byAddress.set(address, existing)
      return existing
    }
    const isPermission = request.method === ZCODE_INTERACTION_METHODS.requestPermission
    const options = isPermission ? readZcodePermissionOptions(request.params) : []
    // Why: the schema demands permission options min(1); an empty set (missing,
    // malformed, or all-invalid entries) leaves a prompt nothing to answer with,
    // so refuse registration — the caller turns the refusal into -32602.
    if (options === null || (isPermission && options.length === 0)) {
      return null
    }
    const input = isPermission ? readZcodePermissionInput(request.params) : null
    const questions =
      request.method === ZCODE_INTERACTION_METHODS.requestUserInput
        ? readZcodeUserInputQuestions(request.params)
        : []
    if (questions === null) {
      return null
    }
    const riskLevelRaw = isRecord(request.params) ? request.params.riskLevel : undefined
    const prompt: ZcodePendingPrompt = {
      frameId: request.id,
      requestId,
      method: request.method,
      sessionId,
      turnId: readZcodeParamString(request.params, 'turnId'),
      toolCallId: readZcodeParamString(request.params, 'toolCallId'),
      toolName: readZcodeParamString(request.params, 'toolName'),
      reason:
        readZcodeParamString(request.params, 'reason') ??
        readZcodeParamString(request.params, 'prompt') ??
        '',
      riskLevel: typeof riskLevelRaw === 'string' ? riskLevelRaw : null,
      input,
      options,
      questions,
      answers: new Map()
    }
    const promptBytes = zcodePromptRegistryEntryBytes(prompt)
    if (promptBytes > MAX_ZCODE_PROMPT_REGISTRY_BYTES) {
      return null
    }
    while (this.bytes + promptBytes > MAX_ZCODE_PROMPT_REGISTRY_BYTES && this.byAddress.size > 0) {
      const oldest = this.byAddress.values().next().value
      if (!oldest) {
        break
      }
      this.byAddress.delete(this.address(oldest.sessionId, oldest.requestId))
    }
    if (this.bytes + promptBytes > MAX_ZCODE_PROMPT_REGISTRY_BYTES) {
      return null
    }
    this.byAddress.set(address, prompt)
    this.trim()
    return prompt
  }

  find(sessionId: string, requestId: string): ZcodePendingPrompt | null {
    return this.byAddress.get(this.address(sessionId, requestId)) ?? null
  }

  claim(sessionId: string, requestId: string, kind?: ZcodePromptKind): ZcodePromptClaim | null {
    const prompt = this.find(sessionId, requestId)
    if (!prompt || this.claims.has(prompt) || (kind && this.kind(prompt) !== kind)) {
      return null
    }
    const claim = { sessionId, requestId, prompt }
    this.claims.set(prompt, claim)
    return claim
  }

  ownsClaim(claim: ZcodePromptClaim): boolean {
    return (
      this.claims.get(claim.prompt) === claim &&
      this.find(claim.sessionId, claim.requestId) === claim.prompt
    )
  }

  releaseClaim(claim: ZcodePromptClaim): void {
    if (this.claims.get(claim.prompt) === claim) {
      this.claims.delete(claim.prompt)
    }
  }

  forget(prompt: ZcodePendingPrompt): void {
    this.claims.delete(prompt)
    const address = this.address(prompt.sessionId, prompt.requestId)
    if (this.byAddress.get(address) === prompt) {
      this.byAddress.delete(address)
    }
  }

  clearTurn(sessionId: string, turnId: string): void {
    const prompts = new Set(
      [...this.byAddress.values(), ...this.claims.keys()].filter(
        (prompt) => prompt.sessionId === sessionId && prompt.turnId === turnId
      )
    )
    for (const prompt of prompts) {
      this.forget(prompt)
    }
  }

  clear(): void {
    this.byAddress.clear()
    this.claims.clear()
  }

  private address(sessionId: string, requestId: string): string {
    return `${encodeURIComponent(sessionId)}:${encodeURIComponent(requestId)}`
  }

  private kind(prompt: ZcodePendingPrompt): ZcodePromptKind {
    return prompt.method === ZCODE_INTERACTION_METHODS.requestUserInput
      ? 'user-input'
      : 'permission'
  }

  private trim(): void {
    while (this.byAddress.size > MAX_ZCODE_PROMPT_REGISTRY_ENTRIES) {
      const oldest = this.byAddress.values().next().value
      if (!oldest) {
        break
      }
      this.byAddress.delete(this.address(oldest.sessionId, oldest.requestId))
    }
  }
}
