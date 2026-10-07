import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { carryFormatting, renderIrcText } from '../src/platforms/irc/render.js'
import {
  applyIrcAction,
  initialIrcTurnState,
  IRC_MAX_ANSWER_LINES,
  IRC_MAX_LONG_FORM_LINES,
  IrcConverger,
  ircThreadRoot,
  type IrcReplyPort,
  type IrcTurnState
} from '../src/platforms/irc/turn-output.js'

const chunk = (text: string, phase?: string, messageId?: string): SessionUpdate => ({
  sessionUpdate: 'agent_message_chunk',
  content: { type: 'text', text },
  ...(phase ? { _meta: { codex: { phase } } } : {}),
  ...(messageId ? { messageId } : {})
})
const tool = (id = 'tool'): SessionUpdate => ({
  sessionUpdate: 'tool_call',
  toolCallId: id,
  title: 'Check',
  status: 'in_progress'
})

describe('markdown to IRC', () => {
  it('turns bold and italics into mIRC codes', () => {
    expect(renderIrcText('**bold** and *soft*')).toBe('\x02bold\x02 and \x1dsoft\x1d')
  })

  it('shows a link URL, once when it is its own text', () => {
    expect(renderIrcText('see [the docs](https://x.dev/a) or <https://x.dev/b>')).toBe(
      'see the docs <https://x.dev/a> or https://x.dev/b'
    )
  })

  it('keeps code block lines verbatim, each in monospace, and drops the fences', () => {
    expect(renderIrcText('run:\n\n```sh\nnpm test\n  --watch\n```')).toBe('run:\n\n\x11npm test\x11\n\x11  --watch\x11')
  })

  it('renders headings bold, and lists and quotes as their plain-text conventions, a blank line apart', () => {
    expect(renderIrcText('# Plan\n\n1. one\n2. two\n   - nested\n\n> quoted')).toBe(
      '\x02Plan\x02\n\n1. one\n2. two\n   - nested\n\n> quoted'
    )
  })

  it('carries bold across a line break, since clients reset formatting at every line', () => {
    expect(carryFormatting(['\x02bold', 'still\x02 plain'])).toEqual(['\x02bold\x02', '\x02still\x02 plain'])
    expect(carryFormatting(['\x02a\x0f', 'b'])).toEqual(['\x02a\x0f', 'b'])
  })
})

describe('IRC turn output', () => {
  it('posts only the final answer, never streamed partials', () => {
    const c = new IrcConverger('medium', false)
    expect(c.onUpdate(chunk('Working '))).toEqual([])
    expect(c.onUpdate(chunk('**done**.'))).toEqual([])
    expect(c.onFinal()).toEqual([{ kind: 'post', text: 'Working \x02done\x02.', attributed: false }])
    expect(c.onFinal()).toEqual([])
  })

  it('sends progress in a channel only in high mode, and in a DM from medium', () => {
    const progress = (mode: string, isDm: boolean) => {
      const c = new IrcConverger(mode, isDm)
      c.onUpdate(chunk('Checking the input.'))
      return c.onUpdate(tool())
    }
    expect(progress('medium', false)).toEqual([])
    expect(progress('high', false)).toMatchObject([{ kind: 'irc-progress', text: 'Checking the input.' }])
    expect(progress('medium', true)).toMatchObject([{ kind: 'irc-progress' }])
  })

  it('rations progress: two at most, 15s apart, one line each', () => {
    let clock = 0
    const c = new IrcConverger('high', false, undefined, () => clock)
    c.onUpdate(chunk('Two\nlines.', undefined, 'a'))
    expect(c.onUpdate(tool('1'))).toEqual([])
    c.onUpdate(chunk('First.', undefined, 'b'))
    expect(c.onUpdate(tool('2'))).toMatchObject([{ text: 'First.' }])
    c.onUpdate(chunk('Too soon.', undefined, 'c'))
    expect(c.onUpdate(tool('3'))).toEqual([])
    clock = 15_000
    c.onUpdate(chunk('Second.', undefined, 'd'))
    expect(c.onUpdate(tool('4'))).toMatchObject([{ text: 'Second.' }])
    clock = 30_000
    c.onUpdate(chunk('Third.', undefined, 'e'))
    expect(c.onUpdate(tool('5'))).toEqual([])
  })

  it('records but does not send in mode none', () => {
    const c = new IrcConverger('none', false)
    c.onUpdate(chunk('quiet'))
    expect(c.onFinal()).toEqual([{ kind: 'post', text: 'quiet', attributed: false, recordOnly: true }])
  })
})

