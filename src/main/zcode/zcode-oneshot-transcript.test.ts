import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseZcodeOneShotTranscript } from './zcode-oneshot-transcript'

const readOneshotFixture = (): string =>
  readFileSync(new URL('./fixtures/oneshot-transcript.ndjson', import.meta.url), 'utf8')

const envelopeLine = (type: string, seq: number): string =>
  JSON.stringify({
    eventId: `event-${seq}`,
    sessionId: 'sess_fixture',
    seq,
    timestamp: 1790155067850 + seq,
    type,
    payload: {}
  })

const resultLine = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'result',
    sessionId: 'sess_fixture',
    traceId: 'trace_fixture',
    turnId: 'turn_fixture',
    response: 'ok',
    usage: {
      source: 'provider',
      modelRequestCount: 1,
      inputTokens: 32090,
      outputTokens: 14,
      totalTokens: 32104,
      cacheReadTokens: 2368
    },
    eventCount: 25,
    projection: {
      status: 'idle',
      turnCount: 1,
      totalTokenCount: 32104,
      contextUsed: 32104,
      contextWindow: 200000
    },
    ...overrides
  })

describe('parseZcodeOneShotTranscript', () => {
  it('parses the captured real-binary transcript end to end', () => {
    const parsed = parseZcodeOneShotTranscript(readOneshotFixture())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }
    expect(parsed.result).toMatchObject({
      sessionId: expect.stringMatching(/^sess_/),
      response: 'ok',
      eventCount: 25
    })
    expect(parsed.result.usage).toMatchObject({
      inputTokens: 32090,
      outputTokens: 14,
      totalTokens: 32104
    })
    expect(parsed.result.projection).toMatchObject({ status: 'idle', turnCount: 1 })
    // 27 captured lines minus the terminal result row; zcode's own eventCount
    // (25) uses its internal projection count, not the emitted line count.
    expect(parsed.events).toHaveLength(26)
    expect(parsed.events[0]?.type).toBe('session.titleUpdated')
    expect(parsed.events[1]?.type).toBe('turn.started')
    expect(parsed.events.at(-1)?.type).toBe('turn.completed')
  })

  it('keeps unknown event types as opaque events instead of rejecting them', () => {
    const parsed = parseZcodeOneShotTranscript(
      `${envelopeLine('turn.started', 1)}\n${envelopeLine('future.eventKind', 2)}\n${resultLine()}\n`
    )
    expect(parsed).toMatchObject({
      ok: true,
      events: [{ type: 'turn.started' }, { type: 'future.eventKind' }]
    })
  })

  it('tolerates blank padding lines around the events', () => {
    const parsed = parseZcodeOneShotTranscript(
      `\n${envelopeLine('turn.started', 1)}\n\n${resultLine()}\n\n`
    )
    expect(parsed).toMatchObject({ ok: true, events: [{ type: 'turn.started' }] })
  })

  it('rejects a transcript whose result line is not terminal', () => {
    const parsed = parseZcodeOneShotTranscript(
      `${resultLine()}\n${envelopeLine('turn.started', 1)}\n`
    )
    expect(parsed).toMatchObject({
      ok: false,
      error: expect.stringContaining('follows the result line')
    })
  })

  it('rejects a transcript with no result line', () => {
    const parsed = parseZcodeOneShotTranscript(`${envelopeLine('turn.started', 1)}\n`)
    expect(parsed).toMatchObject({
      ok: false,
      error: expect.stringContaining('without a result line')
    })
  })

  it('rejects a malformed JSON line rather than skipping it', () => {
    const parsed = parseZcodeOneShotTranscript(`not json\n${resultLine()}\n`)
    expect(parsed).toMatchObject({ ok: false, error: expect.stringContaining('not valid JSON') })
  })

  it('rejects an event line without envelope ids', () => {
    const parsed = parseZcodeOneShotTranscript(
      `${JSON.stringify({ type: 'turn.started' })}\n${resultLine()}\n`
    )
    expect(parsed).toMatchObject({
      ok: false,
      error: expect.stringContaining('not a session event or result line')
    })
  })

  it('rejects a result line without a session id or response', () => {
    expect(parseZcodeOneShotTranscript(`${resultLine({ sessionId: '' })}\n`)).toMatchObject({
      ok: false,
      error: expect.stringContaining('no sessionId')
    })
    expect(parseZcodeOneShotTranscript(`${resultLine({ response: 42 })}\n`)).toMatchObject({
      ok: false,
      error: expect.stringContaining('no response string')
    })
  })

  it('keeps an empty response parseable so the caller can surface it', () => {
    const parsed = parseZcodeOneShotTranscript(`${resultLine({ response: '' })}\n`)
    expect(parsed).toMatchObject({ ok: true, result: { response: '' } })
  })

  it('omits usage and projection when the result line carries neither', () => {
    const parsed = parseZcodeOneShotTranscript(
      `${resultLine({ usage: undefined, projection: undefined, eventCount: undefined })}\n`
    )
    expect(parsed).toMatchObject({ ok: true, result: { response: 'ok' } })
    if (parsed.ok) {
      expect(parsed.result.usage).toBeUndefined()
      expect(parsed.result.projection).toBeUndefined()
      expect(parsed.result.eventCount).toBeUndefined()
    }
  })

  it('rejects the empty string outright', () => {
    expect(parseZcodeOneShotTranscript('')).toMatchObject({
      ok: false,
      error: expect.stringContaining('without a result line')
    })
  })
})
