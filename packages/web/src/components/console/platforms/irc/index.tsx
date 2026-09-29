import { IrcMark } from './mark'
import type { WebPlatformModule } from '../contract'
import { identityCards, inviteBotHint } from '../wizard-chrome'
import { IrcWizardBody } from './Body'

export const ircModule: WebPlatformModule = {
  platformId: 'irc',
  Mark: IrcMark,
  wizard: {
    Body: IrcWizardBody,
    freeBotFilter: () => true,
    buildReuseInput: (bot, ctx) => ({ platform: 'irc', agentId: ctx.agentId, botId: bot.id }),
    affordances: {},
    identityCards: () => identityCards('irc'),
    inviteHint: () => inviteBotHint('channel', 'IRC', true)
  },
  apiBindings: {},
  // A channel id already carries its sigil (`#cantina`), and a bot leaves with PART, which the console does not drive yet.
  channelList: { roomNoun: 'channel', roomGlyph: '', leave: 'none' }
}
