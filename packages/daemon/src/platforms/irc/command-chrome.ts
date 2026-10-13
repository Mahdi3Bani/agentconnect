import type { NormalizedMessage } from '../../messages/normalized.js'
import { selectDisplay } from '../../commands/select-projection.js'
import type { StatusBarInfo } from '../../slack/render.js'
import type { CommandChromeSurface } from '../command-chrome.js'
import type { IrcReplyPort } from './turn-output.js'

// A model or permission list is a dozen lines or so; where a reply is one multiline message it arrives whole.
const IRC_REPLY_MAX_LINES = { longForm: 40, lines: 12 }
// Commands core spells with `/` in its hints, which an IRC client takes as its own command and never sends.
const IRC_COMMAND_HINT = /(^|[\s`(])\/(models?|effort|permission|status|fast|new|stop|cancel|queue|resume)\b/g

/** Core's hints name commands with `/`; on IRC they are typed with `!`. */
export function ircCommandHints(text: string): string {
  return text.replace(IRC_COMMAND_HINT, '$1!$2')
}

/** The `!status` line: model, permission mode, context and tokens, in plain text. */
export function ircStatusText(info: StatusBarInfo, link?: string): string {
  const parts: string[] = []
  if (info.model) parts.push(info.model)
  if (info.permissionMode) parts.push(`mode ${selectDisplay('permission', info.permissionMode)}`)
  if (info.effort) parts.push(`effort ${info.effort}`)
  if (info.fastMode) parts.push('fast')
  if (info.contextUsed !== undefined && info.contextSize !== undefined && info.contextSize > 0) {
    const pct = Math.round((info.contextUsed / info.contextSize) * 100)
    parts.push(`context ${compactCount(info.contextUsed)}/${compactCount(info.contextSize)} (${pct}%)`)
  } else if (info.contextUsed !== undefined) parts.push(`context ${compactCount(info.contextUsed)}`)
  if (info.totalTokens !== undefined) parts.push(`${compactCount(info.totalTokens)} tokens`)
  const line = `📊 ${parts.length ? parts.join(' · ') : 'no details yet'}`
  // A console on the daemon's own machine is no use to anyone reading the channel.
  return link && !isLoopbackLink(link) ? `${line} · ${link}` : line
}

function isLoopbackLink(link: string): boolean {
  try {
    const host = new URL(link).hostname
    return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || host.startsWith('127.')
  } catch {
    return true
  }
}

function compactCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

// One session per channel or DM (the thread is a constant), so the thread does identify it.
export const ircCommandChrome: CommandChromeSurface<NormalizedMessage, StatusBarInfo> = {
  platform: 'irc',
  threadIdentifiesSession: true,
  reply(conn, msg, _ctx, text) {
    const port = conn as IrcReplyPort
    const body = ircCommandHints(text)
    const line = msg.isDm || !msg.sender.name ? body : `${msg.sender.name}: ${body}`
    const maxLines = port.longForm?.() ? IRC_REPLY_MAX_LINES.longForm : IRC_REPLY_MAX_LINES.lines
    void port.sendText(msg.channel, line, { maxLines }).catch(() => undefined)
  },
  status(conn, msg, ctx, info, link) {
    this.reply(conn, msg, ctx, ircStatusText(info ?? {}, link))
  }
}
