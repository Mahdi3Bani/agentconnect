import { z } from 'zod'
import type { IntegrationIrcConfig } from '@agentconnect.md/protocol'
import type { BotRecord, BotSecretMaterial } from '../../persistence/ports.js'
import type { CpPlatformProvider } from '../provider.js'

// A channel starts with a CHANTYPES prefix and holds no space, comma or BEL (RFC 2812 §1.3).
const IrcChannel = z
  .string()
  .regex(/^[#&!+][^\s,\x07]{1,199}$/, 'An IRC channel starts with #, &, ! or + and has no spaces')
// RFC 2812 nick characters, generous on length since modern networks raise NICKLEN.
const IrcNick = z.string().regex(/^[A-Za-z[\]\\`_^{|}][A-Za-z0-9[\]\\`_^{|}-]{0,31}$/, 'Not a valid IRC nick')

/** The `irc` credential block of `POST /integrations`: the network to reach and the login to use there. */
export const IrcCreateCredentials = z
  .object({
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535).default(6697),
    tls: z.boolean().default(true),
    nick: IrcNick,
    username: z.string().trim().min(1).optional(),
    realname: z.string().trim().min(1).optional(),
    saslAccount: z.string().trim().min(1).optional(),
    saslPassword: z.string().min(1).optional(),
    serverPassword: z.string().min(1).optional(),
    channels: z.array(IrcChannel).max(50).default([])
  })
  .refine((c) => !c.saslAccount === !c.saslPassword, 'A SASL account needs its password, and a password its account')
export type IrcCreateCredentials = z.infer<typeof IrcCreateCredentials>

/** One nick on one network is one bot: a second install of it would only ever run as `nick_`. */
export function ircExternalAppId(c: Pick<IrcCreateCredentials, 'host' | 'port' | 'nick'>): string {
  return `irc://${c.host.toLowerCase()}:${c.port}/${c.nick.toLowerCase()}`
}

/** The row's public half: everything but the passwords, as the bag's strings. */
function ircPlatformConfig(c: IrcCreateCredentials): Record<string, string> {
  return {
    host: c.host,
    port: String(c.port),
    tls: String(c.tls),
    nick: c.nick,
    channels: c.channels.join(','),
    ...(c.username ? { username: c.username } : {}),
    ...(c.realname ? { realname: c.realname } : {}),
    ...(c.saslAccount ? { saslAccount: c.saslAccount } : {})
  }
}

/** The §6.4 payload rebuilt from the row's bag and the secret slots, or undefined when the row lost its network. */
export function ircIntegrationConfig(
  bot: Pick<BotRecord, 'platformConfig'>,
  secrets: Pick<BotSecretMaterial, 'botToken' | 'appToken'>
): IntegrationIrcConfig | undefined {
  const bag = (bot.platformConfig ?? {}) as Record<string, unknown>
  const text = (key: string) => (typeof bag[key] === 'string' && bag[key] ? (bag[key] as string) : undefined)
  const host = text('host')
  const nick = text('nick')
  if (!host || !nick) return undefined
  const username = text('username')
  const realname = text('realname')
  const saslAccount = text('saslAccount')
  return {
    host,
    port: Number(text('port') ?? 6697),
    tls: text('tls') !== 'false',
    nick,
    channels: (text('channels') ?? '').split(',').filter(Boolean),
    ...(username ? { username } : {}),
    ...(realname ? { realname } : {}),
    ...(saslAccount && secrets.botToken ? { saslAccount, saslPassword: secrets.botToken } : {}),
    ...(secrets.appToken ? { serverPassword: secrets.appToken } : {})
  }
}

// No live check: the daemon, not the control plane, reaches the network, and a private server may be invisible from here.
export function createIrcCpProvider(): CpPlatformProvider<IrcCreateCredentials> {
  return {
    platformId: 'irc',
    installRoutes: () => [],
    credentialBodySchema: IrcCreateCredentials,
    validateConfig: async (credentials) => ({
      ok: true,
      identity: { name: `${credentials.nick} on ${credentials.host}`, externalAppId: ircExternalAppId(credentials) }
    }),
    buildNewBotInstall: ({ credentials }) => ({
      bot: { botUserId: credentials.nick, platformConfig: ircPlatformConfig(credentials) },
      secrets: {
        botToken: credentials.saslPassword ?? '',
        appToken: credentials.serverPassword ?? null,
        signingSecret: null
      },
      externalIdentity: {
        externalAppId: ircExternalAppId(credentials),
        externalTenantId: '-',
        conflictMessage: 'This nick on this IRC network is already installed. Reuse the existing bot.'
      }
    }),
    projectBotIdentity: (input) => ({
      externalAppId: input.platformConfig?.host
        ? ircExternalAppId({
            host: input.platformConfig.host,
            port: Number(input.platformConfig.port ?? 6697),
            nick: input.platformConfig.nick ?? input.botUserId ?? ''
          })
        : undefined,
      externalTenantId: '-'
    }),
    secretShape: { slots: { botToken: 'IRC SASL password', appToken: 'IRC server password' }, httpAssignRequires: [] },
    async projectIntegrationConfig(_integration, bot, _core, secrets) {
      return ircIntegrationConfig(bot, secrets)
    }
  }
}
