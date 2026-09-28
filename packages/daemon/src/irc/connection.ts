import { randomUUID } from 'node:crypto'
import { ircCaseFold, normalizeIrcMessage, type IrcMessageEvent } from '@agentconnect.md/message'
import IRC, { type Client as IrcClient, type MessageEvent as IrcFrameworkMessage } from 'irc-framework'
import type { NormalizedMessage } from '../messages/normalized.js'
import { PlatformSendQueue } from '../platforms/send-queue.js'
import type {
  PlatformChannelInfo,
  PlatformChannelRef,
  PlatformConnection,
  PlatformMemberRef,
  PlatformUserProfile
} from '../platforms/contract.js'
import { IrcFloodGate } from './flood.js'
import { ircPayloadBudget, splitIrcText } from './split.js'

export interface IrcConnectionConfig {
  host: string
  port: number
  tls: boolean
  nick: string
  username?: string
  realname?: string
  /** SASL PLAIN, where the network supports it. */
  account?: { username: string; password: string }
  serverPassword?: string
}

export interface IrcConnectionDeps {
  onMessage?(msg: NormalizedMessage): void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How long a send waits for its echo-message before reporting it unconfirmed. */
  echoTimeoutMs?: number
}

/** One PRIVMSG line as sent. `confirmed` means the server echoed it back; `id` is its msgid when tags were granted. */
export interface IrcSendReceipt {
  id: string
  text: string
  confirmed: boolean
}

/**
 * The IRCv3 capabilities this adapter asks for, and what depends on each.
 *
 * Which of these a connection actually gets is decided by the SERVER, at
 * connect time -- Ergo, InspIRCd 3+, UnrealIRCd 6 and Soju grant most of them,
 * a 2005-vintage ircd grants none. That is the one thing about IRC that does
 * not fit the manifest: `membershipEnumeration` is a property of the platform,
 * but `message-tags` is a property of the connection.
 */
const WANTED_CAPS = [
  'message-tags', // msgid -- without it there is no stable message identity
  'server-time', // real timestamps instead of time-of-receipt
  'echo-message', // confirmation that a send landed
  'account-tag', // stable actor id across nick changes
  'multi-prefix', // full op/voice status in NAMES
  'away-notify',
  'extended-join'
] as const

// Settled with the echo (msgid present only where message-tags were granted), or null on timeout or stop.
type EchoWaiter = (receipt: { msgid?: string } | null) => void

const DEFAULT_CHANNEL_PREFIXES = '#&'

function timeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms))
  ])
}

export class IrcConnection implements PlatformConnection {
  readonly botUserId: string
  private client: IrcClient
  private ready = false
  private negotiated = new Set<string>()
  private readonly queue: PlatformSendQueue
  private readonly flood: IrcFloodGate
  private readonly now: () => number
  private localSeq = 0
  // Sends awaiting their echo, FIFO per (target, text): the server echoes in the order it received them.
  private readonly awaitingEcho = new Map<string, EchoWaiter[]>()

  constructor(
    private readonly config: IrcConnectionConfig,
    private readonly deps: IrcConnectionDeps = {}
  ) {
    this.botUserId = config.nick
    this.client = new IRC.Client()
    this.now = deps.now ?? (() => Date.now())
    this.flood = new IrcFloodGate(undefined, undefined, this.now, deps.sleep)
    // The flood gate does the spacing; the queue contributes FIFO order and the per-task timeout.
    this.queue = new PlatformSendQueue(0, this.now, deps.sleep)
  }

  // ── 1. transport lifecycle ──

  async start(): Promise<void> {
    await timeout(
      new Promise<void>((resolve, reject) => {
        this.client.on('registered', () => {
          this.ready = true
        })
        // ISUPPORT (005) lands after 001 but before end-of-MOTD (376, or 422 without one), so resolving there means it is read.
        this.client.on('motd', () => resolve())
        this.client.on('privmsg', (event: IrcFrameworkMessage) => this.onInbound('privmsg', event))
        this.client.on('action', (event: IrcFrameworkMessage) => this.onInbound('action', event))
        this.client.on('socket close', () => {
          if (!this.ready) reject(new Error('connection closed before registration'))
        })

        this.client.connect({
          host: this.config.host,
          port: this.config.port,
          tls: this.config.tls,
          nick: this.config.nick,
          username: this.config.username ?? this.config.nick,
          gecos: this.config.realname ?? this.config.nick,
          password: this.config.serverPassword,
          account: this.config.account,
          enable_chghost: true,
          // Both are opt-in in irc-framework. echo-message is what turns a
          // send into a confirmed send, so delivery state depends on asking.
          enable_echomessage: true,
          enable_setname: true,
          version: null
        })
      }),
      30_000,
      'IRC registration'
    )

    for (const cap of WANTED_CAPS) {
      if (this.client.network?.cap?.isEnabled(cap)) this.negotiated.add(cap)
    }
  }

