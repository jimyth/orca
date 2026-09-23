import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readZcodeAvailableModels } from './zcode-structured-model-catalog'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const spikeCreateResult = (): unknown =>
  readFileSync(new URL('./fixtures/spike-session-transcript.ndjson', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line): Record<string, unknown> => JSON.parse(line))
    .find(
      (line) => line.direction === 'in' && isRecord(line.result) && isRecord(line.result.settings)
    )?.result

const modelEntry = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ref: { providerId: 'bigmodel-test', modelId: 'GLM-5.3' },
  label: 'GLM-5.3',
  reasoning: {
    levels: [
      { value: 'low', label: 'low' },
      { value: 'high', label: 'high' },
      { value: 'max', label: 'max' }
    ],
    defaultLevel: 'max'
  },
  ...overrides
})

describe('readZcodeAvailableModels', () => {
  it('parses the spike create result into catalog models', () => {
    const models = readZcodeAvailableModels(spikeCreateResult())

    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      id: 'bigmodel-spike/GLM-5.3',
      label: 'GLM-5.3',
      isDefault: true
    })
    const effort = models[0]!.options.find(({ id }) => id === 'effort')
    expect(effort?.kind).toMatchObject({
      type: 'select',
      defaultValue: 'max',
      choices: [
        { value: 'low', label: 'low' },
        { value: 'high', label: 'high' },
        { value: 'max', label: 'max' }
      ]
    })
  })

  it('maps every available entry, falling back to the modelId for a missing label', () => {
    const models = readZcodeAvailableModels({
      settings: {
        model: {
          available: [
            modelEntry(),
            modelEntry({
              ref: { providerId: 'bigmodel-test', modelId: 'GLM-5.3-Flash' },
              label: undefined,
              reasoning: {
                levels: [{ value: 'high', label: 'high' }, { value: 'max' }],
                defaultLevel: 'high'
              }
            })
          ],
          current: {
            providerId: 'bigmodel-test',
            modelId: 'GLM-5.3',
            options: { reasoningLevel: 'max' }
          }
        }
      }
    })

    expect(models.map(({ id, label, isDefault }) => ({ id, label, isDefault }))).toEqual([
      { id: 'bigmodel-test/GLM-5.3', label: 'GLM-5.3', isDefault: true },
      { id: 'bigmodel-test/GLM-5.3-Flash', label: 'GLM-5.3-Flash', isDefault: false }
    ])
    const flashEffort = models[1]!.options[0]!
    expect(flashEffort.kind).toMatchObject({
      type: 'select',
      defaultValue: 'high',
      choices: [
        { value: 'high', label: 'high' },
        { value: 'max', label: 'max' }
      ]
    })
  })

  it('falls back to the shipped low/high/max levels when an entry advertises none', () => {
    const models = readZcodeAvailableModels({
      settings: {
        model: {
          available: [modelEntry({ reasoning: undefined })],
          current: { providerId: 'bigmodel-test', modelId: 'GLM-5.3' }
        }
      }
    })

    const effort = models[0]?.options[0]
    expect(effort?.kind).toMatchObject({
      type: 'select',
      defaultValue: 'max',
      choices: [{ value: 'low' }, { value: 'high' }, { value: 'max' }]
    })
  })

  it('returns no models for a create result without model settings', () => {
    expect(readZcodeAvailableModels(null)).toEqual([])
    expect(readZcodeAvailableModels({ session: { sessionId: 'sess-1' } })).toEqual([])
    expect(
      readZcodeAvailableModels({
        settings: { model: { available: [{ noRef: true }, { ref: { modelId: 'GLM-5.3' } }] } }
      })
    ).toEqual([])
  })
})
