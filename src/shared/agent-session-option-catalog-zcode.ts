import type {
  AgentSessionOptionCatalog,
  CatalogModel,
  CatalogOption
} from './agent-session-option-catalog-types'
import type { SessionOptionSelectChoice } from './native-chat-session-options'

/** Every GLM model the spike app-server advertised carries these reasoning
 *  levels (settings.model.available[].reasoning.levels, defaultLevel max). */
export const ZCODE_REASONING_LEVEL_VALUES = ['low', 'high', 'max'] as const

const ZCODE_REASONING_LEVEL_CHOICES: SessionOptionSelectChoice[] = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' }
]

export function zcodeReasoningLevelOption(
  choices: readonly SessionOptionSelectChoice[],
  defaultValue: string
): CatalogOption {
  return {
    id: 'effort',
    label: 'Reasoning level',
    category: 'thought_level',
    kind: { type: 'select', choices: [...choices], defaultValue },
    // No launch flags exist: the model selection rides every session/send, so
    // the structured setOption path is the only applier.
    apply: {}
  }
}

export function zcodeReasoningEffort(): CatalogOption {
  return zcodeReasoningLevelOption(ZCODE_REASONING_LEVEL_CHOICES, 'max')
}

function zcodeSeedModel(modelId: string, isDefault: boolean): CatalogModel {
  return {
    id: `bigmodel-api/${modelId}`,
    label: modelId,
    isDefault,
    options: [zcodeReasoningEffort()]
  }
}

export const ZCODE_SESSION_OPTION_CATALOG: AgentSessionOptionCatalog = {
  // Why: the app-server registry names these ids under the builtin bigmodel-api
  // template (zcode-structured-session-acquire's default selection note); the
  // create result's live settings.model.available replaces this seed at runtime.
  models: [zcodeSeedModel('GLM-5.3', true), zcodeSeedModel('GLM-5.3-Flash', false)],
  modelApply: {},
  unknownModelOptions: [zcodeReasoningEffort()]
}
