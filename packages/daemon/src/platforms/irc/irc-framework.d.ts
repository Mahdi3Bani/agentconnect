/**
 * irc-framework ships no types. This declares the surface this adapter uses
 * and nothing else -- a full DefinitelyTyped package is not a prerequisite for
 * one platform module, and a narrow declaration is honest about what is
 * actually exercised.
 */
declare module 'irc-framework' {
  export interface ConnectOptions {
    host: string
    port: number
    tls?: boolean
    nick: string
    username?: string
    gecos?: string
    password?: string
    account?: { account: string; password: string }
    enable_chghost?: boolean
    enable_echomessage?: boolean
    enable_setname?: boolean
    auto_reconnect?: boolean
    version?: string | null
  }

  export interface NetworkInfo {
    supports(token: string): string | string[] | boolean | undefined
    /** `available` maps each capability the server offered to its value ('' for none). */
    cap: { enabled: string[]; available: Map<string, string>; isEnabled(name: string): boolean }
  }

  export interface WhoisReply {
    nick: string
    real_name?: string
    account?: string
  }

  /** A `privmsg` or `action` event; tag values are unescaped, and a valueless tag is ''. */
  export interface MessageEvent {
    from_server: boolean
    nick: string
    ident?: string
    hostname?: string
    target: string
    message: string
    tags?: Record<string, string>
    /** Set on a line delivered as part of a batch. */
    batch?: { id: string; type: string; params: string[] }
  }

  /** A parsed line as the command handler sees it. */
  export interface IrcCommand {
    command: string
    params: string[]
    tags: Record<string, string>
    nick?: string
    ident?: string
    hostname?: string
  }

  /** What `batch end <type>` carries: the batch's lines, without the tags of its opening line. */
  export interface BatchEnd {
    id: string
    type: string
    params: string[]
    commands: IrcCommand[]
  }

  export class Client {
    network?: NetworkInfo
    /** Its per-command handlers; BATCH is wrapped to read the opening line's tags. */
    command_handler: { handlers: Record<string, (command: IrcCommand, handler: unknown) => unknown> }
    user?: { nick: string; username: string; host: string }
    /** Without options, reconnects with the previous ones. */
    connect(options?: ConnectOptions): void
    changeNick(nick: string): void
    quit(message?: string): void
    raw(line: string): void
    /** Ask for a capability beyond irc-framework's own list. */
    requestCap(cap: string | string[]): void
    whois(nick: string, callback: (event: WhoisReply) => void): void
    channel(name: string): unknown
    on(event: string, handler: (...args: never[]) => void): void
    once(event: string, handler: (...args: never[]) => void): void
    off(event: string, handler: (...args: never[]) => void): void
  }

  const _default: { Client: typeof Client }
  export default _default
}
