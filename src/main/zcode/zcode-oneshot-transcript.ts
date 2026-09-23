import type { ZcodeSessionEventEnvelope } from './zcode-protocol'
import { readZcodeSessionEventEnvelope } from './zcode-structured-session-reflow'

// `zcode -p "<prompt>" --output-format stream-json` writes one JSON object per
// stdout line: enveloped session events, then a bare `{"type":"result",...}` row
// that terminates the run. Unlike claude's one-shot stream-json there is no
// shared shape, so this parser owns the zcode contract.

export type ZcodeOneShotUsage = {
  source?: string
  modelRequestCount?: number
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

export type ZcodeOneShotProjection = {
  status?: string
  turnCount?: number
  totalTokenCount?: number
  contextUsed?: number
  contextWindow?: number
}

export type ZcodeOneShotResult = {
  sessionId: string
  traceId?: string
  turnId?: string
  response: string
  usage?: ZcodeOneShotUsage
  eventCount?: number
  projection?: ZcodeOneShotProjection
}

export type ZcodeOneShotTranscript =
  | { ok: true; result: ZcodeOneShotResult; events: ZcodeSessionEventEnvelope[] }
  | { ok: false; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readUsage(value: unknown): ZcodeOneShotUsage | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const usage: ZcodeOneShotUsage = {}
  const source = readOptionalString(value.source)
  if (source) {
    usage.source = source
  }
  for (const key of [
    'modelRequestCount',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'cacheReadTokens',
    'cacheWriteTokens',
    'reasoningTokens'
  ] as const) {
    const tokenCount = value[key]
    if (typeof tokenCount === 'number' && Number.isFinite(tokenCount)) {
      usage[key] = tokenCount
    }
  }
  return Object.keys(usage).length > 0 ? usage : undefined
}

function readProjection(value: unknown): ZcodeOneShotProjection | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const projection: ZcodeOneShotProjection = {}
  const status = readOptionalString(value.status)
  if (status) {
    projection.status = status
  }
  for (const key of ['turnCount', 'totalTokenCount', 'contextUsed', 'contextWindow'] as const) {
    const metric = value[key]
    if (typeof metric === 'number' && Number.isFinite(metric)) {
      projection[key] = metric
    }
  }
  return Object.keys(projection).length > 0 ? projection : undefined
}

function readResultLine(parsed: Record<string, unknown>): ZcodeOneShotResult | { error: string } {
  const sessionId = readOptionalString(parsed.sessionId)
  if (!sessionId) {
    return { error: 'result line has no sessionId' }
  }
  if (typeof parsed.response !== 'string') {
    return { error: 'result line has no response string' }
  }
  const traceId = readOptionalString(parsed.traceId)
  const turnId = readOptionalString(parsed.turnId)
  const usage = readUsage(parsed.usage)
  const projection = readProjection(parsed.projection)
  const eventCount = parsed.eventCount
  return {
    sessionId,
    ...(traceId ? { traceId } : {}),
    ...(turnId ? { turnId } : {}),
    response: parsed.response,
    ...(usage ? { usage } : {}),
    ...(typeof eventCount === 'number' && Number.isFinite(eventCount) ? { eventCount } : {}),
    ...(projection ? { projection } : {})
  }
}

/** Parses the full stdout of a `zcode -p --output-format stream-json` run. Any
 *  line that is neither a valid session-event envelope nor the terminal result
 *  row is a protocol drift the caller must not silently ignore. */
export function parseZcodeOneShotTranscript(stdout: string): ZcodeOneShotTranscript {
  const events: ZcodeSessionEventEnvelope[] = []
  let result: ZcodeOneShotResult | null = null
  const lines = stdout.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line.length === 0) {
      continue
    }
    if (result) {
      return { ok: false, error: `line ${index + 1} follows the result line` }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return { ok: false, error: `line ${index + 1} is not valid JSON` }
    }
    if (!isRecord(parsed)) {
      return { ok: false, error: `line ${index + 1} is not a JSON object` }
    }
    if (parsed.type === 'result') {
      const read = readResultLine(parsed)
      if ('error' in read) {
        return { ok: false, error: `line ${index + 1}: ${read.error}` }
      }
      result = read
      continue
    }
    const envelope = readZcodeSessionEventEnvelope(parsed)
    if (!envelope) {
      return { ok: false, error: `line ${index + 1} is not a session event or result line` }
    }
    events.push(envelope)
  }
  if (!result) {
    return { ok: false, error: 'transcript ended without a result line' }
  }
  return { ok: true, result, events }
}
