// Mid-session option application for zcode structured sessions: overrides the
// user set through setOption, their precedence over the resolved model
// selection, and the catalog→wire mapping readOptions reports. Mirrors
// codex-structured-session-options' role.

import type { AgentSessionModelOption } from '../../shared/agent-session-wire'
import type { CatalogModel } from '../../shared/agent-session-option-catalog-types'
import {
  ZCODE_REASONING_LEVEL_VALUES,
  ZCODE_SESSION_OPTION_CATALOG
} from '../../shared/agent-session-option-catalog-zcode'
import type { ZcodeSessionSendParams } from './zcode-protocol'
import { defaultZcodeModelSelection } from './zcode-structured-session-acquire'
import type { ZcodeSession } from './zcode-structured-session-state'

/** CatalogModel → the wire shape the agent-agnostic option pickers consume. */
export function zcodeSessionModelOption(model: CatalogModel): AgentSessionModelOption {
  const effort = model.options.find((option) => option.id === 'effort')
  const kind = effort?.kind.type === 'select' ? effort.kind : undefined
  return {
    id: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
    isDefault: model.isDefault === true,
    ...(kind ? { defaultEffort: kind.defaultValue, efforts: kind.choices } : { efforts: [] })
  }
}

/** The create result's offered models when it carried settings, else the seed. */
export function zcodeSessionModels(session: ZcodeSession | undefined): AgentSessionModelOption[] {
  return (
    session && session.availableModels.length > 0
      ? session.availableModels
      : ZCODE_SESSION_OPTION_CATALOG.models
  ).map(zcodeSessionModelOption)
}

/** A mid-session override is the user's explicit pick for this exact session,
 *  so it outranks every resolver — a resolver only names what the session would
 *  otherwise use (create echo, then the shipped default). */
export function applyZcodeOptionOverrides(
  base: ZcodeSessionSendParams['modelSelection'],
  overrides: Map<string, string> | undefined
): ZcodeSessionSendParams['modelSelection'] {
  const modelOverride = overrides?.get('model')
  const effortOverride = overrides?.get('effort')
  if (modelOverride === undefined && effortOverride === undefined) {
    return base
  }
  let providerId = base.providerId
  let modelId = base.modelId
  if (modelOverride !== undefined) {
    const separator = modelOverride.indexOf('/')
    if (separator > 0 && separator < modelOverride.length - 1) {
      providerId = modelOverride.slice(0, separator)
      modelId = modelOverride.slice(separator + 1)
    }
  }
  return {
    providerId,
    modelId,
    options: { reasoningLevel: effortOverride ?? base.options.reasoningLevel }
  }
}

/** Writes one validated override; the next session/send carries it. */
export function applyZcodeOptionOverride(
  session: ZcodeSession,
  key: 'model' | 'effort',
  value: string
): void {
  if (key === 'model') {
    const separator = value.indexOf('/')
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`zcode model ids are compound provider/model ids, not ${value}`)
    }
    if (
      session.availableModels.length > 0 &&
      !session.availableModels.some((model) => model.id === value)
    ) {
      throw new Error(`zcode app-server does not offer model ${value}`)
    }
    session.optionOverrides.set('model', value)
    return
  }
  const modelOverride = session.optionOverrides.get('model')
  const base = session.modelSelection ?? defaultZcodeModelSelection()
  const effectiveModelId = modelOverride ?? `${base.providerId}/${base.modelId}`
  const effort = session.availableModels
    .find((model) => model.id === effectiveModelId)
    ?.options.find((option) => option.id === 'effort')
  const allowed =
    effort?.kind.type === 'select'
      ? effort.kind.choices.map((choice) => choice.value)
      : [...ZCODE_REASONING_LEVEL_VALUES]
  if (!allowed.includes(value)) {
    throw new Error(
      `zcode app-server model ${effectiveModelId} does not support reasoning level ${value}`
    )
  }
  session.optionOverrides.set('effort', value)
}
