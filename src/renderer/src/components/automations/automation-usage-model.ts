import type { AutomationRunUsage } from '../../../../shared/automations-types'
import { formatCompactTokenCount } from '../../../../shared/format-compact-token-count'

// Why: the summary is computed by whichever authority owns the retained runs, so
// it lives in shared code; only the display formatting below is renderer-only.
export type { AutomationUsageSummary } from '../../../../shared/automation-usage-summary'
export { summarizeAutomationRunUsage } from '../../../../shared/automation-usage-summary'

// Moved to shared: the native-chat turn status renders the same compact counts.
export const formatAutomationTokens = formatCompactTokenCount

export function formatAutomationCost(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return 'n/a'
  }
  if (value > 0 && value < 0.01) {
    return `$${value.toFixed(4)}`
  }
  return `$${value.toFixed(2)}`
}

export function getAutomationUsageStatusLabel(
  usage: AutomationRunUsage | null | undefined
): string {
  if (!usage || usage.status === 'unavailable') {
    return usage?.unavailableMessage ?? 'Usage unavailable'
  }
  const cost = formatAutomationCost(usage.estimatedCostUsd)
  const tokens = formatAutomationTokens(usage.totalTokens)
  return `${tokens} tokens · ${cost}`
}