describe('applying IRC actions', () => {
  const port = () => {
    const sent: { target: string; text: string; maxLines?: number }[] = []
    const conn: IrcReplyPort = {
      sendText: async (target, text, options) => {
        sent.push({ target, text, maxLines: options?.maxLines })
        return []
      }
    }
    return { sent, conn }
  }

  it('addresses a channel answer to whoever asked, and caps its length', async () => {
    const { sent, conn } = port()
    const recorded: string[] = []
    const state: IrcTurnState = { conn, target: '#cantina', isDm: false, askedBy: 'han' }
    await applyIrcAction(state, { kind: 'post', text: 'answer' }, async (t) => void recorded.push(t))
    expect(sent).toEqual([{ target: '#cantina', text: 'han: answer', maxLines: IRC_MAX_ANSWER_LINES.channel }])
    expect(recorded).toEqual(['answer'])
  })

  it('does not address a DM', async () => {
    const { sent, conn } = port()
    await applyIrcAction(
      { conn, target: 'han', isDm: true, askedBy: 'han' },
      { kind: 'post', text: 'hi' },
      async () => {}
    )
    expect(sent[0]).toMatchObject({ target: 'han', text: 'hi', maxLines: IRC_MAX_ANSWER_LINES.dm })
  })

  it('skips a final answer identical to the progress line already sent', async () => {
    const { sent, conn } = port()
    const state: IrcTurnState = { conn, target: 'han', isDm: true }
    await applyIrcAction(state, { kind: 'irc-progress', text: 'Done.' }, async () => {})
    await applyIrcAction(state, { kind: 'post', text: 'Done.' }, async () => {})
    expect(sent).toHaveLength(1)
  })

  it('records a record-only answer without sending it', async () => {
    const { sent, conn } = port()
    const recorded: string[] = []
    await applyIrcAction(
      { conn, target: 'han', isDm: true },
      { kind: 'post', text: 'kept', recordOnly: true },
      async (t) => void recorded.push(t)
    )
    expect(sent).toEqual([])
    expect(recorded).toEqual(['kept'])
  })
})

describe('answering in the thread, long-form', () => {
  const message = (extra: Record<string, unknown> = {}) =>
    ({ channel: '#dev', msgId: 'irc:#dev:q1', sender: { id: 'account:mahdi', name: 'mahdi' }, ...extra }) as any

  it('replies to the question, or to the thread it was asked in, and to nothing without a server msgid', () => {
    expect(ircThreadRoot(message())).toBe('q1')
    expect(ircThreadRoot(message({ replyTo: 'root7' }))).toBe('root7')
    expect(ircThreadRoot(message({ msgId: 'irc:#dev:local-1-2' }))).toBeUndefined()
  })

  it('posts the answer as a reply to the question, long-form where the connection sends multiline', async () => {
    const sent: { text: string; options?: unknown }[] = []
    const conn: IrcReplyPort = {
      sendText: async (_target, text, options) => {
        sent.push({ text, options })
        return []
      },
      longForm: () => true
    }
    const state = initialIrcTurnState({ mode: 'medium', isDm: false, message: message(), egress: conn } as any)
    await applyIrcAction(state, { kind: 'post', text: 'a long answer' }, async () => {})
    await applyIrcAction(state, { kind: 'notice', text: 'heads up' }, async () => {})
    expect(sent).toEqual([
      {
        text: 'mahdi: a long answer',
        options: { maxLines: IRC_MAX_LONG_FORM_LINES.channel, tags: { '+draft/reply': 'q1' } }
      },
      { text: 'mahdi: heads up', options: { maxLines: 3, tags: { '+draft/reply': 'q1' } } }
    ])
  })
})

describe('typing for the life of a turn', () => {
  const ctx = (mode: string, calls: string[]) =>
    ({
      mode,
      isDm: false,
      message: { channel: '#dev', sender: { id: 'account:mahdi', name: 'mahdi' } },
      egress: {
        sendText: async () => [],
        typingStart: (t: string) => void calls.push(`start ${t}`),
        typingStop: (t: string) => void calls.push(`stop ${t}`)
      }
    }) as any

  it('starts with the turn and stops at settlement', async () => {
    const { createIrcTurnOutput } = await import('../src/platforms/irc/surface.js')
    const surface = createIrcTurnOutput(async () => {})
    const calls: string[] = []
    const state = surface.initialTurnState(ctx('medium', calls))
    expect(calls).toEqual(['start #dev'])
    await surface.onSettle!({ turnState: state } as any)
    expect(calls).toEqual(['start #dev', 'stop #dev'])
  })

  it('stays quiet in none mode, where the turn shows nothing at all', async () => {
    const { initialIrcTurnState } = await import('../src/platforms/irc/turn-output.js')
    const calls: string[] = []
    initialIrcTurnState(ctx('none', calls))
    expect(calls).toEqual([])
  })
})
