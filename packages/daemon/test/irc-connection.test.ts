import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { IrcConnection, type IrcConnectionDeps } from '../src/platforms/irc/connection.js'
import { startTestServer, type TestServer, type TestServerOptions } from '../src/platforms/irc/test-server.js'

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
    expect(members.map((m) => m.id).sort()).toEqual(['nick:chewie', 'nick:han', 'nick:leia'])
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
    expect(profile.id).toBe('nick:han')
  })

  it('reads a profile by the id a message sender carries', async () => {
    const c = await connect()
    expect((await c.getUserProfile('nick:han')).name).toBe('han')
    expect(server!.received).toContain('WHOIS han')
  })

  it('refuses a query target that could inject a second command', async () => {
    const c = await connect()
    await expect(c.listMembers('#a\r\nQUIT')).rejects.toThrow(/invalid IRC target/)
    await expect(c.getUserProfile('han\r\nQUIT')).rejects.toThrow(/invalid IRC target/)
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
  it('sends tags on the first line only, escaped, and is still confirmed by its echo', async () => {
    const c = await connect()
    const receipts = await c.sendText('#cantina', 'word '.repeat(200), {
      tags: { '+mosircley.de/card': '{"v":1,"options":["a b","c;d"]}' }
    })
    expect(receipts.every((r) => r.confirmed)).toBe(true)
    const sent = server!.received.filter((l) => l.includes('PRIVMSG'))
    expect(sent[0]).toMatch(/^@\+mosircley\.de\/card=\{"v":1,"options":\["a\\sb","c\\:d"\]\} PRIVMSG #cantina :/)
    expect(sent.slice(1).every((l) => l.startsWith('PRIVMSG'))).toBe(true)
  })

  it('drops the tags where message-tags was not granted', async () => {
    const c = await connect(['echo-message'])
    await c.sendText('#cantina', 'hello', { tags: { '+draft/reply': 'm1' } })
    expect(server!.received).toContain('PRIVMSG #cantina :hello')
  })
})

describe('staying connected', () => {
  const fast: IrcConnectionDeps = { reconnect: { baseMs: 10, maxMs: 50 } }
  const withChannels = async (deps: IrcConnectionDeps = fast, options: TestServerOptions = {}) => {
    server = await startTestServer(options)
    conn = new IrcConnection(
      { host: '127.0.0.1', port: server.port, tls: false, nick: 'agentconnect', channels: ['#cantina'] },
      deps
    )
    await conn.start()
    return conn
  }

  it('joins its channels once registered', async () => {
    await withChannels()
    await vi.waitFor(() => expect(server!.received).toContain('JOIN #cantina'))
  })

  it('reconnects after a drop and rejoins its channels', async () => {
    const c = await withChannels()
    await vi.waitFor(() => expect(server!.received).toContain('JOIN #cantina'))
    server!.drop()
    await vi.waitFor(() => expect(server!.connections()).toBe(2))
    await vi.waitFor(() => expect(server!.received.filter((l) => l === 'JOIN #cantina')).toHaveLength(2))
    const [receipt] = await c.sendText('#cantina', 'back')
    expect(receipt!.confirmed).toBe(true)
  })

  it('joins a channel it is invited to, keeps it across a reconnect, and ignores a non-channel', async () => {
    await withChannels()
    server!.push(':han!h@host INVITE agentconnect #hangar')
    server!.push(':han!h@host INVITE agentconnect han')
    await vi.waitFor(() => expect(server!.received).toContain('JOIN #hangar'))
    server!.drop()
    await vi.waitFor(() => expect(server!.received.filter((l) => l === 'JOIN #hangar')).toHaveLength(2))
    expect(server!.received).not.toContain('JOIN han')
  })

  it('fails a send while disconnected instead of dropping it silently', async () => {
    const warnings: string[] = []
    // A long backoff keeps it disconnected for the duration of the send.
    const c = await withChannels({
      reconnect: { baseMs: 60_000, maxMs: 60_000 },
      log: { info: () => {}, warn: (m) => warnings.push(m) }
    })
    server!.drop()
    await vi.waitFor(() => expect(warnings.join()).toMatch(/disconnected/))
    await expect(c.sendText('#cantina', 'lost')).rejects.toThrow(/connection is down/)
  })

  it('takes an alternate nick when its own is still held by a ghost', async () => {
    const seen: NormalizedMessage[] = []
    server = await startTestServer({ takenNicks: ['agentconnect'] })
    conn = new IrcConnection(
      { host: '127.0.0.1', port: server.port, tls: false, nick: 'agentconnect' },
      { onMessage: (m) => seen.push(m) }
    )
    await conn.start()
    expect(server.received).toContain('NICK agentconnect_')
    // A mention is spotted on the nick the server gave us, and reported as the identity routing binds.
    server.push(':han!h@host PRIVMSG #cantina :agentconnect_: hi')
    await vi.waitFor(() => expect(seen[0]?.mentionedBots).toEqual([conn!.botUserId]))
    expect(conn.botUserId).toBe('agentconnect')
  })

  it('does not reconnect after stop', async () => {
    const c = await withChannels()
    await c.stop()
    await new Promise((r) => setTimeout(r, 100))
    expect(server!.connections()).toBe(1)
    conn = undefined
  })
})

describe('long answers', () => {
  it('cuts an answer at maxLines with a notice as the last line', async () => {
    const c = await connect()
    const receipts = await c.sendText('#cantina', Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n'), {
      maxLines: 3
    })
    expect(receipts.map((r) => r.text)).toEqual(['line 0', 'line 1', '[… 8 more lines not sent]'])
  })

  it('keeps bold intact across a split, on the wire', async () => {
    const c = await connect()
    await c.sendText('#cantina', `\x02${'word '.repeat(150)}\x02`)
    const lines = server!.received.filter((l) => l.startsWith('PRIVMSG'))
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect([...line].filter((ch) => ch === '\x02').length % 2).toBe(0)
  })
})

