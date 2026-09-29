import type { NormalizedMessage } from '../../messages/normalized.js'
import type { CommandChromeSurface } from '../command-chrome.js'
import type { IrcReplyPort } from './turn-output.js'

// One session per channel or DM (the thread is a constant), so the thread does identify it.
export const ircCommandChrome: CommandChromeSurface<NormalizedMessage, unknown> = {
  platform: 'irc',
  threadIdentifiesSession: true,
  reply(conn, msg, _ctx, text) {
    const line = msg.isDm || !msg.sender.name ? text : `${msg.sender.name}: ${text}`
    void (conn as IrcReplyPort).sendText(msg.channel, line, { maxLines: 3 }).catch(() => undefined)
  },
  status(conn, msg, ctx, _info, link) {
    this.reply(conn, msg, ctx, link ? `View this session: ${link}` : 'View this session in the AgentConnect console.')
  }
}