  async stop(): Promise<void> {
    this.ready = false
    for (const waiters of this.awaitingEcho.values()) for (const settle of waiters) settle(null)
    this.awaitingEcho.clear()
    this.client.quit('disconnecting')
  }

  /**
   * IRC has no tenant. A network name is not one either: two people on the same
   * network share nothing, and the same bot can sit on several networks through
   * separate connections. Left undefined deliberately.
   */
  workspaceId(): string | undefined {
    return undefined
  }

  /** What this particular server granted. Not a platform-wide fact. */
  get capabilities(): ReadonlySet<string> {
    return this.negotiated
  }

  get network(): string | undefined {
    return (this.client.network?.supports?.('NETWORK') as string | undefined) || undefined
  }

  /** The nick the server knows us by now, which a collision at registration may have changed. */
  private get nick(): string {
    return this.client.user?.nick || this.config.nick
  }

  private get casemapping(): string {
    const value = this.client.network?.supports?.('CASEMAPPING')
    return typeof value === 'string' && value ? value : 'rfc1459'
  }

  private echoKey(target: string, text: string): string {
    return `${ircCaseFold(target, this.casemapping)}\n${text}`
  }

  private mintLocalId(): string {
    return `local-${this.now()}-${++this.localSeq}`
  }

  // ── inbound ──

  private onInbound(kind: IrcMessageEvent['kind'], event: IrcFrameworkMessage): void {
    if (event.from_server || !event.nick) return
    const tags = event.tags ?? {}
    if (ircCaseFold(event.nick, this.casemapping) === ircCaseFold(this.nick, this.casemapping)) {
      // Our own line coming back is a delivery receipt, never a conversation turn.
      const text = kind === 'action' ? `\x01ACTION ${event.message}\x01` : event.message
      const key = this.echoKey(event.target, text)
      const waiters = this.awaitingEcho.get(key)
      waiters?.shift()?.(tags.msgid ? { msgid: tags.msgid } : {})
      if (waiters && !waiters.length) this.awaitingEcho.delete(key)
      return
    }
    const msg = normalizeIrcMessage(
      {
        kind,
        nick: event.nick,
        target: event.target,
        text: event.message,
        tags,
        fallbackId: this.mintLocalId(),
        receivedAtMs: this.now()
      },
      randomUUID(),
      {
        botNick: this.nick,
        chantypes: this.client.network?.supports?.('CHANTYPES') as string | string[] | undefined,
        casemapping: this.casemapping
      }
    )
    if (msg) this.deps.onMessage?.(msg)
  }

  // ── outbound ──

  /** Split to fit the relayed 512-byte line, pace under flood control, and resolve once each line is echoed or times out. */
  async sendText(target: string, text: string): Promise<IrcSendReceipt[]> {
    // The target is interpolated into a raw line, so anything that could end or extend it is refused outright.
    if (!/^[^\s,:\x00][^\s,\x00]*$/.test(target)) throw new Error(`invalid IRC target: ${JSON.stringify(target)}`)
    const budget = ircPayloadBudget('PRIVMSG', target, {
      nick: this.nick,
      username: this.client.user?.username,
      host: this.client.user?.host
    })
    const echo = this.negotiated.has('echo-message')
    const receipts = splitIrcText(text, budget).map(async (line): Promise<IrcSendReceipt> => {
      const key = this.echoKey(target, line)
      let settle: EchoWaiter = () => {}
      const echoed = new Promise<{ msgid?: string } | null>((resolve) => (settle = resolve))
      await this.queue.enqueue(
        async () => {
          // Registered before the write so an echo cannot arrive ahead of its waiter.
          if (echo) this.awaitingEcho.set(key, [...(this.awaitingEcho.get(key) ?? []), settle])
          this.client.raw(`PRIVMSG ${target} :${line}`)
        },
        () => this.flood.take()
      )
      if (!echo) return { id: this.mintLocalId(), text: line, confirmed: false }
      const timer = setTimeout(() => {
        const waiters = this.awaitingEcho.get(key) ?? []
        if (waiters.includes(settle)) waiters.splice(waiters.indexOf(settle), 1)
        if (!waiters.length) this.awaitingEcho.delete(key)
        settle(null)
      }, this.deps.echoTimeoutMs ?? 10_000)
      const receipt = await echoed
      clearTimeout(timer)
      return { id: receipt?.msgid ?? this.mintLocalId(), text: line, confirmed: receipt !== null }
    })
    return Promise.all(receipts)
  }

