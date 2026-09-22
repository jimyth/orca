import type {
  AgentJournalApprovalItem,
  AgentJournalPromptOption,
  AgentJournalResolution
} from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS,
  type JournalPayloadLimits
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import {
  boundJournalPromptBody,
  MAX_JOURNAL_PROMPT_OPTIONS
} from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import { readZcodePermissionOptions } from './zcode-prompt-registry-bounds'

// ZCode `permission.requested` / `permission.resolved` session events → durable
// journal prompt bodies. The prompt has to exist as a journal item with its own
// resolution state because the answer may arrive from another device; the reply
// wire path lives in the prompt registry, this is only the render model.

const OPTION_LABEL_LIMITS: JournalPayloadLimits = { inlineHeadBytes: 1024 }

const PENDING_RESOLUTION: AgentJournalResolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const readString = (source: unknown, key: string): string | null => {
  const value = isRecord(source) ? source[key] : undefined
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** ZCode ships prefabricated options (allow_once / allow_project / deny) with
 *  display names; the journal keeps the option id as the answer key. */
export function zcodeApprovalOptions(payload: unknown): AgentJournalPromptOption[] {
  const options = readZcodePermissionOptions(payload) ?? []
  return options.slice(0, MAX_JOURNAL_PROMPT_OPTIONS).map((option) => ({
    id: option.optionId,
    label: boundInlineText(option.name, OPTION_LABEL_LIMITS).text,
    ...(option.description
      ? { description: boundInlineText(option.description, OPTION_LABEL_LIMITS).text }
      : {})
  }))
}

function serializeApprovalDetail(input: unknown): string | null {
  if (input === undefined || input === null) {
    return null
  }
  try {
    const serialized = JSON.stringify(input)
    return serialized === undefined ? '[unserializable zcode permission input]' : serialized
  } catch {
    return '[unserializable zcode permission input]'
  }
}

/** The approval row for one `permission.requested` event. `detail` carries the
 *  tool input (what is being approved, codex-style); the risk tier prefixes the
 *  description because the approval item has no dedicated metadata field. */
export function zcodeApprovalItem(payload: unknown): AgentJournalApprovalItem {
  const toolName = readString(payload, 'toolName')
  const reason = readString(payload, 'reason') ?? ''
  const riskLevel = readString(payload, 'riskLevel')
  const description =
    riskLevel === null
      ? reason.length > 0
        ? reason
        : null
      : reason.length > 0
        ? `[${riskLevel}] ${reason}`
        : `[${riskLevel}]`
  const detail = serializeApprovalDetail(isRecord(payload) ? payload.input : undefined)
  return boundJournalPromptBody({
    kind: 'approval',
    title: toolName === null ? 'Approve this action?' : `Allow ${toolName}?`,
    ...(description === null ? {} : { description }),
    detail: detail === null ? null : boundInlineText(detail, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text,
    options: zcodeApprovalOptions(payload),
    resolution: { ...PENDING_RESOLUTION }
  })
}

/** `permission.resolved` names only the decision (allow/deny/…), never the
 *  option id the requester offered, so the journal field carries the decision
 *  verbatim; the resolver identity is genuinely unknown to this host. */
export function zcodePermissionResolution(
  payload: unknown,
  resolvedAt: number
): AgentJournalResolution {
  return {
    state: 'resolved',
    selectedOptionId: readString(payload, 'decision'),
    resolvedBy: null,
    resolvedAt
  }
}
