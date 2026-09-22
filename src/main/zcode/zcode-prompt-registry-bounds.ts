import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../shared/node-bounded-json-stringify'

// Bounds mirror the codex registry caps: enough headroom for every live prompt
// of a busy session, small enough that a hostile frame cannot balloon memory.
export const MAX_ZCODE_PROMPT_REGISTRY_ENTRIES = 128
export const MAX_ZCODE_PROMPT_REGISTRY_BYTES = 4 * 1024 * 1024
export const ZCODE_PROMPT_MAX_OPTIONS = 256
export const ZCODE_PROMPT_MAX_OPTION_BYTES = 64 * 1024
export const ZCODE_PROMPT_MAX_QUESTIONS = 64
export const ZCODE_PROMPT_MAX_QUESTION_BYTES = 32 * 1024
export const ZCODE_PROMPT_MAX_INPUT_BYTES = 64 * 1024

const ZCODE_PROMPT_INPUT_TRUNCATED_SUFFIX = '…[truncated]'
const ZCODE_PROMPT_UNSERIALIZABLE_INPUT = '[unserializable zcode permission input]'

export type ZcodePromptOption = {
  optionId: string
  kind: string
  name: string
  description: string | null
  /** Prefabricated reply the CLI accepts verbatim when this option is chosen. */
  response: unknown
}

export type ZcodePromptQuestionOption = {
  value: string
  label: string
}

export type ZcodePromptQuestion = {
  question: string
  header: string
  multiSelect: boolean
  options: readonly ZcodePromptQuestionOption[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export function readZcodeParamString(params: unknown, key: string): string | null {
  const value = isRecord(params) ? params[key] : undefined
  return typeof value === 'string' && value.length > 0 ? value : null
}

function jsonBytes(value: unknown): number {
  if (value === null || value === undefined) {
    return 0
  }
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    // Non-serializable payloads cannot come from a parsed frame; treat as oversized.
    return Number.MAX_SAFE_INTEGER
  }
}

/**
 * Bounded serialization of the permission `input` payload — the core content
 * the permission UI shows (e.g. the file about to be written). Oversized
 * values keep a prefix plus a truncation marker; unserializable ones keep a
 * placeholder rather than throwing.
 */
export function readZcodePermissionInput(params: unknown): string | null {
  const raw = isRecord(params) ? params.input : undefined
  if (raw === undefined) {
    return null
  }
  try {
    return stringifyJsonWithinByteLimit(raw, ZCODE_PROMPT_MAX_INPUT_BYTES).serialized
  } catch (error) {
    if (!(error instanceof JsonStringifyByteLimitError)) {
      return ZCODE_PROMPT_UNSERIALIZABLE_INPUT
    }
  }
  let serialized: unknown
  try {
    serialized = JSON.stringify(raw)
  } catch {
    return ZCODE_PROMPT_UNSERIALIZABLE_INPUT
  }
  if (typeof serialized !== 'string') {
    return ZCODE_PROMPT_UNSERIALIZABLE_INPUT
  }
  // Re-encode oversized input so the UI still sees a prefix of what was asked.
  const suffixBytes = Buffer.byteLength(ZCODE_PROMPT_INPUT_TRUNCATED_SUFFIX, 'utf8')
  const head = Buffer.from(serialized, 'utf8')
    .subarray(0, ZCODE_PROMPT_MAX_INPUT_BYTES - suffixBytes)
    .toString('utf8')
  return `${head}${ZCODE_PROMPT_INPUT_TRUNCATED_SUFFIX}`
}

export function readZcodePermissionOptions(params: unknown): ZcodePromptOption[] | null {
  const raw = isRecord(params) ? params.options : undefined
  if (!Array.isArray(raw)) {
    return []
  }
  const options: ZcodePromptOption[] = []
  let bytes = 0
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue
    }
    const optionId = entry.optionId
    const kind = entry.kind
    const name = entry.name
    if (
      typeof optionId !== 'string' ||
      optionId.length === 0 ||
      typeof kind !== 'string' ||
      kind.length === 0 ||
      typeof name !== 'string'
    ) {
      continue
    }
    const description = typeof entry.description === 'string' ? entry.description : null
    const response = isRecord(entry.response) ? entry.response : null
    if (options.length >= ZCODE_PROMPT_MAX_OPTIONS) {
      return null
    }
    bytes +=
      Buffer.byteLength(optionId, 'utf8') +
      Buffer.byteLength(kind, 'utf8') +
      Buffer.byteLength(name, 'utf8') +
      (description ? Buffer.byteLength(description, 'utf8') : 0) +
      jsonBytes(response)
    if (bytes > ZCODE_PROMPT_MAX_OPTION_BYTES) {
      return null
    }
    options.push({ optionId, kind, name, description, response })
  }
  return options
}