  /** CHANTYPES comes back as a string on some ircds and an array on others. */
  private isChannel(target: string): boolean {
    const chantypes = this.client.network?.supports?.('CHANTYPES') as string | string[] | undefined
    const prefixes = chantypes ?? DEFAULT_CHANNEL_PREFIXES
    return prefixes.includes(target[0] ?? '')
  }

  // ── 3. read / query port ──

  async getChannelInfo(channel: string): Promise<PlatformChannelInfo> {
    // A query is addressed by bare nick -- the absence of a prefix, rather than
    // a prefix of its own, which is the inverse of every other platform here.
    if (!this.isChannel(channel)) {
      return { id: channel, name: channel, isIm: true, user: channel }
    }
    return {
      id: channel,
      name: channel,
      isIm: false,
      isPrivate: false
    }
  }

  async listMembers(channel: string): Promise<PlatformMemberRef[]> {
    if (!this.isChannel(channel)) {
      return [{ id: channel, name: channel }]
    }
    // `userlist` only fires for channels the client has joined, and this has to
    // answer for any channel -- so read RPL_NAMREPLY/RPL_ENDOFNAMES directly.
    const nicks = await timeout(
      new Promise<string[]>((resolve) => {
        const collected: string[] = []
        const onRaw = ({ line: rawLine }: { line: string }) => {
          // The raw event hands over the line with its CRLF still attached.
          const line = rawLine.replace(/\r?\n$/, '')
          const parts = line.split(' ')
          const numeric = parts[1]
          if (numeric === '353' && parts[4]?.toLowerCase() === channel.toLowerCase()) {
            const names = line
              .slice(line.indexOf(':', 1) + 1)
              .split(' ')
              .filter(Boolean)
            // Strip the op/voice prefixes multi-prefix may stack up.
            collected.push(...names.map((n) => n.replace(/^[~&@%+]+/, '')))
          } else if (numeric === '366' && parts[3]?.toLowerCase() === channel.toLowerCase()) {
            this.client.off('raw', onRaw)
            resolve(collected)
          }
        }
        this.client.on('raw', onRaw)
        this.client.raw(`NAMES ${channel}`)
      }),
      10_000,
      `NAMES ${channel}`
    )
    // IRC has no bot flag, so isBot is left unset rather than guessed.
    return nicks.map((nick) => ({ id: nick, name: nick }))
  }

  async listChannels(): Promise<PlatformChannelRef[]> {
    const channels = await timeout(
      new Promise<Array<{ channel: string; num_users: number; topic: string }>>((resolve) => {
        this.client.once('channel list', (list: Array<{ channel: string; num_users: number; topic: string }>) =>
          resolve(list)
        )
        this.client.raw('LIST')
      }),
      30_000,
      'LIST'
    )
    return channels.map((c) => ({ id: c.channel, name: c.channel, isPrivate: false }))
  }

  async getUserProfile(user: string): Promise<PlatformUserProfile> {
    const whois = await timeout(
      new Promise<{ nick: string; real_name?: string; account?: string }>((resolve) => {
        this.client.whois(user, (event: { nick: string; real_name?: string; account?: string }) => resolve(event))
      }),
      10_000,
      `WHOIS ${user}`
    )
    return {
      // With account-tag the account is the identity that survives a nick
      // change; without it, the nick is the best available and is not stable.
      id: whois.account ?? whois.nick,
      name: whois.nick,
      realName: whois.real_name
    }
  }

  /** IRC has no attachments, in either direction. */
  async downloadFile(): Promise<Buffer | null> {
    return null
  }
}
