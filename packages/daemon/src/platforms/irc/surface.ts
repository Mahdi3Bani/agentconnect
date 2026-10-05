import { turnState, type DaemonRenderAction, type Pending } from '../../daemon/turn-types.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { TurnOutputSurface } from '../turn-output.js'
import { ircElicitCards } from './elicit-card.js'
import { applyIrcAction, initialIrcTurnState, IrcConverger, type IrcTurnState } from './turn-output.js'

// No onAdmission: a "working on it" line in a shared channel is noise. Feedback is IRCv3 typing instead, started
// with the turn's state and stopped at settlement, which are paired one to one (admission is not: a steered message
// is admitted into a turn already running). A client without typing support simply shows nothing.
export function createIrcTurnOutput(
  record: (turn: Pending, text: string) => Promise<void>
): TurnOutputSurface<Pending, DaemonRenderAction, IrcConverger, NormalizedMessage> {
  return {
    platform: 'irc',
    elicitCards: ircElicitCards,
    onSettle: async (turn) => {
      const state = turnState<IrcTurnState>(turn)
      state.conn?.typingStop?.(state.target)
    },
    createConverger: (ctx) => new IrcConverger(ctx.mode, ctx.isDm, ctx.resolveFileLink),
    initialTurnState: initialIrcTurnState,
    apply: (turn, action) => applyIrcAction(turnState<IrcTurnState>(turn), action, (text) => record(turn, text))
  }
}