export function readZcodeUserInputQuestions(params: unknown): ZcodePromptQuestion[] | null {
  const raw = isRecord(params) ? params.questions : undefined
  if (!Array.isArray(raw)) {
    return []
  }
  const questions: ZcodePromptQuestion[] = []
  let bytes = 0
  let optionCount = 0
  let optionBytes = 0
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue
    }
    const question = entry.question
    const header = entry.header
    if (
      typeof question !== 'string' ||
      question.length === 0 ||
      typeof header !== 'string' ||
      header.length === 0
    ) {
      continue
    }
    if (questions.length >= ZCODE_PROMPT_MAX_QUESTIONS) {
      return null
    }
    bytes += Buffer.byteLength(question, 'utf8') + Buffer.byteLength(header, 'utf8')
    if (bytes > ZCODE_PROMPT_MAX_QUESTION_BYTES) {
      return null
    }
    const options: ZcodePromptQuestionOption[] = []
    if (Array.isArray(entry.options)) {
      for (const option of entry.options) {
        if (!isRecord(option)) {
          continue
        }
        const value = option.value
        const label = option.label
        if (typeof value !== 'string' || value.length === 0 || typeof label !== 'string') {
          continue
        }
        if (++optionCount > ZCODE_PROMPT_MAX_OPTIONS) {
          return null
        }
        optionBytes += Buffer.byteLength(value, 'utf8') + Buffer.byteLength(label, 'utf8')
        if (optionBytes > ZCODE_PROMPT_MAX_OPTION_BYTES) {
          return null
        }
        options.push({ value, label })
      }
    }
    questions.push({ question, header, multiSelect: entry.multiSelect === true, options })
  }
  return questions
}

type ZcodePromptRegistryEntryBounds = {
  sessionId: string
  requestId: string
  method: string
  turnId: string | null
  toolCallId: string | null
  toolName: string | null
  reason: string
  input: string | null
  options: readonly ZcodePromptOption[]
  questions: readonly ZcodePromptQuestion[]
  answers: ReadonlyMap<string, string>
}

export function zcodePromptRegistryEntryBytes(prompt: ZcodePromptRegistryEntryBounds): number {
  let bytes = 0
  const add = (value: string): void => {
    bytes += Buffer.byteLength(value, 'utf8')
  }
  for (const value of [prompt.sessionId, prompt.requestId, prompt.method, prompt.reason]) {
    add(value)
  }
  if (prompt.input) {
    add(prompt.input)
  }
  if (prompt.turnId) {
    add(prompt.turnId)
  }
  if (prompt.toolCallId) {
    add(prompt.toolCallId)
  }
  if (prompt.toolName) {
    add(prompt.toolName)
  }
  for (const option of prompt.options) {
    add(option.optionId)
    add(option.kind)
    add(option.name)
    if (option.description) {
      add(option.description)
    }
    bytes += jsonBytes(option.response)
  }
  for (const question of prompt.questions) {
    add(question.question)
    add(question.header)
    for (const option of question.options) {
      add(option.value)
      add(option.label)
    }
  }
  for (const value of prompt.answers.values()) {
    add(value)
  }
  return bytes
}
