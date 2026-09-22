import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { ZcodeSessionEventEnvelope, ZcodeSessionEventType } from './zcode-protocol'
import {
  translateZcodeSessionEvent,
  type ZcodeJournalTranslation
} from './zcode-structured-journal-translation'

const TIMESTAMP = 1790103642787

const envelope = (
  type: ZcodeSessionEventType,
  payload: unknown,
  overrides: Partial<ZcodeSessionEventEnvelope> = {}
): ZcodeSessionEventEnvelope => ({
  eventId: 'evt-test',
  sessionId: 'sess-test',
  seq: 1,
  timestamp: TIMESTAMP,
  type,
  payload,
  ...overrides
})

const expectNoOtherArms = (
  translation: ZcodeJournalTranslation,
  except: ReadonlySet<keyof ZcodeJournalTranslation>
): void => {
  if (!except.has('appendItems')) {
    expect(translation.appendItems).toHaveLength(0)
  }
  if (!except.has('streamDeltas')) {
    expect(translation.streamDeltas).toHaveLength(0)
  }
  if (!except.has('toolCallUpdates')) {
    expect(translation.toolCallUpdates).toHaveLength(0)
  }
  if (!except.has('genericFrames')) {
    expect(translation.genericFrames).toHaveLength(0)
  }
  if (!except.has('promptResolution')) {
    expect(translation.promptResolution).toBeNull()
  }
  if (!except.has('turnBoundary')) {
    expect(translation.turnBoundary).toBeNull()
  }
}

const permissionRequestPayload = {
  requestId: 'perm-1',
  toolCallId: 'call-1',
  toolName: 'Write',
  riskLevel: 'medium',
  reason: 'Tool has side effects and requires approval',
  input: { file_path: '/tmp/sandbox/a.txt', content: 'hi\n' },
  options: [
    {
      kind: 'allow_once',
      name: 'Allow once',
      optionId: 'allow_once',
      response: { decision: 'allow', reason: 'Approved once' }
    },
    {
      description: 'Do not ask again for matching requests in this project',
      kind: 'allow_always',
      name: 'Always allow in this project',
      optionId: 'allow_project',
      response: { decision: 'allow', reason: 'Approved for this project' }
    },
    {
      kind: 'deny',
      name: 'Deny',
      optionId: 'deny',
      response: { decision: 'deny', reason: 'The user rejected the tool use' }
    }
  ]
}

type MappingCase = {
  name: string
  event: ZcodeSessionEventEnvelope
  check: (translation: ZcodeJournalTranslation) => void
}

