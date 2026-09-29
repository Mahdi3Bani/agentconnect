import { describe, expect, it } from 'vitest'
import { IntegrationIrcConfig } from '@agentconnect.md/protocol'
import { buildCreateIntegrationBody } from '../../http/dto/create-integration-body.js'
import { buildCpPlatformRegistry } from '../registry.js'
import { createIrcCpProvider, IrcCreateCredentials, ircExternalAppId, ircIntegrationConfig } from './provider.js'

const credentials = IrcCreateCredentials.parse({
  host: 'irc.example.net',
  nick: 'r2d2',
  saslAccount: 'r2d2',
  saslPassword: 'beep-secret',
  serverPassword: 'door-secret',
  channels: ['#cantina', '#hangar']
})
const agentId = '00000000-0000-4000-8000-000000000001'

describe('IRC installation', () => {
  it('defaults to TLS on 6697 and refuses what no IRC server would accept', () => {
    expect(credentials).toMatchObject({ port: 6697, tls: true })
    for (const bad of [
      { host: 'h', nick: '9lives' },
      { host: 'h', nick: 'ok', channels: ['cantina'] },
      { host: 'h', nick: 'ok', channels: ['#two words'] },
      { host: 'h', nick: 'ok', saslAccount: 'ok' }
    ])
      expect(IrcCreateCredentials.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
  })

  it('keeps the passwords in the secret slots and out of the public row', () => {
    const install = createIrcCpProvider().buildNewBotInstall({
      credentials,
      identity: {},
      transport: 'socket',
      shareable: false
    })
    expect(install.secrets).toEqual({ botToken: 'beep-secret', appToken: 'door-secret', signingSecret: null })
    expect(JSON.stringify(install.bot)).not.toContain('secret')
    expect(install.externalIdentity?.externalAppId).toBe('irc://irc.example.net:6697/r2d2')
  })

  it('fences one nick per network, whatever its case', () => {
    expect(ircExternalAppId({ host: 'IRC.Example.net', port: 6697, nick: 'R2D2' })).toBe(
      ircExternalAppId({ host: 'irc.example.net', port: 6697, nick: 'r2d2' })
    )
  })

  it('projects a payload the daemon schema accepts, and the same login it was given', async () => {
    const provider = createIrcCpProvider()
    const install = provider.buildNewBotInstall({ credentials, identity: {}, transport: 'socket', shareable: false })
    // Through what the repo persists, not the install's own bag: a live install once stored an empty bag here.
    const persisted = provider.projectBotIdentity!({ platform: 'irc', ...install.bot } as never)
    expect(persisted.externalAppId).toBe('irc://irc.example.net:6697/r2d2')
    const config = ircIntegrationConfig({ platformConfig: persisted.platformConfig ?? null }, install.secrets)
    expect(IntegrationIrcConfig.parse(config)).toEqual(credentials)
  })

  it('projects nothing for a row that lost its network, so the daemon drops it', () => {
    expect(ircIntegrationConfig({ platformConfig: null }, { botToken: '', appToken: null })).toBeUndefined()
  })

  it('omits the SASL login when no password is stored', () => {
    const config = ircIntegrationConfig(
      { platformConfig: { host: 'h', nick: 'n', saslAccount: 'n', port: '6667', tls: 'false', channels: '' } },
      { botToken: '', appToken: null }
    )
    expect(config).toEqual({ host: 'h', port: 6667, tls: false, nick: 'n', channels: [] })
  })

  it('exposes the IRC block through the actual create schema', () => {
    const schema = buildCreateIntegrationBody(buildCpPlatformRegistry([createIrcCpProvider()]))
    expect(schema.safeParse({ platform: 'irc', agentId, irc: { host: 'irc.example.net', nick: 'r2d2' } }).success).toBe(
      true
    )
  })
})
