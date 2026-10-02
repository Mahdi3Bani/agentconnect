// IRC's elicitation card: a numbered question whose options also ride a client tag, answered by replying to it.
import { describe, it, expect, vi } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk'
import { Daemon } from '../src/daemon.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { elicitForm } from '../src/slack/render.js'
import { IRC_ELICIT_SURFACE, ircElicitChoice, ircElicitText } from '../src/platforms/irc/elicit-card.js'
import { applyIrcAction, type IrcTurnState } from '../src/platforms/irc/turn-output.js'

function form(properties: Record<string, unknown>, required: string[] = []): CreateElicitationRequest {
  return {
    sessionId: 's1',
    mode: 'form',
    message: 'Which branch should I cut from?',
    requestedSchema: { type: 'object', properties, required }
  } as CreateElicitationRequest
}

const BRANCH = { branch: { type: 'string', enum: ['main', 'develop'], title: 'Base branch' } }
const CONVERSATION = '#dev'

function target() {
  return elicitForm(form(BRANCH, ['branch']), IRC_ELICIT_SURFACE)![0]!
}

describe('the IRC card text and the replies it reads', () => {
  it('numbers every option on the question line and says how to answer', () => {
    expect(ircElicitText('Pick one', target())).toBe('Pick one [1] main [2] develop (reply to this with a number)')
  })

  it('reads a number or an option label, and nothing else', () => {
    expect(ircElicitChoice(target(), ' 2 ')).toBe(1)
    expect(ircElicitChoice(target(), 'Develop')).toBe(1)
    expect(ircElicitChoice(target(), '3')).toBeNull()
    expect(ircElicitChoice(target(), 'sure')).toBeNull()
  })
})

type Sent = { target: string; text: string; options?: { maxLines?: number; tags?: Record<string, string> } }

function ircTurn(isDm = false) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: () => new Map(),
    upsertElicit: vi.fn(async () => {})
  }
  const sent: Sent[] = []
  const conn = {
    sendText: async (target: string, text: string, options?: Sent['options']) => {
      sent.push({ target, text, ...(options ? { options } : {}) })
      return [{ id: `srv${sent.length}`, text, confirmed: true }]
    }
  }
  const channel = isDm ? 'mahdi' : '#dev'
  daemon.pending.set(JSON.stringify(['agent-1', 's1']), {
    plan: {
      platform: 'irc',
      agentId: 'agent-1',
      sessionKey: 'k1',
      channel,
      transcriptChannel: channel,
      statusThread: isDm ? 'dm' : 'channel',
      agentName: 'agent',
      isDm,
      approvalSurfaceSuppressed: false
    },
    entry: { msg: {} },
    hostKey: 'agent-1',
    outwardSessionId: 'sess-1',
    conn,
    turnState: { conn, target: channel, isDm, askedBy: 'mahdi' } satisfies IrcTurnState,
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
    conv: { onUpdate: () => [], hasBuffered: () => false },
    rec: { onUpdate: () => [] },
    termOut: new TerminalOutputFolder(),
    workBoundary: new WorkBoundary()
  })
  daemon.enqueueApply = () => {}
  return { daemon, sent }
}

const reply = (text: string, replyTo?: string, conversation = CONVERSATION) => ({
  conversation,
  text,
  ...(replyTo !== undefined ? { replyTo } : {}),
  actor: { userId: 'irc:mahdi' }
})

async function raise(h: ReturnType<typeof ircTurn>, req: CreateElicitationRequest) {
  const result = h.daemon.permissions.onAcpElicit('agent-1', 's1', req)
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.size).toBe(1))
  const requestId = [...h.daemon.permissions.pendingElicits.keys()][0] as string
  await vi.waitFor(() => expect(h.daemon.permissions.pendingElicits.get(requestId).ts).toBe('srv1'))
  return { requestId, result }
}

describe('an IRC turn collects an elicitation answer from a reply', () => {
  it('posts the card addressed to the asker, with the options as a card tag', async () => {
    const h = ircTurn()
    await raise(h, form(BRANCH, ['branch']))
    expect(h.sent).toEqual([
      {
        target: '#dev',
        text: `mahdi: ${ircElicitText('Which branch should I cut from?', target())}`,
        options: { maxLines: 12, tags: { '+mosircley.de/card': '{"v":1,"options":["main","develop"]}' } }
      }
    ])
  })

  it('takes a button tap: a reply to the card with the option label', async () => {
    const h = ircTurn()
    const { result } = await raise(h, form(BRANCH, ['branch']))
    expect(await h.daemon.permissions.claimElicitReply(reply('develop', 'srv1'))).toBe(true)
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
    // IRC cannot edit, so the verdict is its own line, threaded under the card.
    await vi.waitFor(() =>
      expect(h.sent[1]).toEqual({
        target: '#dev',
        text: '✅ develop',
        options: { maxLines: 1, tags: { '+draft/reply': 'srv1' } }
      })
    )
  })

  it('takes a typed number replying to the card', async () => {
    const h = ircTurn()
    const { result } = await raise(h, form(BRANCH, ['branch']))
    expect(await h.daemon.permissions.claimElicitReply(reply('1', 'srv1'))).toBe(true)
    await expect(result).resolves.toEqual({ action: 'accept', content: { branch: 'main' } })
  })

  it('answers only a reply to this card, in this conversation', async () => {
    const h = ircTurn()
    await raise(h, form(BRANCH, ['branch']))
    expect(await h.daemon.permissions.claimElicitReply(reply('2'))).toBe(false)
    expect(await h.daemon.permissions.claimElicitReply(reply('2', 'other-msg'))).toBe(false)
    expect(await h.daemon.permissions.claimElicitReply(reply('2', 'srv1', '#elsewhere'))).toBe(false)
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
  })

  it('keeps the card open and repeats the instruction when the reply names no option', async () => {
    const h = ircTurn()
    await raise(h, form(BRANCH, ['branch']))
    expect(await h.daemon.permissions.claimElicitReply(reply('maybe', 'srv1'))).toBe(true)
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    await vi.waitFor(() => expect(h.sent[1]?.text).toBe('Reply with a number from 1 to 2.'))
  })

  it('does not address a DM card', async () => {
    const h = ircTurn(true)
    await raise(h, form(BRANCH, ['branch']))
    expect(h.sent[0]!.text.startsWith('Which branch')).toBe(true)
  })

  it('still declines a typed question it has no control for', async () => {
    const h = ircTurn()
    const req = form({ note: { type: 'string', title: 'Note' } }, ['note'])
    await expect(h.daemon.permissions.onAcpElicit('agent-1', 's1', req)).resolves.toBeUndefined()
    expect(h.sent).toEqual([])
  })
})

describe('a notice', () => {
  it('is posted, addressed, and never recorded', async () => {
    const sent: Sent[] = []
    const recorded: string[] = []
    const state: IrcTurnState = {
      conn: { sendText: async (target, text, options) => (sent.push({ target, text, options }), []) },
      target: '#dev',
      isDm: false,
      askedBy: 'mahdi'
    }
    await applyIrcAction(state, { kind: 'notice', text: 'I could not ask that here.' }, async (t) => {
      recorded.push(t)
    })
    expect(sent).toEqual([{ target: '#dev', text: 'mahdi: I could not ask that here.', options: { maxLines: 3 } }])
    expect(recorded).toEqual([])
  })
})