describe('translateZcodeSessionEvent mapping table', () => {
  it.each<MappingCase>([
    {
      name: 'turn.started opens a running turn boundary',
      event: envelope(
        'turn.started',
        { input: 'Create a file', messageId: 'msg-user', inputId: 'in-1' },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.turnBoundary).toMatchObject({
          turnId: 'turn-1',
          state: 'running',
          startedAt: TIMESTAMP,
          userMessageId: 'msg-user',
          inputId: 'in-1'
        })
        expectNoOtherArms(translation, new Set(['turnBoundary']))
      }
    },
    {
      name: 'turn.completed with resultType success settles the turn',
      event: envelope(
        'turn.completed',
        { resultType: 'success', response: 'Done.', duration: 7899 },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.turnBoundary).toMatchObject({
          turnId: 'turn-1',
          state: 'completed',
          outcome: 'success',
          completedAt: TIMESTAMP,
          durationMs: 7899
        })
        expectNoOtherArms(translation, new Set(['turnBoundary']))
      }
    },
    {
      name: 'turn.completed with resultType error reports a failure outcome',
      event: envelope(
        'turn.completed',
        { resultType: 'error', duration: 10 },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.turnBoundary).toMatchObject({ state: 'completed', outcome: 'failure' })
      }
    },
    {
      name: 'turn.completed with resultType cancelled reads as interrupted',
      event: envelope(
        'turn.completed',
        { resultType: 'cancelled', duration: 10 },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.turnBoundary).toMatchObject({
          state: 'interrupted',
          outcome: 'cancellation'
        })
      }
    },
    {
      name: 'turn.completed with an unplaced resultType leaves the outcome unknown',
      event: envelope(
        'turn.completed',
        { resultType: 'something-new', duration: 10 },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.turnBoundary).toMatchObject({ state: 'completed' })
        expect(translation.turnBoundary?.outcome).toBeUndefined()
      }
    },
    {
      name: 'turn.failed settles as a failure and surfaces the error frame',
      event: envelope(
        'turn.failed',
        { error: { message: 'provider exploded' } },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.turnBoundary).toMatchObject({
          turnId: 'turn-1',
          state: 'completed',
          outcome: 'failure',
          completedAt: TIMESTAMP
        })
        expect(translation.genericFrames).toHaveLength(1)
        expect(translation.genericFrames[0]?.body.tone).toBe('error')
        expect(translation.genericFrames[0]?.body.providerFrame?.provider).toBe('zcode')
        expectNoOtherArms(translation, new Set(['turnBoundary', 'genericFrames']))
      }
    },
    {
      name: 'text_delta streams assistant text keyed by assistantMessageId',
      event: envelope('model.streaming', {
        assistantMessageId: 'msg-a',
        delta: "I'll create the file.",
        done: false,
        kind: 'text_delta'
      }),
      check: (translation) => {
        expect(translation.streamDeltas).toEqual([
          {
            streamId: 'msg-a',
            kind: 'text',
            delta: "I'll create the file.",
            observedAt: TIMESTAMP
          }
        ])
        expectNoOtherArms(translation, new Set(['streamDeltas']))
      }
    },
    {
      name: 'reasoning_delta streams reasoning text',
      event: envelope('model.streaming', {
        assistantMessageId: 'msg-a',
        delta: 'The user wants a file.',
        done: false,
        kind: 'reasoning_delta'
      }),
      check: (translation) => {
        expect(translation.streamDeltas[0]).toMatchObject({ kind: 'reasoning', streamId: 'msg-a' })
      }
    },
    {
      name: 'tool_input_start streams a tool-input delta keyed by toolCallId',
      event: envelope('model.streaming', {
        assistantMessageId: 'msg-a',
        delta: '',
        done: false,
        kind: 'tool_input_start',
        toolCallId: 'call-1',
        toolName: 'Write'
      }),
      check: (translation) => {
        expect(translation.streamDeltas).toEqual([
          {
            streamId: 'call-1',
            kind: 'tool-input',
            delta: '',
            toolName: 'Write',
            observedAt: TIMESTAMP
          }
        ])
      }
    },
    {
      name: 'tool_call appends the full tool-call item with assembled input',
      event: envelope('model.streaming', {
        assistantMessageId: 'msg-a',
        delta: '',
        done: false,
        input: { file_path: '/tmp/sandbox/a.txt' },
        kind: 'tool_call',
        toolCallId: 'call-1',
        toolName: 'Read'
      }),
      check: (translation) => {
        expect(translation.appendItems).toHaveLength(1)
        expect(translation.appendItems[0]).toMatchObject({
          itemKey: 'call-1',
          lifecycle: false,
          observedAt: TIMESTAMP
        })
        expect(translation.appendItems[0]?.body).toEqual({
          kind: 'tool-call',
          name: 'Read',
          callId: 'call-1',
          input: { file_path: '/tmp/sandbox/a.txt' },
          state: 'running'
        })
        expectNoOtherArms(translation, new Set(['appendItems']))
      }
    },
    {
      name: 'tool.updated scheduled advances the call to running',
      event: envelope(
        'tool.updated',
        {
          toolCallId: 'call-1',
          assistantMessageId: 'msg-a',
          toolName: 'Write',
          kind: 'scheduled',
          inputOmitted: true,
          inputRef: 'model_stream'
        },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.toolCallUpdates).toEqual([
          {
            itemKey: 'call-1',
            state: 'running',
            toolName: 'Write',
            observedAt: TIMESTAMP
          }
        ])
        expectNoOtherArms(translation, new Set(['toolCallUpdates']))
      }
    },
    {
      name: 'tool.updated started keeps the call running',
      event: envelope(
        'tool.updated',
        { toolCallId: 'call-1', toolName: 'Write', kind: 'started', readOnly: false },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.toolCallUpdates[0]).toMatchObject({
          itemKey: 'call-1',
          state: 'running'
        })
      }
    },
    {
      name: 'tool.updated result completes the call with bounded output and duration',
      event: envelope(
        'tool.updated',
        {
          toolCallId: 'call-1',
          result: {
            success: true,
            content: 'File created successfully at: /tmp/sandbox/a.txt'
          },
          duration: 11,
          kind: 'result'
        },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.toolCallUpdates).toEqual([
          {
            itemKey: 'call-1',
            state: 'completed',
            output: {
              head: 'File created successfully at: /tmp/sandbox/a.txt',
              truncated: false,
              byteLength: expect.any(Number),
              digest: expect.any(String)
            },
            durationMs: 11,
            observedAt: TIMESTAMP
          }
        ])
      }
    },
    {
      name: 'tool.updated result with success false fails the call',
      event: envelope(
        'tool.updated',
        {
          toolCallId: 'call-1',
          result: { success: false, content: 'path is outside the workspace' },
          duration: 3,
          kind: 'result'
        },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.toolCallUpdates[0]).toMatchObject({ state: 'failed' })
      }
    },
    {
      name: 'tool.updated batch is bookkeeping and emits nothing',
      event: envelope(
        'tool.updated',
        { toolCallIds: ['call-1'], successCount: 1, errorCount: 0, kind: 'batch' },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expectNoOtherArms(translation, new Set())
      }
    },
    {
      name: 'tool.updated with an unknown kind degrades to a generic frame',
      event: envelope(
        'tool.updated',
        { toolCallId: 'call-1', kind: 'invented' },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.genericFrames).toHaveLength(1)
        expect(translation.genericFrames[0]?.body.providerFrame?.kind).toBe('tool.updated')
      }
    },
    {
      name: 'permission.requested appends a pending approval item with zcode options',
      event: envelope('permission.requested', permissionRequestPayload, { turnId: 'turn-1' }),
      check: (translation) => {
        expect(translation.appendItems).toHaveLength(1)
        const append = translation.appendItems[0]
        expect(append).toMatchObject({ itemKey: 'perm-1', lifecycle: true })
        expect(append?.body).toEqual({
          kind: 'approval',
          title: 'Allow Write?',
          description: '[medium] Tool has side effects and requires approval',
          detail: '{"file_path":"/tmp/sandbox/a.txt","content":"hi\\n"}',
          options: [
            { id: 'allow_once', label: 'Allow once' },
            {
              id: 'allow_project',
              label: 'Always allow in this project',
              description: 'Do not ask again for matching requests in this project'
            },
            { id: 'deny', label: 'Deny' }
          ],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        })
        expectNoOtherArms(translation, new Set(['appendItems']))
      }
    },
    {
      name: 'permission.resolved settles the approval resolution',
      event: envelope(
        'permission.resolved',
        { requestId: 'perm-1', toolCallId: 'call-1', decision: 'allow' },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.promptResolution).toEqual({
          promptKey: 'perm-1',
          resolution: {
            state: 'resolved',
            selectedOptionId: 'allow',
            resolvedBy: null,
            resolvedAt: TIMESTAMP
          }
        })
        expectNoOtherArms(translation, new Set(['promptResolution']))
      }
    },
    {
      name: 'permission.resolved without a decision still resolves with no selection',
      event: envelope(
        'permission.resolved',
        { requestId: 'perm-1', toolCallId: 'call-1' },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.promptResolution?.resolution.state).toBe('resolved')
        expect(translation.promptResolution?.resolution.selectedOptionId).toBeNull()
      }
    },
    {
      name: 'checkpoint.created lands in the generic-frame fallback',
      event: envelope(
        'checkpoint.created',
        { checkpointId: 'cp-1', scope: 'workspace', fileCount: 1 },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.genericFrames).toHaveLength(1)
        expect(translation.genericFrames[0]).toMatchObject({
          itemKey: 'evt-test',
          observedAt: TIMESTAMP,
          turnId: 'turn-1'
        })
        expect(translation.genericFrames[0]?.body.providerFrame).toMatchObject({
          provider: 'zcode',
          kind: 'checkpoint.created'
        })
        expectNoOtherArms(translation, new Set(['genericFrames']))
      }
    },
    {
      name: 'userInput.requested falls back to a generic frame (MVP; FU: question items)',
      event: envelope(
        'userInput.requested',
        { requestId: 'ask-1', questions: [{ question: 'Which?', header: 'Pick' }] },
        { turnId: 'turn-1' }
      ),
      check: (translation) => {
        expect(translation.genericFrames).toHaveLength(1)
        expect(translation.genericFrames[0]?.body.providerFrame?.kind).toBe('userInput.requested')
      }
    },
    {
      name: 'a typed event missing its key fields degrades to a generic frame instead of vanishing',
      event: envelope('turn.started', { input: 'no turn id on the envelope' }),
      check: (translation) => {
        expect(translation.turnBoundary).toBeNull()
        expect(translation.genericFrames).toHaveLength(1)
        expect(translation.genericFrames[0]?.body.providerFrame?.kind).toBe('turn.started')
      }
    },
    {
      name: 'model.streaming without an assistantMessageId degrades to a generic frame',
      event: envelope('model.streaming', { kind: 'text_delta', delta: 'orphan' }),
      check: (translation) => {
        expect(translation.streamDeltas).toHaveLength(0)
        expect(translation.genericFrames).toHaveLength(1)
      }
    },
    {
      name: 'a non-object payload on an unmapped type never throws',
      event: envelope('session.updated', 'bare string payload'),
      check: (translation) => {
        expect(translation.genericFrames).toHaveLength(1)
      }
    }
  ])('$name', ({ event, check }) => {
    check(translateZcodeSessionEvent(event))
  })
})

