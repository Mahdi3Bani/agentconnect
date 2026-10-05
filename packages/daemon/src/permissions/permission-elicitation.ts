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

export function permissionElicitation(params: RequestPermissionRequest): CreateElicitationRequest {
  const { tool, detail } = permissionRequestParts(params)
  return {
    sessionId: params.sessionId,
    mode: 'form',
    message: `🔒 The agent wants to run ${detail ? `${tool}: ${detail}` : tool}`,
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
