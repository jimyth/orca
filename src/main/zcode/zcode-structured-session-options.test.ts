import { describe, expect, it } from 'vitest'
import { ZCODE_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-zcode'
import {
  MODEL_SELECTION,
  PROVIDER_SESSION_ID,
  USER_MESSAGE,
  acquired,
  adapterFor,
  fakeZcode,
  identityFor
} from './zcode-structured-session-adapter-fixture'

const AVAILABLE_MODELS_CREATE_RESULT = () => ({
  session: { sessionId: PROVIDER_SESSION_ID },
  settings: {
    model: {
      available: [
        {
          ref: { providerId: 'bigmodel-test', modelId: 'GLM-5.3' },
          label: 'GLM-5.3',
          reasoning: {
            levels: [
              { value: 'low', label: 'low' },
              { value: 'high', label: 'high' },
              { value: 'max', label: 'max' }
            ],
            defaultLevel: 'max'
          }
        },
        {
          ref: { providerId: 'bigmodel-test', modelId: 'GLM-5.3-Flash' },
          label: 'GLM-5.3-Flash',
          reasoning: {
            levels: [
              { value: 'low', label: 'low' },
              { value: 'high', label: 'high' },
              { value: 'max', label: 'max' }
            ],
            defaultLevel: 'max'
          }
        }
      ],
      current: {
        providerId: 'bigmodel-test',
        modelId: 'GLM-5.3',
        options: { reasoningLevel: 'max' }
      }
    }
  }
})

describe('ZcodeStructuredSessionAdapter.readOptions', () => {
  it('reports the resolved model selection when the create result carried no models', async () => {
    const zcode = fakeZcode()
    const adapter = await acquired(zcode, [], MODEL_SELECTION)

    const options = await adapter.readOptions?.({ sessionId: 'session-1', fence: 7 })

    expect(options?.models.map(({ id }) => id)).toEqual(
      ZCODE_SESSION_OPTION_CATALOG.models.map(({ id }) => id)
    )
    expect(options?.current.model).toBe(`${MODEL_SELECTION.providerId}/${MODEL_SELECTION.modelId}`)
  })

  it('reports the models the create result offered with their reasoning levels', async () => {
    const zcode = fakeZcode({ 'session/create': AVAILABLE_MODELS_CREATE_RESULT })
    const adapter = await acquired(zcode)

    const options = await adapter.readOptions?.({ sessionId: 'session-1', fence: 7 })

    expect(options?.models).toEqual([
      {
        id: 'bigmodel-test/GLM-5.3',
        label: 'GLM-5.3',
        isDefault: true,
        defaultEffort: 'max',
        efforts: [
          { value: 'low', label: 'low' },
          { value: 'high', label: 'high' },
          { value: 'max', label: 'max' }
        ]
      },
      {
        id: 'bigmodel-test/GLM-5.3-Flash',
        label: 'GLM-5.3-Flash',
        isDefault: false,
        defaultEffort: 'max',
        efforts: [
          { value: 'low', label: 'low' },
          { value: 'high', label: 'high' },
          { value: 'max', label: 'max' }
        ]
      }
    ])
    expect(options?.current).toEqual({ model: 'bigmodel-test/GLM-5.3', effort: 'max' })
  })
})
describe('ZcodeStructuredSessionAdapter.setOption', () => {
  it('switches the model and reasoning level for the next send', async () => {
    const zcode = fakeZcode({ 'session/create': AVAILABLE_MODELS_CREATE_RESULT })
    const adapter = await acquired(zcode)

    await expect(
      adapter.setOption({
        sessionId: 'session-1',
        key: 'model',
        value: 'bigmodel-test/GLM-5.3-Flash',
        fence: 7
      })
    ).resolves.toEqual({ model: 'bigmodel-test/GLM-5.3-Flash' })
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'low', fence: 7 })
    ).resolves.toEqual({ effort: 'low' })

    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(zcode.connections[0].calls[2].params).toMatchObject({
      modelSelection: {
        providerId: 'bigmodel-test',
        modelId: 'GLM-5.3-Flash',
        options: { reasoningLevel: 'low' }
      }
    })
  })

  it('outranks an injected model selection resolver', async () => {
    const zcode = fakeZcode({ 'session/create': AVAILABLE_MODELS_CREATE_RESULT })
    const adapter = await acquired(zcode, [], MODEL_SELECTION)

    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'low', fence: 7 })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(zcode.connections[0].calls[2].params).toMatchObject({
      modelSelection: {
        providerId: MODEL_SELECTION.providerId,
        modelId: MODEL_SELECTION.modelId,
        options: { reasoningLevel: 'low' }
      }
    })
  })

  it('reflects the overrides in readOptions', async () => {
    const zcode = fakeZcode({ 'session/create': AVAILABLE_MODELS_CREATE_RESULT })
    const adapter = await acquired(zcode)

    await adapter.setOption({
      sessionId: 'session-1',
      key: 'model',
      value: 'bigmodel-test/GLM-5.3-Flash',
      fence: 7
    })
    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'low', fence: 7 })

    const options = await adapter.readOptions?.({ sessionId: 'session-1', fence: 7 })
    expect(options?.current).toEqual({
      model: 'bigmodel-test/GLM-5.3-Flash',
      effort: 'low'
    })
  })

  it('restores persisted options when the session is re-acquired', async () => {
    const zcode = fakeZcode({ 'session/create': AVAILABLE_MODELS_CREATE_RESULT })
    const adapter = adapterFor(zcode)

    await adapter.acquire({
      identity: identityFor('session-1'),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'bigmodel-test/GLM-5.3-Flash', effort: 'low' }
    })
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'client-1',
      body: USER_MESSAGE,
      fence: 7
    })

    expect(zcode.connections[0].calls[2].params).toMatchObject({
      modelSelection: {
        providerId: 'bigmodel-test',
        modelId: 'GLM-5.3-Flash',
        options: { reasoningLevel: 'low' }
      }
    })
  })

  it('rejects a model the create result did not offer', async () => {
    const zcode = fakeZcode({ 'session/create': AVAILABLE_MODELS_CREATE_RESULT })
    const adapter = await acquired(zcode)

    await expect(
      adapter.setOption({
        sessionId: 'session-1',
        key: 'model',
        value: 'bigmodel-test/GLM-4',
        fence: 7
      })
    ).rejects.toThrow('does not offer model bigmodel-test/GLM-4')
  })

  it('rejects a reasoning level outside the effective model levels', async () => {
    const zcode = fakeZcode({ 'session/create': AVAILABLE_MODELS_CREATE_RESULT })
    const adapter = await acquired(zcode)

    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'ultra', fence: 7 })
    ).rejects.toThrow('does not support reasoning level ultra')
  })

  it('rejects a model id without the provider/model compound form', async () => {
    const zcode = fakeZcode()
    const adapter = await acquired(zcode)

    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'GLM-5.3', fence: 7 })
    ).rejects.toThrow('provider/model')
  })
})
