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
    account?: { account: string; password: string } | { username: string; password: string }
    enable_chghost?: boolean
    enable_echomessage?: boolean
    enable_setname?: boolean
    version?: string | null
  }

  export interface NetworkInfo {
    supports(token: string): string | string[] | boolean | undefined
    cap: { enabled: string[]; isEnabled(name: string): boolean }
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
  }

  export class Client {
    network?: NetworkInfo
    user?: { nick: string; username: string; host: string }
    connect(options: ConnectOptions): void
    quit(message?: string): void
    raw(line: string): void
    whois(nick: string, callback: (event: WhoisReply) => void): void
    channel(name: string): unknown
    on(event: string, handler: (...args: never[]) => void): void
    once(event: string, handler: (...args: never[]) => void): void
    off(event: string, handler: (...args: never[]) => void): void
  }

  const _default: { Client: typeof Client }
  export default _default
}
