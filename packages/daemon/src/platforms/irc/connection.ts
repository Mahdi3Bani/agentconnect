import { createHash, randomUUID } from 'node:crypto'
import {
  ircCaseFold,
  ircUserId,
  isIrcChannel,
  normalizeIrcMessage,
  parseIrcUserId,
  type IrcMessageEvent
} from '@agentconnect.md/message'
import IRC, {
  type Client as IrcClient,
  type ConnectOptions,
  type MessageEvent as IrcFrameworkMessage
} from 'irc-framework'
import type { LoadedAgent } from '../../agents/load-agents.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import { platformIntegrationConfig } from '../integration-config.js'
import { PlatformSendQueue } from '../send-queue.js'
import type {
  PlatformChannelInfo,
  PlatformChannelRef,
  PlatformConnection,
  PlatformMemberRef,
  PlatformUserProfile
} from '../contract.js'
import { IrcFloodGate } from './flood.js'
import { carryFormatting, IRC_FORMATTING_CARRY_BYTES } from './render.js'
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
  /** Channels to join, and rejoin after every reconnect. */
  channels?: string[]
}

/** One login on one network, and every integration it serves. */
export interface IrcConnectionGroup {
  config: IrcConnectionConfig
  integrations: { agentId: string; integrationId: string }[]
}

/** Any change to the login, passwords and channels included, is a new connection. */
export function ircConnKey(config: IrcConnectionConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

export function consolidateIrc(agents: LoadedAgent[]): Map<string, IrcConnectionGroup> {
  const groups = new Map<string, IrcConnectionGroup>()
  for (const agent of agents)
    for (const integration of agent.integrations) {
      const wire = platformIntegrationConfig('irc', integration)
      if (!wire) continue
      const { saslAccount, saslPassword, ...rest } = wire
      const config: IrcConnectionConfig = {
        ...rest,
        ...(saslAccount && saslPassword ? { account: { username: saslAccount, password: saslPassword } } : {})
      }
      const key = ircConnKey(config)
      const group = groups.get(key) ?? { config, integrations: [] }
      group.integrations.push({ agentId: agent.id, integrationId: integration.id })
      groups.set(key, group)
    }
  return groups
}

export interface IrcConnectionDeps {
  onMessage?(msg: NormalizedMessage): void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How long a send waits for its echo-message before reporting it unconfirmed. */
  echoTimeoutMs?: number
  /** Reconnect backoff: doubles from `baseMs` up to `maxMs`, and never gives up while running. */
  reconnect?: { baseMs: number; maxMs: number }
  log?: { info(message: string): void; warn(message: string): void }
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

/** Refuse anything that could end or extend the raw line a target is interpolated into. */
function assertIrcTarget(target: string): void {
  if (!/^[^\s,:\x00][^\s,\x00]*$/.test(target)) throw new Error(`invalid IRC target: ${JSON.stringify(target)}`)
}

function timeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)))
  ]).finally(() => clearTimeout(timer))
}

export class IrcConnection implements PlatformConnection {
  readonly botUserId: string
  /** The pool identity: {@link ircConnKey} of the login this connection was opened with. */
  readonly key: string
  private client: IrcClient
  // Set once start() succeeds; a close before that fails start() instead of reconnecting.
  private started = false
  private stopping = false
  // Registered on the current socket: the state a send checks, false between a drop and the next 001.
  private registered = false
  private reconnecting = false
  private nickAttempt = 0
  private failStart?: (error: Error) => void
  private registrationOutcome?: (registered: boolean) => void
  private negotiated = new Set<string>()
  private readonly queue: PlatformSendQueue
  private readonly flood: IrcFloodGate
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private localSeq = 0
  // Last nick seen per services account, so an `account:` id can still be WHOISed.
  private readonly nickByAccount = new Map<string, string>()
  // Channels joined on an INVITE, rejoined after a reconnect for as long as this connection lives; capped against invite spam.
  private readonly invitedChannels = new Set<string>()
  // Sends awaiting their echo, FIFO per (target, text): the server echoes in the order it received them.
  private readonly awaitingEcho = new Map<string, EchoWaiter[]>()

