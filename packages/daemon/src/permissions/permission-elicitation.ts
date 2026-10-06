// A tool approval asked on a surface that collects answers through its elicitation card rather than
// a permission card of its own: the ACP options become one single-select field, keyed by optionId.
import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  PermissionOption,
  RequestPermissionRequest
} from '@agentclientprotocol/sdk'
import { permissionRequestParts } from '../daemon/tool-classification.js'

export const PERMISSION_CARD_PROP = 'decision'

// What the agent wants to do, by the ACP tool kind; anything else is just a tool.
const PERMISSION_ACTION: Partial<Record<string, string>> = {
  read: 'read a file',
  edit: 'edit a file',
  delete: 'delete a file',
  move: 'move a file',
  search: 'search',
  execute: 'run a command',
  fetch: 'fetch a web page'
}

/** The approval's one line. A runtime that titles a call with its own input (OpenCode titles an edit with its path) says it once. */
export function permissionMessage(params: RequestPermissionRequest): string {
  const { tool, detail } = permissionRequestParts(params)
  const action = PERMISSION_ACTION[params.toolCall?.kind ?? ''] ?? 'use a tool'
  const what = !detail || tool.includes(detail) ? tool : detail.includes(tool) ? detail : `${tool}: ${detail}`
  return `🔒 The agent wants to ${action}: ${what}`
}

export function permissionElicitation(params: RequestPermissionRequest): CreateElicitationRequest {
  return {
    sessionId: params.sessionId,
    mode: 'form',
    message: permissionMessage(params),
    requestedSchema: {
      type: 'object',
      properties: {
        [PERMISSION_CARD_PROP]: {
          type: 'string',
          title: 'Permission',
          oneOf: params.options.map((o) => ({ const: o.optionId, title: o.name }))
        }
      },
      required: [PERMISSION_CARD_PROP]
    }
  } as CreateElicitationRequest
}

/** The options that grant, so the durable row records what was actually picked. */
export function allowingOptionIds(params: RequestPermissionRequest): ReadonlySet<string> {
  return new Set(
    params.options.filter((o) => o.kind === 'allow_once' || o.kind === 'allow_always').map((o) => o.optionId)
  )
}

/** The option an answered card picked; undefined for a dismissal, a cancellation, or anything unoffered. */
export function permissionOptionFrom(
  params: RequestPermissionRequest,
  res: CreateElicitationResponse | undefined
): PermissionOption | undefined {
  if (res?.action !== 'accept') return undefined
  const picked = (res.content as Record<string, unknown> | null | undefined)?.[PERMISSION_CARD_PROP]
  return params.options.find((o) => o.optionId === picked)
}
