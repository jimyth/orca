// Model-catalog reads off a zcode session/create result: the offered models
// (settings.model.available → CatalogModel[]) and the option overrides a host
// replays at acquire time. Mirrors codex-structured-model-catalog's role.

import type { CatalogModel, CatalogOption } from '../../shared/agent-session-option-catalog-types'
import {
  zcodeReasoningEffort,
  zcodeReasoningLevelOption
} from '../../shared/agent-session-option-catalog-zcode'
import type { SessionOptionSelectChoice } from '../../shared/native-chat-session-options'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function readString(source: unknown, key: string): string | null {
  const value = isRecord(source) ? source[key] : undefined
  return typeof value === 'string' && value.length > 0 ? value : null
}

function zcodeReasoningOption(reasoning: unknown): CatalogOption {
  const levels = isRecord(reasoning) && Array.isArray(reasoning.levels) ? reasoning.levels : []
  const choices = levels.flatMap((level): SessionOptionSelectChoice[] => {
    if (!isRecord(level)) {
      return []
    }
    const value = readString(level, 'value')
    return value ? [{ value, label: readString(level, 'label') ?? value }] : []
  })
  if (choices.length === 0) {
    // session/send always carries a reasoningLevel, so a model that advertised
    // none still gets the shipped levels rather than no picker at all.
    return zcodeReasoningEffort()
  }
  const defaultLevel = isRecord(reasoning) ? readString(reasoning, 'defaultLevel') : null
  const fallback = choices.some((choice) => choice.value === 'max')
    ? 'max'
    : (choices.at(-1)?.value ?? 'max')
  return zcodeReasoningLevelOption(
    choices,
    defaultLevel !== null && choices.some((choice) => choice.value === defaultLevel)
      ? defaultLevel
      : fallback
  )
}

/** settings.model.available → catalog models (ids `${providerId}/${modelId}`,
 *  the entry matching settings.model.current flagged default); [] when the
 *  create result carried no model settings. */
export function readZcodeAvailableModels(result: unknown): CatalogModel[] {
  const settingsModel =
    isRecord(result) && isRecord(result.settings) ? result.settings.model : undefined
  if (!isRecord(settingsModel) || !Array.isArray(settingsModel.available)) {
    return []
  }
  const current = isRecord(settingsModel.current) ? settingsModel.current : undefined
  const currentProviderId = current === undefined ? null : readString(current, 'providerId')
  const currentModelId = current === undefined ? null : readString(current, 'modelId')
  const models: CatalogModel[] = []
  for (const entry of settingsModel.available) {
    if (!isRecord(entry) || !isRecord(entry.ref)) {
      continue
    }
    const providerId = readString(entry.ref, 'providerId')
    const modelId = readString(entry.ref, 'modelId')
    if (providerId === null || modelId === null) {
      continue
    }
    models.push({
      id: `${providerId}/${modelId}`,
      label: readString(entry, 'label') ?? modelId,
      isDefault: providerId === currentProviderId && modelId === currentModelId,
      options: [zcodeReasoningOption(entry.reasoning)]
    })
  }
  return models
}

/** The host replays persisted record.options through acquire, never setOption,
 *  so recovery re-seeds only the keys this adapter owns. */
export function restoredZcodeOptionOverrides(
  options: Readonly<Record<string, string>> | undefined
): Map<string, string> {
  const restored = new Map<string, string>()
  for (const key of ['model', 'effort'] as const) {
    const value = options?.[key]
    if (typeof value === 'string' && value.length > 0) {
      restored.set(key, value)
    }
  }
  return restored
}
