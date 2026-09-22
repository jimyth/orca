import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  isZcodeAppServerMethodNotFoundError,
  parseZcodeProtocolFrame,
  zcodeSessionIdFromCreateResult,
  ZCODE_NOTIFICATION_METHODS,
  ZCODE_SERVER_REQUEST_METHODS
} from './zcode-protocol'

type WrappedTranscriptLine = { direction: string; [key: string]: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readSpikeTranscript = (): WrappedTranscriptLine[] =>
  readFileSync(new URL('./fixtures/spike-session-transcript.ndjson', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line): WrappedTranscriptLine => JSON.parse(line))

const readSessionEvents = (): Record<string, unknown>[] =>
  readSpikeTranscript().flatMap((line): Record<string, unknown>[] =>
    line.method === 'session/event' && isRecord(line.params) ? [line.params] : []
  )

describe('parseZcodeProtocolFrame', () => {
  it('discriminates responses before requests (both carry id)', () => {
    expect(parseZcodeProtocolFrame('{"id":1,"result":{"ok":true}}')).toMatchObject({
      kind: 'response',
      id: 1
    })
    expect(
      parseZcodeProtocolFrame('{"id":2,"error":{"code":-32601,"message":"nope"}}')
    ).toMatchObject({ kind: 'error', id: 2 })
    expect(
      parseZcodeProtocolFrame('{"id":3,"method":"interaction/requestPermission","params":{}}')
    ).toMatchObject({ kind: 'server-request', id: 3 })
    expect(parseZcodeProtocolFrame('{"method":"session/event","params":{}}')).toMatchObject({
      kind: 'notification'
    })
  })

  it('accepts string ids on server requests (spike saw "server-1")', () => {
    expect(
      parseZcodeProtocolFrame('{"id":"server-1","method":"session/requestRuntimePreferences"}')
    ).toMatchObject({ kind: 'server-request', id: 'server-1' })
  })

  it('returns null on malformed json rather than throwing', () => {
    expect(parseZcodeProtocolFrame('not json')).toBeNull()
  })

  it('returns null on empty or whitespace-only lines', () => {
    expect(parseZcodeProtocolFrame('')).toBeNull()
    expect(parseZcodeProtocolFrame('   ')).toBeNull()
  })

  it('strips a trailing CR from CRLF frames', () => {
    expect(parseZcodeProtocolFrame('{"method":"session/event"}\r')).toMatchObject({
      kind: 'notification'
    })
  })

  it('parses every real spike transcript line', () => {
    for (const wrapped of readSpikeTranscript()) {
      const { direction: _d, ...frame } = wrapped
      expect(parseZcodeProtocolFrame(JSON.stringify(frame))).not.toBeNull()
    }
  })

  it('names the storage gate notification', () => {
    expect(ZCODE_NOTIFICATION_METHODS.storageState).toBe('startup/storageState')
  })

  it('names the must-answer runtime preferences server request', () => {
    expect(ZCODE_SERVER_REQUEST_METHODS.requestRuntimePreferences).toBe(
      'session/requestRuntimePreferences'
    )
  })
})

describe('zcodeSessionIdFromCreateResult', () => {
  it('reads the real session id from the spike session/create result', () => {
    const created = readSpikeTranscript().find(
      (line) => line.direction === 'in' && line.id === 1 && 'result' in line
    )
    expect(created).toBeDefined()
    expect(zcodeSessionIdFromCreateResult(created?.result)).toBe(
      'sess_e2d0e231-d28d-4ffc-b4a8-4fba6aaff29f'
    )
  })

  it('returns null when only the projection placeholder exists', () => {
    expect(zcodeSessionIdFromCreateResult({ projection: { sessionId: 'unknown' } })).toBeNull()
    expect(zcodeSessionIdFromCreateResult({ session: { sessionId: 'unknown' } })).toBeNull()
  })

  it('returns null on malformed results', () => {
    expect(zcodeSessionIdFromCreateResult(null)).toBeNull()
    expect(zcodeSessionIdFromCreateResult('sess_1')).toBeNull()
    expect(zcodeSessionIdFromCreateResult({ session: 42 })).toBeNull()
  })
})

describe('spike-observed payload shapes', () => {
  it('model.streaming covers exactly the six observed kinds', () => {
    const kinds = new Set<string>()
    for (const event of readSessionEvents()) {
      if (event.type !== 'model.streaming' || !isRecord(event.payload)) {
        continue
      }
      if (typeof event.payload.kind === 'string') {
        kinds.add(event.payload.kind)
      }
    }
    expect(kinds).toEqual(
      new Set([
        'reasoning_delta',
        'text_delta',
        'tool_input_start',
        'tool_input_delta',
        'tool_input_end',
        'tool_call'
      ])
    )
  })

  it('permission options carry prefabricated responses', () => {
    const permissionRequest = readSpikeTranscript().find(
      (line) => line.method === 'interaction/requestPermission'
    )
    expect(permissionRequest).toBeDefined()
    expect(isRecord(permissionRequest?.params)).toBe(true)
    if (!permissionRequest || !isRecord(permissionRequest.params)) {
      throw new Error('fixture lost its interaction/requestPermission frame')
    }
    const options = permissionRequest.params.options
    expect(Array.isArray(options)).toBe(true)
    const optionRecords = (Array.isArray(options) ? options : []).filter(isRecord)
    expect(optionRecords.map((option) => option.optionId)).toEqual([
      'allow_once',
      'allow_project',
      'deny'
    ])
    for (const option of optionRecords) {
      expect(typeof option.optionId).toBe('string')
      expect(typeof option.kind).toBe('string')
      expect(typeof option.name).toBe('string')
      expect(option.response).toMatchObject({ decision: expect.any(String) })
    }
  })
})

describe('isZcodeAppServerMethodNotFoundError', () => {
  it('matches -32601 errors only', () => {
    expect(isZcodeAppServerMethodNotFoundError({ code: -32601, message: 'nope' })).toBe(true)
    expect(isZcodeAppServerMethodNotFoundError({ code: -32602, message: 'nope' })).toBe(false)
    expect(isZcodeAppServerMethodNotFoundError(null)).toBe(false)
    expect(isZcodeAppServerMethodNotFoundError('error')).toBe(false)
  })
})
