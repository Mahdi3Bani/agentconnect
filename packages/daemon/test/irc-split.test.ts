import { describe, expect, it } from 'vitest'
import { IrcFloodGate } from '../src/platforms/irc/flood.js'
import { IRC_LINE_MAX_BYTES, ircPayloadBudget, splitIrcText } from '../src/platforms/irc/split.js'

const bytes = (s: string) => new TextEncoder().encode(s).length

describe('the 512-byte line', () => {
  it('budgets for the hostmask the server prepends, not just what we send', () => {
    const self = { nick: 'agentconnect', username: '~ac', host: 'example.org' }
    const budget = ircPayloadBudget('PRIVMSG', '#cantina', self)
    const relayed = `:agentconnect!~ac@example.org PRIVMSG #cantina :${'x'.repeat(budget)}\r\n`
    expect(bytes(relayed)).toBe(IRC_LINE_MAX_BYTES)
  })

  it('assumes a worst-case host before the server has told us ours', () => {
    const known = ircPayloadBudget('PRIVMSG', '#c', { nick: 'n', username: 'u', host: 'h' })
    expect(ircPayloadBudget('PRIVMSG', '#c', { nick: 'n' })).toBeLessThan(known - 60)
  })

  it('breaks at whitespace and drops the space it broke on', () => {
    expect(splitIrcText('aaaa bbbb cccc', 10)).toEqual(['aaaa bbbb', 'cccc'])
  })

  it('hard-breaks a word with no whitespace to break on', () => {
    expect(splitIrcText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('never splits inside a grapheme, even when that leaves a line short', () => {
    const family = '👨‍👩‍👧' // 18 bytes, one grapheme
    const lines = splitIrcText(`ab${family}${family}`, 20)
    expect(lines).toEqual([`ab${family}`, family])
    for (const line of lines) expect(bytes(line)).toBeLessThanOrEqual(20)
  })

  it('counts bytes, not UTF-16 units', () => {
    const lines = splitIrcText('é'.repeat(10), 5) // 2 bytes each
    expect(lines).toEqual(['éé', 'éé', 'éé', 'éé', 'éé'])
  })

  it('turns newlines into separate messages and drops blank lines', () => {
    expect(splitIrcText('one\r\n\ntwo\rthree\n  \n', 100)).toEqual(['one', 'two', 'three'])
  })

  it('strips NUL, which no line may carry', () => {
    expect(splitIrcText('a\x00b', 100)).toEqual(['ab'])
  })

  it('falls back to code points for a grapheme wider than a whole line', () => {
    const zalgo = 'e' + '́'.repeat(10) // one grapheme, 21 bytes
    const lines = splitIrcText(zalgo, 8)
    expect(lines.join('')).toBe(zalgo)
    for (const line of lines) expect(bytes(line)).toBeLessThanOrEqual(8)
  })
})

describe('RFC 1459 flood pacing', () => {
  it('lets a burst of four through, then one line per penalty', async () => {
    let clock = 0
    const slept: number[] = []
    const gate = new IrcFloodGate(
      2_000,
      8_000,
      () => clock,
      async (ms) => {
        slept.push(ms)
        clock += ms
      }
    )
    const sentAt: number[] = []
    for (let i = 0; i < 6; i++) {
      await gate.take()
      sentAt.push(clock)
    }
    expect(sentAt).toEqual([0, 0, 0, 0, 2_000, 4_000])
  })

  it('recovers the burst after the line goes quiet', async () => {
    let clock = 0
    const gate = new IrcFloodGate(
      2_000,
      8_000,
      () => clock,
      async (ms) => void (clock += ms)
    )
    for (let i = 0; i < 4; i++) await gate.take()
    clock += 60_000
    const before = clock
    for (let i = 0; i < 4; i++) await gate.take()
    expect(clock).toBe(before)
  })
})
