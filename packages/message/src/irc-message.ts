import type { NormalizedPlatformMessage } from '@agentconnect.md/protocol'

/** One inbound PRIVMSG (or CTCP ACTION) as the connection received it; tags are already unescaped. */
export interface IrcMessageEvent {
  kind: 'privmsg' | 'action'
  nick: string
  target: string
  text: string
  tags?: Record<string, string | true>
  /** Native id to use when the server granted no `message-tags`; must not contain ':'. */
  fallbackId: string
  receivedAtMs: number
}

/** Per-connection facts the normalizer needs; all of them come from the server, not the platform. */
export interface IrcNormalizeContext {
  botNick: string
  /** ISUPPORT CHANTYPES; `#&` when the server did not say. */
  chantypes?: string | readonly string[]
  /** ISUPPORT CASEMAPPING; `rfc1459` when the server did not say. */
  casemapping?: string
}

// mIRC formatting: bold, colour (with optional fg[,bg]), hex colour, reset, reverse, italic, strike, underline, monospace.
const FORMATTING =
  /\x03(?:\d{1,2}(?:,\d{1,2})?)?|\x04(?:[0-9a-fA-F]{6}(?:,[0-9a-fA-F]{6})?)?|[\x02\x0f\x11\x16\x1d\x1e\x1f]/g

export function stripIrcFormatting(text: string): string {
  return text.replace(FORMATTING, '')
}

/** Fold a nick or channel name for comparison under the server's CASEMAPPING. */
export function ircCaseFold(value: string, casemapping = 'rfc1459'): string {
  const lower = value.replace(/[A-Z]/g, (c) => c.toLowerCase())
  if (casemapping === 'ascii') return lower
  const folded = lower.replace(/[[\]\\]/g, (c) => ({ '[': '{', ']': '}', '\\': '|' })[c]!)
  return casemapping === 'strict-rfc1459' ? folded : folded.replace(/\^/g, '~')
}

export function isIrcChannel(target: string, chantypes: string | readonly string[] = '#&'): boolean {
  return chantypes.includes(target[0] ?? '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `nick: text` / `nick, text` is how IRC addresses one person in a channel; the address is stripped from the text. */
function addressedTo(text: string, ctx: IrcNormalizeContext): { addressed: boolean; rest: string } {
  const match = /^([^\s:,]+)[:,]\s*/.exec(text)
  if (match && ircCaseFold(match[1]!, ctx.casemapping) === ircCaseFold(ctx.botNick, ctx.casemapping))
    return { addressed: true, rest: text.slice(match[0].length) }
  return { addressed: false, rest: text }
}

function mentionsNick(text: string, ctx: IrcNormalizeContext): boolean {
  const nick = escapeRegExp(ircCaseFold(ctx.botNick, ctx.casemapping))
  // Nick characters include []\`^{}|-, so a word boundary is "not a nick character", not \b.
  return new RegExp(`(^|[^\\w\\[\\]\\\\\`^{}|-])${nick}($|[^\\w\\[\\]\\\\\`^{}|-])`).test(
    ircCaseFold(text, ctx.casemapping)
  )
}

function serverTimeMs(tags: IrcMessageEvent['tags']): number | undefined {
  const value = tags?.time
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/** A tag value usable as the tail of a msgId: present, a string, and no ':' (consumers split the id on the last one). */
function nativeId(value: string | true | undefined): string | undefined {
  return typeof value === 'string' && value ? value.replaceAll(':', '%3A') : undefined
}

// NOTICE never reaches here: RFC 1459 forbids automatic replies to it, which is what keeps two bots from looping.
export function normalizeIrcMessage(
  event: IrcMessageEvent,
  traceId: string,
  ctx: IrcNormalizeContext
): NormalizedPlatformMessage | null {
  const fold = (value: string) => ircCaseFold(value, ctx.casemapping)
  // echo-message returns our own sends; the connection consumes those as delivery receipts.
  if (!event.nick || fold(event.nick) === fold(ctx.botNick)) return null
  // Any other CTCP (VERSION, PING, DCC) is protocol, not conversation.
  if (event.text.startsWith('\x01')) return null

  const isDm = !isIrcChannel(event.target, ctx.chantypes)
  const plain = stripIrcFormatting(event.text).replace(/\x00/g, '')
  const { addressed, rest } =
    isDm || event.kind === 'action' ? { addressed: false, rest: plain } : addressedTo(plain, ctx)
  const body = event.kind === 'action' ? `* ${event.nick} ${rest}` : rest
  if (!body.trim()) return null

  const mentioned = !isDm && (addressed || mentionsNick(rest, ctx))
  // A DM's conversation is the other person's nick, since that is where a reply must be addressed.
  const channel = isDm ? event.nick : event.target
  const account = typeof event.tags?.account === 'string' ? event.tags.account : undefined
  const replyTo = nativeId(event.tags?.['+draft/reply'] ?? event.tags?.['+reply'])
  const nativeMessageId = nativeId(event.tags?.msgid) ?? event.fallbackId

  return {
    platform: 'irc',
    source: 'user',
    traceId,
    msgId: `irc:${channel}:${nativeMessageId}`,
    channel,
    // IRC has no threads; one constant keeps a channel's conversation in one session, as QQ does.
    thread: isDm ? 'dm' : 'channel',
    sender: {
      // With account-tag the services account survives a nick change; without it the nick is all there is.
      id: account ? `account:${account}` : `nick:${event.nick}`,
      // The IRCv3 bot-mode tag is the only bot flag IRC has.
      isBot: event.tags?.bot !== undefined || event.tags?.['draft/bot'] !== undefined,
      name: event.nick
    },
    text: body,
    mentionedBots: mentioned ? [ctx.botNick] : [],
    isDm,
    ...(replyTo ? { replyTo } : {}),
    // Native msgids are opaque, not chronological, so the time always travels separately.
    platformTimeMs: serverTimeMs(event.tags) ?? event.receivedAtMs
  }
}
