import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnOutputSurface } from '../turn-output.js'
import { applyIrcAction, initialIrcTurnState, IrcConverger, type IrcTurnState } from './turn-output.js'

// No onAdmission: IRC has no reactions, and a "working on it" line in a shared channel is noise, not feedback.
export function createIrcTurnOutput(
  record: (turn: Pending, text: string) => Promise<void>
): TurnOutputSurface<Pending, DaemonRenderAction, IrcConverger, NormalizedMessage> {
  return {
    platform: 'irc',
    createConverger: (ctx) => new IrcConverger(ctx.mode, ctx.isDm, ctx.resolveFileLink),
    initialTurnState: initialIrcTurnState,
    apply: (turn, action) => applyIrcAction(turnState<IrcTurnState>(turn), action, (text) => record(turn, text))
  }
}
