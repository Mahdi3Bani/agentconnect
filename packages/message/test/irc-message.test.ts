import { describe, expect, it } from 'vitest'
import { ircCaseFold, normalizeIrcMessage, stripIrcFormatting, type IrcMessageEvent } from '../src/irc-message.js'

const ctx = { botNick: 'agentconnect', chantypes: '#&', casemapping: 'rfc1459' }
const event: IrcMessageEvent = {
  kind: 'privmsg',
  nick: 'han',
  target: '#cantina',
  text: 'agentconnect: hello there',
  fallbackId: 'local-1',
  receivedAtMs: 1_700_000_000_000
}
const normalize = (over: Partial<IrcMessageEvent> = {}) => normalizeIrcMessage({ ...event, ...over }, 'trace', ctx)

describe('IRC normalization', () => {
  it('uses the server msgid and server-time when message-tags were granted', () => {
    const msg = normalize({ tags: { msgid: 'abc123', time: '2026-09-28T12:00:00.000Z' } })!
    expect(msg.msgId).toBe('irc:#cantina:abc123')
    expect(msg.platformTimeMs).toBe(Date.parse('2026-09-28T12:00:00.000Z'))
  })

  it('falls back to a connection-minted id and time of receipt on a server that grants nothing', () => {
    const msg = normalize()!
    expect(msg.msgId).toBe('irc:#cantina:local-1')
    expect(msg.platformTimeMs).toBe(event.receivedAtMs)
  })

  it('keeps a colon in a msgid from moving the native id boundary', () => {
    expect(normalize({ tags: { msgid: 'a:b' } })!.msgId).toBe('irc:#cantina:a%3Ab')
  })

  it('strips a leading address and records the mention', () => {
    const msg = normalize()!
    expect(msg.text).toBe('hello there')
    expect(msg.mentionedBots).toEqual(['agentconnect'])
    expect(msg.isDm).toBe(false)
  })

  it('matches the nick under rfc1459 casemapping', () => {
    const msg = normalizeIrcMessage({ ...event, text: 'Bot{1}, ping' }, 'trace', { ...ctx, botNick: 'bot[1]' })!
    expect(msg.mentionedBots).toEqual(['bot[1]'])
    expect(msg.text).toBe('ping')
  })

  it('counts a mid-sentence mention but not a nick embedded in another word', () => {
    expect(normalize({ text: 'ask agentconnect about it' })!.mentionedBots).toEqual(['agentconnect'])
    expect(normalize({ text: 'agentconnectors are neat' })!.mentionedBots).toEqual([])
  })

  it('addresses a DM by the sender nick, since that is where the reply goes', () => {
    const msg = normalize({ target: 'agentconnect', text: 'hi' })!
    expect(msg).toMatchObject({ channel: 'han', thread: 'dm', isDm: true, msgId: 'irc:han:local-1' })
  })

  it('prefers the services account over the nick as identity', () => {
    expect(normalize({ tags: { account: 'hsolo' } })!.sender).toEqual({
      id: 'account:hsolo',
      isBot: false,
      name: 'han'
    })
    expect(normalize()!.sender.id).toBe('nick:han')
  })

  it('reads the IRCv3 bot tag as the bot flag', () => {
    expect(normalize({ tags: { bot: true } })!.sender.isBot).toBe(true)
  })

  it('drops its own echoed messages and CTCP, and empty text', () => {
    expect(normalize({ nick: 'AgentConnect' })).toBeNull()
    expect(normalize({ text: '\x01VERSION\x01' })).toBeNull()
    expect(normalize({ text: '\x02\x0f  ' })).toBeNull()
  })

  it('renders an ACTION as the emote it is', () => {
    expect(normalize({ kind: 'action', text: 'waves' })!.text).toBe('* han waves')
  })

  it('carries a reply tag as replyTo', () => {
    expect(normalize({ tags: { '+draft/reply': 'parent1' } })!.replyTo).toBe('parent1')
  })
})

describe('IRC text helpers', () => {
  it('strips mIRC formatting including colour arguments', () => {
    expect(stripIrcFormatting('\x0304,12red\x03 \x02bold\x02 \x1ditalic\x0f')).toBe('red bold italic')
  })

  it('folds per casemapping', () => {
    expect(ircCaseFold('A[]\\^', 'rfc1459')).toBe('a{}|~')
    expect(ircCaseFold('A[]\\^', 'strict-rfc1459')).toBe('a{}|^')
    expect(ircCaseFold('A[]\\^', 'ascii')).toBe('a[]\\^')
  })
})