describe('SASL', () => {
  it('logs in with the configured account, the shape irc-framework actually reads', async () => {
    server = await startTestServer({ saslAccounts: { r2d2: 'beep' } })
    conn = new IrcConnection({
      host: '127.0.0.1',
      port: server.port,
      tls: false,
      nick: 'r2d2',
      account: { username: 'r2d2', password: 'beep' }
    })
    await conn.start()
    expect(server.authenticated).toEqual(['r2d2'])
  })
})

describe('bot mode', () => {
  it('sets the mode the server offers for bots, so it tags our messages as a bot', async () => {
    await connect(undefined, { botMode: 'B' })
    await vi.waitFor(() => expect(server!.received).toContain('MODE agentconnect +B'))
  })

  it('sets nothing on a network without one', async () => {
    await connect()
    await new Promise((r) => setTimeout(r, 50))
    expect(server!.received.some((l) => l.startsWith('MODE agentconnect'))).toBe(false)
  })
})

describe('typing', () => {
  const typing = () => server!.received.filter((l) => l.includes('TAGMSG'))

  it('says active while a turn works, refreshing, and done when the last one ends', async () => {
    const c = await connect()
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      c.typingStart('#cantina')
      c.typingStart('#cantina')
      await vi.waitFor(() => expect(typing()).toEqual(['@+typing=active TAGMSG #cantina']))
      vi.advanceTimersByTime(3_000)
      await vi.waitFor(() => expect(typing()).toHaveLength(2))
      // One of two turns ending is not the end of the typing.
      c.typingStop('#cantina')
      c.typingStop('#cantina')
      await vi.waitFor(() => expect(typing().at(-1)).toBe('@+typing=done TAGMSG #cantina'))
      const sent = typing().length
      vi.advanceTimersByTime(9_000)
      await new Promise((r) => setTimeout(r, 20))
      expect(typing()).toHaveLength(sent)
    } finally {
      vi.useRealTimers()
    }
  })

  it('goes quiet while a question waits on a person, and resumes once answered', async () => {
    const c = await connect()
    c.typingStart('#cantina')
    c.typingPause('#cantina', true)
    c.typingPause('#cantina', false)
    await vi.waitFor(() =>
      expect(typing()).toEqual([
        '@+typing=active TAGMSG #cantina',
        '@+typing=done TAGMSG #cantina',
        '@+typing=active TAGMSG #cantina'
      ])
    )
    c.typingStop('#cantina')
  })

  it('sends nothing where message-tags was not granted', async () => {
    const c = await connect(['echo-message'])
    c.typingStart('#cantina')
    c.typingStop('#cantina')
    await new Promise((r) => setTimeout(r, 50))
    expect(typing()).toEqual([])
  })
})