describe('translateZcodeSessionEvent purity', () => {
  it('returns deep-equal translations on repeated calls and leaves the envelope untouched', () => {
    const event = envelope('permission.requested', permissionRequestPayload, { turnId: 'turn-1' })
    const before = JSON.stringify(event)
    const first = translateZcodeSessionEvent(event)
    const second = translateZcodeSessionEvent(event)
    expect(second).toEqual(first)
    expect(JSON.stringify(event)).toBe(before)
  })
})

type WrappedTranscriptLine = { direction?: string; method?: string; params?: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readSpikeSessionEvents = (): ZcodeSessionEventEnvelope[] =>
  readFileSync(new URL('./fixtures/spike-session-transcript.ndjson', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line): WrappedTranscriptLine => JSON.parse(line))
    .flatMap((line): ZcodeSessionEventEnvelope[] => {
      if (line.direction !== 'in' || line.method !== 'session/event' || !isRecord(line.params)) {
        return []
      }
      // The notification params ARE the session-event envelope; extra wire fields
      // (deliveryKind, traceId) are ignored by the translator's readers.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture's session/event params were recorded verbatim from the wire and carry every required envelope field (eventId, sessionId, seq, timestamp, type); the translator treats them as unknown anyway.
      return [line.params as ZcodeSessionEventEnvelope]
    })

describe('spike transcript translation', () => {
  const events = readSpikeSessionEvents()
  const translations = events.map((event) => translateZcodeSessionEvent(event))

  it('saw a meaningful number of session events', () => {
    expect(events.length).toBeGreaterThanOrEqual(40)
  })

  it('translates every event without throwing', () => {
    expect(translations).toHaveLength(events.length)
  })

  it('produces at least one turn start and one turn completion', () => {
    const boundaries = translations.flatMap((translation) =>
      translation.turnBoundary ? [translation.turnBoundary] : []
    )
    expect(boundaries.length).toBeGreaterThanOrEqual(2)
    expect(boundaries.some((boundary) => boundary.state === 'running')).toBe(true)
    const completed = boundaries.find(
      (boundary) => boundary.state === 'completed' && boundary.outcome === 'success'
    )
    expect(completed).toMatchObject({ durationMs: 7899 })
  })

  it('streams text, reasoning, and tool-input deltas', () => {
    const deltas = translations.flatMap((translation) => translation.streamDeltas)
    expect(deltas.length).toBeGreaterThanOrEqual(15)
    expect(deltas.some((delta) => delta.kind === 'text')).toBe(true)
    expect(deltas.some((delta) => delta.kind === 'reasoning')).toBe(true)
    expect(deltas.some((delta) => delta.kind === 'tool-input')).toBe(true)
  })

  it('appends tool-call items for both spike tools with assembled input', () => {
    const toolCalls = translations.flatMap((translation) =>
      translation.appendItems.filter((append) => append.body.kind === 'tool-call')
    )
    expect(toolCalls.length).toBeGreaterThanOrEqual(2)
    const write = toolCalls.find(
      (append) => append.body.kind === 'tool-call' && append.body.name === 'Write'
    )
    expect(write?.body).toMatchObject({
      callId: 'call_ed045ab8e9aa42fba23974b7',
      input: { file_path: '/tmp/zcode-spike-ws/spike.txt', content: 'hi\n' },
      state: 'running'
    })
    const read = toolCalls.find(
      (append) => append.body.kind === 'tool-call' && append.body.name === 'Read'
    )
    expect(read?.body).toMatchObject({ callId: 'call_7102b1ad2e6844cc9f71047b' })
  })

  it('advances tool-call state through running to completed', () => {
    const updates = translations.flatMap((translation) => translation.toolCallUpdates)
    expect(updates.length).toBeGreaterThanOrEqual(4)
    expect(updates.some((update) => update.state === 'running')).toBe(true)
    const completed = updates.filter((update) => update.state === 'completed')
    expect(completed.length).toBeGreaterThanOrEqual(2)
    expect(completed[0]?.output?.truncated).toBe(false)
  })

  it('appends the spike permission approval with its three zcode options', () => {
    const approvals = translations.flatMap((translation) =>
      translation.appendItems.filter((append) => append.body.kind === 'approval')
    )
    expect(approvals).toHaveLength(1)
    const approval = approvals[0]?.body
    expect(approval).toMatchObject({
      kind: 'approval',
      title: 'Allow Write?'
    })
    if (approval?.kind !== 'approval') {
      throw new Error('expected approval body')
    }
    expect(approval.options.map((option) => option.id)).toEqual([
      'allow_once',
      'allow_project',
      'deny'
    ])
    expect(approval.resolution.state).toBe('pending')
  })

  it('settles the spike permission resolution', () => {
    const resolutions = translations.flatMap((translation) =>
      translation.promptResolution ? [translation.promptResolution] : []
    )
    expect(resolutions).toHaveLength(1)
    expect(resolutions[0]?.resolution).toMatchObject({
      state: 'resolved',
      selectedOptionId: 'allow'
    })
  })

  it('funnels unmapped event types into bounded generic frames', () => {
    const frames = translations.flatMap((translation) => translation.genericFrames)
    expect(frames.length).toBeGreaterThanOrEqual(10)
    const kinds = new Set(frames.map((frame) => frame.body.providerFrame?.kind))
    for (const expected of [
      'session.updated',
      'session.titleUpdated',
      'checkpoint.created',
      'streamRecovery.updated'
    ]) {
      expect(kinds.has(expected)).toBe(true)
    }
    for (const frame of frames) {
      expect(frame.body.kind).toBe('status')
      expect(frame.body.providerFrame?.provider).toBe('zcode')
    }
  })

  it('yields at least one journal output for every two input events', () => {
    const outputs = translations.reduce(
      (total, translation) =>
        total +
        translation.appendItems.length +
        translation.streamDeltas.length +
        translation.toolCallUpdates.length +
        translation.genericFrames.length +
        (translation.turnBoundary ? 1 : 0) +
        (translation.promptResolution ? 1 : 0),
      0
    )
    expect(outputs).toBeGreaterThanOrEqual(events.length / 2)
  })
})