  constructor(
    private readonly config: IrcConnectionConfig,
    private readonly deps: IrcConnectionDeps = {}
  ) {
    this.botUserId = config.nick
    this.key = ircConnKey(config)
    this.client = new IRC.Client()
    this.now = deps.now ?? (() => Date.now())
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()))
    this.flood = new IrcFloodGate(undefined, undefined, this.now, deps.sleep)
    // The flood gate does the spacing; the queue contributes FIFO order and the per-task timeout.
    this.queue = new PlatformSendQueue(0, this.now, deps.sleep)
  }

  // ── 1. transport lifecycle ──

  async start(): Promise<void> {
    this.client.on('registered', () => this.onRegistered())
    this.client.on('nick in use', () => this.onNickInUse())
    this.client.on('socket close', () => this.onSocketClose())
    this.client.on('privmsg', (event: IrcFrameworkMessage) => this.onInbound('privmsg', event))
    this.client.on('action', (event: IrcFrameworkMessage) => this.onInbound('action', event))
    this.client.on('invite', (event: { nick: string; channel: string }) => void this.onInvite(event))
    const ready = new Promise<void>((resolve, reject) => {
      // ISUPPORT (005) lands after 001 but before end-of-MOTD (376, or 422 without one), so resolving there means it is read.
      this.client.on('motd', () => resolve())
      this.failStart = reject
    })
    this.client.connect(this.connectOptions())
    try {
      await timeout(ready, 30_000, 'IRC registration')
    } catch (error) {
      this.stopping = true
      this.client.quit()
      throw error
    }
    this.started = true
  }

  private connectOptions(): ConnectOptions {
    return {
      host: this.config.host,
      port: this.config.port,
      tls: this.config.tls,
      nick: this.config.nick,
      username: this.config.username ?? this.config.nick,
      gecos: this.config.realname ?? this.config.nick,
      password: this.config.serverPassword,
      // irc-framework reads `account.account`; any other shape silently skips SASL.
      ...(this.config.account
        ? { account: { account: this.config.account.username, password: this.config.account.password } }
        : {}),
      enable_chghost: true,
      // Opt-in in irc-framework, and what turns a send into a confirmed send.
      enable_echomessage: true,
      enable_setname: true,
      // Its own reconnect gives up after 3 failures and skips a server that closes before 001; see reconnect().
      auto_reconnect: false,
      version: null
    }
  }

  private onRegistered(): void {
    this.registered = true
    this.nickAttempt = 0
    // Re-read on every registration: a reconnect can land on a different server of the same network.
    this.negotiated.clear()
    for (const cap of WANTED_CAPS) {
      if (this.client.network?.cap?.isEnabled(cap)) this.negotiated.add(cap)
    }
    this.registrationOutcome?.(true)
    void this.joinChannels()
  }

  // Accepting an invite is how a bot is added to a channel on IRC; the configured list stays the durable one.
  private async onInvite(event: { nick: string; channel: string }): Promise<void> {
    const channel = event.channel
    if (this.invitedChannels.has(channel) || this.invitedChannels.size >= 100) return
    try {
      assertIrcTarget(channel)
    } catch {
      return
    }
    if (!isIrcChannel(channel, this.client.network?.supports?.('CHANTYPES') as string | string[] | undefined)) return
    this.invitedChannels.add(channel)
    this.deps.log?.info(`irc: ${event.nick} invited us to ${channel}; joining`)
    await this.flood.take()
    if (this.registered) this.client.raw(`JOIN ${channel}`)
  }

  private async joinChannels(): Promise<void> {
    for (const channel of new Set([...(this.config.channels ?? []), ...this.invitedChannels])) {
      try {
        assertIrcTarget(channel)
      } catch {
        this.deps.log?.warn(`irc: not joining invalid channel ${JSON.stringify(channel)}`)
        continue
      }
      await this.flood.take()
      if (!this.registered) return
      this.client.raw(`JOIN ${channel}`)
    }
  }

  // After a drop the old connection often still holds the nick until the server times it out.
  private onNickInUse(): void {
    if (this.registered) return
    const attempt = ++this.nickAttempt
    const nick = attempt <= 2 ? this.config.nick + '_'.repeat(attempt) : `${this.config.nick}${attempt}`
    this.deps.log?.warn(`irc: nick in use; trying ${nick}`)
    this.client.changeNick(nick)
  }

  private onSocketClose(): void {
    this.registered = false
    this.registrationOutcome?.(false)
    if (!this.started) this.failStart?.(new Error('connection closed before registration'))
    else if (!this.stopping) void this.reconnect()
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return
    this.reconnecting = true
    const { baseMs, maxMs } = this.deps.reconnect ?? { baseMs: 1_000, maxMs: 300_000 }
    try {
      for (let attempt = 0; !this.stopping && !this.registered; attempt++) {
        const wait = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 20))
        this.deps.log?.warn(`irc: disconnected from ${this.config.host}; reconnecting in ${wait}ms`)
        await this.sleep(wait)
        if (this.stopping) return
        const outcome = new Promise<boolean>((resolve) => (this.registrationOutcome = resolve))
        this.client.connect()
        const registered = await timeout(outcome, 30_000, 'IRC registration').catch(() => false)
        this.registrationOutcome = undefined
        if (registered) this.deps.log?.info(`irc: reconnected to ${this.config.host}`)
      }
    } finally {
      this.reconnecting = false
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.registered = false
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
    if (tags.account) {
      this.nickByAccount.delete(tags.account)
      this.nickByAccount.set(tags.account, event.nick)
      if (this.nickByAccount.size > 5000) this.nickByAccount.delete(this.nickByAccount.keys().next().value!)
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
        botId: this.botUserId,
        chantypes: this.client.network?.supports?.('CHANTYPES') as string | string[] | undefined,
        casemapping: this.casemapping
      }
    )
    if (msg) this.deps.onMessage?.(msg)
  }

  // ── outbound ──

  /**
   * Split to fit the relayed 512-byte line, pace under flood control, and resolve once each line is echoed or times out.
   * `tags` ride the FIRST line only, so a tagged message is addressed by that line's msgid; they are dropped where the
   * server did not grant message-tags. Tags are outside the 512-byte budget, which is the body's alone.
   */
  async sendText(
    target: string,
    text: string,
    options: { maxLines?: number; tags?: Record<string, string> } = {}
  ): Promise<IrcSendReceipt[]> {
    assertIrcTarget(target)
    const budget = ircPayloadBudget('PRIVMSG', target, {
      nick: this.nick,
      username: this.client.user?.username,
      host: this.client.user?.host
    })
    let lines = splitIrcText(text, budget - IRC_FORMATTING_CARRY_BYTES)
    const { maxLines } = options
    if (maxLines !== undefined && lines.length > maxLines) {
      const dropped = lines.length - (maxLines - 1)
      lines = [...lines.slice(0, maxLines - 1), `[… ${dropped} more lines not sent]`]
    }
    const echo = this.negotiated.has('echo-message')
    const tagPrefix = options.tags && this.negotiated.has('message-tags') ? ircTagPrefix(options.tags) : ''
    const receipts = carryFormatting(lines).map(async (line, index): Promise<IrcSendReceipt> => {
      const key = this.echoKey(target, line)
      let settle: EchoWaiter = () => {}
      const echoed = new Promise<{ msgid?: string } | null>((resolve) => (settle = resolve))
      await this.queue.enqueue(
        async () => {
          // Registered before the write so an echo cannot arrive ahead of its waiter.
          // irc-framework drops a write on a closed socket silently, so a send between drop and 001 fails here instead.
          if (!this.registered) throw new Error('IRC connection is down')
          if (echo) this.awaitingEcho.set(key, [...(this.awaitingEcho.get(key) ?? []), settle])
          this.client.raw(`${index === 0 ? tagPrefix : ''}PRIVMSG ${target} :${line}`)
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
      return [{ id: ircUserId(channel), name: channel }]
    }
    assertIrcTarget(channel)
    // Paced before the timeout starts, so a busy flood gate cannot eat into the reply window.
    await this.flood.take()
    // `userlist` only fires for joined channels and this answers for any, so it reads RPL_NAMREPLY/RPL_ENDOFNAMES itself.
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
    // NAMES carries no bot flag or account, so isBot is left unset and ids are nick ids.
    return nicks.map((nick) => ({ id: ircUserId(nick), name: nick }))
  }

  async listChannels(): Promise<PlatformChannelRef[]> {
    await this.flood.take()
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

  /** Takes an `ircUserId` or a bare nick; an account id resolves through the last nick seen using it. */
  async getUserProfile(user: string): Promise<PlatformUserProfile> {
    const parsed = parseIrcUserId(user)
    const nick = 'nick' in parsed ? parsed.nick : this.nickByAccount.get(parsed.account)
    if (!nick) return { id: user }
    assertIrcTarget(nick)
    await this.flood.take()
    const whois = await timeout(
      new Promise<{ nick: string; real_name?: string; account?: string }>((resolve) => {
        this.client.whois(nick, (event: { nick: string; real_name?: string; account?: string }) => resolve(event))
      }),
      10_000,
      `WHOIS ${nick}`
    )
    return { id: ircUserId(whois.nick, whois.account), name: whois.nick, realName: whois.real_name }
  }

  /** IRC has no attachments, in either direction. */
  async downloadFile(): Promise<Buffer | null> {
    return null
  }
}

/** `@key=value;key2=value2 `, values escaped as IRCv3 message-tags requires; empty for no tags. */
export function ircTagPrefix(tags: Record<string, string>): string {
  const escape = (value: string) =>
    value.replace(/\\/g, '\\\\').replace(/;/g, '\\:').replace(/ /g, '\\s').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
  const parts = Object.entries(tags).map(([key, value]) => (value === '' ? key : `${key}=${escape(value)}`))
  return parts.length ? `@${parts.join(';')} ` : ''
}
