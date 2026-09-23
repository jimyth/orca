/** Compact token-count rendering ("32.1k", "1.3M") for summary rows. Shared so
 *  the automations usage model and the native-chat turn status cannot drift. */
export function formatCompactTokenCount(value: number | null | undefined): string {
  if (!value) {
    return '0'
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  }
  return value.toLocaleString()
}
