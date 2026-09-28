import { afterEach, describe, expect, it } from 'vitest'
import { IrcConnection } from '../src/irc/connection.js'
import { startTestServer, type TestServer } from '../src/irc/test-server.js'

let server: TestServer | undefined
let conn: IrcConnection | undefined

afterEach(async () => {
  await conn?.stop()
  await server?.close()
  conn = undefined
  server = undefined
})

async function connect(caps?: string[]): Promise<IrcConnection> {
  server = await startTestServer(caps === undefined ? {} : { caps })
  conn = new IrcConnection({
    host: '127.0.0.1',
    port: server.port,
    tls: false,
    nick: 'agentconnect'
  })
  await conn.start()
  return conn
}

describe('the required half of PlatformConnection', () => {
  it('registers and reports the network', async () => {
    const c = await connect()
    expect(c.botUserId).toBe('agentconnect')
    expect(c.network).toBe('testnet')
  })

  it('has no tenant', async () => {
    const c = await connect()
    expect(c.workspaceId()).toBeUndefined()
  })

  it('lists members from NAMES', async () => {
    const c = await connect()
    await c.listChannels() // force the client past registration chatter
    const members = await c.listMembers('#cantina')
    expect(members.map((m) => m.id).sort()).toEqual(['chewie', 'han', 'leia'])
  })

  it('lists channels from LIST', async () => {
    const c = await connect()
    const channels = await c.listChannels()
    expect(channels).toEqual([{ id: '#cantina', name: '#cantina', isPrivate: false }])
  })

  it('reads a profile from WHOIS', async () => {
    const c = await connect()
    const profile = await c.getUserProfile('han')
    expect(profile.name).toBe('han')
    expect(profile.realName).toBe('Real Name Of han')
  })

  it('tells a channel from a query by its prefix, not by a marker', async () => {
    const c = await connect()
    expect((await c.getChannelInfo('#cantina')).isIm).toBe(false)
    // A query is addressed by bare nick. No prefix means DM -- the inverse of
    // every other platform's dmChannelPattern.
    expect((await c.getChannelInfo('han')).isIm).toBe(true)
  })

  it('has no attachments', async () => {
    const c = await connect()
    expect(await c.downloadFile()).toBeNull()
  })
})

describe('IRCv3 capabilities are per connection, not per platform', () => {
  it('records what a modern server grants', async () => {
    const c = await connect()
    expect(c.capabilities.has('message-tags')).toBe(true)
    expect(c.capabilities.has('server-time')).toBe(true)
    expect(c.capabilities.has('echo-message')).toBe(true)
  })

  it('still connects to a server that grants nothing', async () => {
    const c = await connect([])
    // The required surface keeps working; only message identity is lost.
    expect(c.capabilities.size).toBe(0)
    expect((await c.listChannels()).length).toBe(1)
  })

  it('records a partial grant rather than all-or-nothing', async () => {
    const c = await connect(['server-time', 'multi-prefix'])
    expect(c.capabilities.has('server-time')).toBe(true)
    expect(c.capabilities.has('message-tags')).toBe(false)
  })
})
