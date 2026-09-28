import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { IrcConnection, type IrcConnectionDeps } from '../src/irc/connection.js'
import { startTestServer, type TestServer, type TestServerOptions } from '../src/irc/test-server.js'

let server: TestServer | undefined
let conn: IrcConnection | undefined

afterEach(async () => {
  await conn?.stop()
  await server?.close()
  conn = undefined
  server = undefined
})

async function connect(
  caps?: string[],
  options: TestServerOptions = {},
  deps: IrcConnectionDeps = {}
): Promise<IrcConnection> {
  server = await startTestServer(caps === undefined ? options : { ...options, caps })
  conn = new IrcConnection(
    {
      host: '127.0.0.1',
      port: server.port,
      tls: false,
      nick: 'agentconnect'
    },
    deps
  )
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

function nextMessage(): { deps: IrcConnectionDeps; received: Promise<NormalizedMessage> } {
  let deliver: (msg: NormalizedMessage) => void = () => {}
  const received = new Promise<NormalizedMessage>((resolve) => (deliver = resolve))
  return { deps: { onMessage: (msg) => deliver(msg) }, received }
}

describe('inbound PRIVMSG', () => {
  it('normalizes with the server msgid where message-tags were granted', async () => {
    const { deps, received } = nextMessage()
    await connect(undefined, {}, deps)
    server!.push('@msgid=m42;time=2026-09-28T12:00:00.000Z :han!h@host PRIVMSG #cantina :agentconnect: hi')
    expect(await received).toMatchObject({
      platform: 'irc',
      msgId: 'irc:#cantina:m42',
      channel: '#cantina',
      text: 'hi',
      mentionedBots: ['agentconnect'],
      platformTimeMs: Date.parse('2026-09-28T12:00:00.000Z')
    })
  })

  it('mints a local id on a server that grants nothing', async () => {
    const { deps, received } = nextMessage()
    await connect([], {}, deps)
    server!.push(':han!h@host PRIVMSG agentconnect :psst')
    const msg = await received
    expect(msg).toMatchObject({ channel: 'han', isDm: true, text: 'psst' })
    expect(msg.msgId).toMatch(/^irc:han:local-\d+-\d+$/)
  })
})

describe('outbound PRIVMSG', () => {
  it('is confirmed by echo-message and carries the server msgid', async () => {
    const c = await connect()
    const [receipt] = await c.sendText('#cantina', 'hello')
    expect(receipt).toMatchObject({ id: 'srv1', text: 'hello', confirmed: true })
  })

  it('does not turn its own echo into an inbound message', async () => {
    const seen: NormalizedMessage[] = []
    const c = await connect(undefined, {}, { onMessage: (m) => seen.push(m) })
    await c.sendText('#cantina', 'hello')
    expect(seen).toEqual([])
  })

  it('is confirmed without an id where echo-message is granted but message-tags is not', async () => {
    const c = await connect(['echo-message'])
    const [receipt] = await c.sendText('#cantina', 'hello')
    expect(receipt!.confirmed).toBe(true)
    expect(receipt!.id).toMatch(/^local-/)
  })

  it('is sent but unconfirmed where echo-message was not granted', async () => {
    const c = await connect([])
    const [receipt] = await c.sendText('#cantina', 'hello')
    expect(receipt!.confirmed).toBe(false)
    // Unconfirmed means written to the socket, not seen by the server, so wait for it to land.
    await vi.waitFor(() => expect(server!.received).toContain('PRIVMSG #cantina :hello'))
  })

  it('reports unconfirmed when a granted echo never arrives', async () => {
    const c = await connect(undefined, { withholdEcho: true }, { echoTimeoutMs: 50 })
    const [receipt] = await c.sendText('#cantina', 'hello')
    expect(receipt!.confirmed).toBe(false)
  })

  it('splits a long message into lines that fit the relayed 512 bytes', async () => {
    const c = await connect()
    const receipts = await c.sendText('#cantina', 'word '.repeat(200))
    expect(receipts.length).toBeGreaterThan(1)
    expect(receipts.every((r) => r.confirmed)).toBe(true)
    for (const line of server!.received.filter((l) => l.startsWith('PRIVMSG'))) {
      // The server relays it with our full hostmask; worst case, since this server never told us ours.
      expect(
        new TextEncoder().encode(`:agentconnect!${'u'.repeat(11)}@${'h'.repeat(63)} ${line}\r\n`).length
      ).toBeLessThanOrEqual(512)
    }
  })

  it('refuses a target that could inject a second command', async () => {
    const c = await connect()
    await expect(c.sendText('#cantina\r\nQUIT', 'x')).rejects.toThrow(/invalid IRC target/)
    await expect(c.sendText('#a #b', 'x')).rejects.toThrow(/invalid IRC target/)
  })
})
