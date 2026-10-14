// An answer that ends on a question and a numbered list: the list rides as card buttons, and the reply comes back.
import { afterEach, describe, expect, it } from 'vitest'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { IrcConnection } from '../src/platforms/irc/connection.js'
import { ircSoftQuestion } from '../src/platforms/irc/soft-question.js'
import { startTestServer, type TestServer } from '../src/platforms/irc/test-server.js'
import { applyIrcAction, type IrcReplyPort, type IrcTurnState } from '../src/platforms/irc/turn-output.js'

describe('a question in an answer', () => {
  it('is read from a question line and the numbered list after it', () => {
    expect(
      ircSoftQuestion(
        'I can store todos two ways.\n\nWhich storage should I use?\n1. **JSON file** — simple\n2. SQLite: queryable\n3. `Postgres`'
      )
    ).toEqual(['JSON file', 'SQLite', 'Postgres'])
    expect(ircSoftQuestion('Pick one:\n[1] Yes\n[2] No\nWhich do you prefer?')).toEqual(['Yes', 'No'])
  })

  it('is not read from a list of steps, a list mid-answer, or a list that skips numbers', () => {
    expect(ircSoftQuestion('Usage:\n1. node todo.js add\n2. node todo.js list')).toBeNull()
    expect(ircSoftQuestion('Which?\n1. a\n2. b\n\nI went with a, it is done.')).toBeNull()
    expect(ircSoftQuestion('Which?\n1. a\n3. b')).toBeNull()
    expect(ircSoftQuestion('Which?\n1. only one')).toBeNull()
  })
})

describe('an answer ending on a question', () => {
  const port = () => {
    const sent: { text: string; tags?: Record<string, string> }[] = []
    const expected: [string, string[]][] = []
    const conn: IrcReplyPort = {
      sendText: async (_target, text, options) => {
        sent.push({ text, ...(options?.tags ? { tags: options.tags } : {}) })
        return [{ id: 'srv9', text, confirmed: true }]
      },
      expectAnswer: (target, ids) => void expected.push([target, ids])
    }
    return { sent, expected, conn }
  }

  it('carries the options as a card, and expects the reply to it or to the thread', async () => {
    const { sent, expected, conn } = port()
    const state: IrcTurnState = { conn, target: '#test', isDm: false, askedBy: 'mahdi', replyTo: 'q1' }
    await applyIrcAction(state, { kind: 'post', text: 'Which storage?\n1. JSON\n2. SQLite' }, async () => {})
    expect(sent[0]!.tags).toEqual({
      '+draft/reply': 'q1',
      '+mosircley.de/card': JSON.stringify({ v: 1, options: ['JSON', 'SQLite'] })
    })
    expect(expected).toEqual([['#test', ['srv9', 'q1']]])
  })

  it('is an ordinary answer otherwise', async () => {
    const { sent, expected, conn } = port()
    await applyIrcAction(
      { conn, target: '#test', isDm: false, askedBy: 'mahdi' },
      { kind: 'post', text: 'Done.' },
      async () => {}
    )
    expect(sent[0]!.tags).toBeUndefined()
    expect(expected).toEqual([])
  })
})

describe('the reply to an open question', () => {
  let server: TestServer | undefined
  let conn: IrcConnection | undefined
  afterEach(async () => {
    await conn?.stop()
    await server?.close()
  })

  it('reaches the agent without its nick, once', async () => {
    const seen: NormalizedMessage[] = []
    server = await startTestServer({})
    conn = new IrcConnection(
      { host: '127.0.0.1', port: server.port, tls: false, nick: 'agentbot' },
      {
        onMessage: (m) => seen.push(m)
      }
    )
    await conn.start()
    conn.expectAnswer('#test', ['srv9', 'q1'])
    server.push('@msgid=r1;+draft/reply=srv9;+mosircley.de/answer=2 :mahdi!m@h PRIVMSG #test :SQLite')
    server.push('@msgid=r2;+draft/reply=srv9 :mahdi!m@h PRIVMSG #test :thanks')
    server.push('@msgid=r3 :rob!r@h PRIVMSG #test :unrelated')
    await new Promise((r) => setTimeout(r, 100))
    expect(seen.map((m) => [m.text, m.mentionedBots])).toEqual([
      ['SQLite', ['agentbot']],
      ['thanks', []],
      ['unrelated', []]
    ])
  })
})
