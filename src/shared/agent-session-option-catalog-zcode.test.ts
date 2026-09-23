import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import {
  ZCODE_REASONING_LEVEL_VALUES,
  ZCODE_SESSION_OPTION_CATALOG
} from './agent-session-option-catalog-zcode'

describe('zcode session option catalog', () => {
  it('registers the zcode catalog for the agent-agnostic option pickers', () => {
    expect(getAgentSessionOptionCatalog('zcode')).toBe(ZCODE_SESSION_OPTION_CATALOG)
  })

  it('seeds both GLM models under the builtin provider id', () => {
    expect(
      ZCODE_SESSION_OPTION_CATALOG.models.map(({ id, label, isDefault }) => ({
        id,
        label,
        isDefault
      }))
    ).toEqual([
      { id: 'bigmodel-api/GLM-5.3', label: 'GLM-5.3', isDefault: true },
      { id: 'bigmodel-api/GLM-5.3-Flash', label: 'GLM-5.3-Flash', isDefault: false }
    ])
  })

  it('offers low/high/max reasoning with max as the shipped default', () => {
    for (const model of ZCODE_SESSION_OPTION_CATALOG.models) {
      expect(model.options.map(({ id }) => id)).toEqual(['effort'])
      const effort = model.options[0]!
      expect(effort.kind).toMatchObject({
        type: 'select',
        defaultValue: 'max',
        choices: ZCODE_REASONING_LEVEL_VALUES.map((value) => expect.objectContaining({ value }))
      })
    }
  })

  it('keeps launch inert because zcode model selection rides session/send', () => {
    expect(ZCODE_SESSION_OPTION_CATALOG.modelApply.launchArgs).toBeUndefined()
    expect(ZCODE_SESSION_OPTION_CATALOG.unknownModelOptions?.map(({ id }) => id)).toEqual([
      'effort'
    ])
  })
})
