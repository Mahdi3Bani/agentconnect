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
    expect(ircElicitText('Pick one', { select: { target: target(), index: 0 } })).toBe(
      'Pick one [1] main [2] develop (reply to this with a number)'
    )
  })

  it('reads a number or an option label, and nothing else', () => {
    expect(ircElicitChoice(target(), ' 2 ')).toBe(1)
    expect(ircElicitChoice(target(), 'Develop')).toBe(1)
    expect(ircElicitChoice(target(), '3')).toBeNull()
    expect(ircElicitChoice(target(), 'sure')).toBeNull()
  })
})

type Sent = { target: string; text: string; options?: { maxLines?: number; tags?: Record<string, string> } }

function ircTurn(isDm = false, opts: { requesterId?: string; chatApprovals?: boolean } = {}) {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.store = {
    getSessionByAcpIdForAgent: () => ({ triggeredBy: 'user-1' }),
    getDisplayNames: () => new Map(),
    upsertElicit: vi.fn(async () => {}),
    createPermissionRequest: vi.fn(async () => {}),
    resolvePermissionRequest: vi.fn(async () => true)
  }
  if (opts.chatApprovals) daemon.agents.set('agent-1', { id: 'agent-1', allowRuntimeChangesInChat: true })
  const sent: Sent[] = []
  const pauses: Array<[string, boolean]> = []
  const conn = {
    sendText: async (target: string, text: string, options?: Sent['options']) => {
      sent.push({ target, text, ...(options ? { options } : {}) })
      return [{ id: `srv${sent.length}`, text, confirmed: true }]
    },
    typingPause: (target: string, paused: boolean) => void pauses.push([target, paused])
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
    entry: { msg: opts.requesterId ? { sender: { id: opts.requesterId, name: 'mahdi' } } : {} },
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
  const applied: any[] = []
  daemon.enqueueApply = (_p: any, action: any) => void applied.push(action)
  return { daemon, sent, applied, pauses }
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
        text: `mahdi: ${ircElicitText('Which branch should I cut from?', { select: { target: target(), index: 0 } })}`,
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

  it('shows the agent waiting, not working, until the card is answered', async () => {
    const h = ircTurn()
    await raise(h, form(BRANCH, ['branch']))
    expect(h.pauses).toEqual([['#dev', true]])
    await h.daemon.permissions.claimElicitReply(reply('maybe', 'srv1'))
    expect(h.pauses).toEqual([['#dev', true]])
    await h.daemon.permissions.claimElicitReply(reply('1', 'srv1'))
    expect(h.pauses).toEqual([
      ['#dev', true],
      ['#dev', false]
    ])
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

  it('takes a typed question as a reply carrying the answer, with no card tag since it has no buttons', async () => {
    const h = ircTurn()
    const { result } = await raise(h, form({ name: { type: 'string', title: 'Name' } }, ['name']))
    expect(h.sent[0]).toEqual({
      target: '#dev',
      text: 'mahdi: Which branch should I cut from? (reply to this with your answer)',
      options: { maxLines: 12 }
    })
    expect(await h.daemon.permissions.claimElicitReply(reply('  release/2.4 ', 'srv1'))).toBe(true)
    await expect(result).resolves.toEqual({ action: 'accept', content: { name: 'release/2.4' } })
  })

  it('takes a pick or your own words on an AskUserQuestion-shaped card', async () => {
    const other = {
      type: 'string',
      title: 'Other',
      _meta: { _askUserQuestionCustomAnswer: { isCustomAnswer: true, questionId: 'branch' } }
    }
    const h = ircTurn()
    const { result } = await raise(h, form({ ...BRANCH, other }))
    expect(h.sent[0]!.text).toBe(
      'mahdi: Which branch should I cut from? [1] main [2] develop (reply to this with a number, or your own answer)'
    )
    // Buttons for the options; the free text is a reply.
    expect(h.sent[0]!.options?.tags).toEqual({ '+mosircley.de/card': '{"v":1,"options":["main","develop"]}' })
    expect(await h.daemon.permissions.claimElicitReply(reply('release/2.4', 'srv1'))).toBe(true)
    await expect(result).resolves.toEqual({ action: 'accept', content: { other: 'release/2.4' } })

    // A number or a label is still the pick, never the text.
    const h2 = ircTurn()
    const second = await raise(h2, form({ ...BRANCH, other }))
    await h2.daemon.permissions.claimElicitReply(reply('2', 'srv1'))
    await expect(second.result).resolves.toEqual({ action: 'accept', content: { branch: 'develop' } })
  })

  it('still declines a form one reply cannot answer', async () => {
    const h = ircTurn()
    const req = form({ a: { type: 'string', title: 'A' }, b: { type: 'string', title: 'B' } }, ['a', 'b'])
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

const BASH = {
  sessionId: 's1',
  toolCall: { toolCallId: 'call-1', title: 'Bash', rawInput: { command: 'npm test' } },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' }
  ]
}
const ME = 'account:mahdi'

async function ask(h: ReturnType<typeof ircTurn>) {
  const decided = h.daemon.permissions.onAcpPermission('agent-1', 's1', BASH)
  await vi.waitFor(() => expect([...h.daemon.permissions.pendingElicits.values()][0]?.ts).toBe('srv1'))
  // Wrapped: an async function returning the bare promise would wait for the decision itself.
  return { decided }
}

describe('a tool approval on IRC', () => {
  it('asks the logged-in asker on a card, and their Allow runs it', async () => {
    const h = ircTurn(false, { requesterId: ME, chatApprovals: true })
    const { decided } = await ask(h)
    expect(h.sent[0]).toMatchObject({
      target: '#dev',
      text: 'mahdi: 🔒 The agent wants to run Bash: npm test [1] Allow [2] Always allow [3] Deny (reply to this with a number)',
      options: { tags: { '+mosircley.de/card': '{"v":1,"options":["Allow","Always allow","Deny"]}' } }
    })
    expect(await h.daemon.permissions.claimElicitReply({ ...reply('Allow', 'srv1'), actor: { userId: ME } })).toBe(true)
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } })
    // The console's durable row is written with the tool, and resolved as what was picked.
    expect(h.daemon.store.createPermissionRequest).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'Bash: npm test', status: 'pending' })
    )
    expect(h.daemon.store.resolvePermissionRequest.mock.calls[0]![2]).toBe('allowed')
  })

  it('records Deny as denied, and the runtime gets the reject option', async () => {
    const h = ircTurn(false, { requesterId: ME, chatApprovals: true })
    const { decided } = await ask(h)
    await h.daemon.permissions.claimElicitReply({ ...reply('3', 'srv1'), actor: { userId: ME } })
    await expect(decided).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'reject' } })
    expect(h.daemon.store.resolvePermissionRequest.mock.calls[0]![2]).toBe('denied')
  })

  it("refuses anyone else's tap, and the card stays open", async () => {
    const h = ircTurn(false, { requesterId: ME, chatApprovals: true })
    await ask(h)
    for (const userId of ['account:rob', 'nick:mahdi']) {
      expect(await h.daemon.permissions.claimElicitReply({ ...reply('Allow', 'srv1'), actor: { userId } })).toBe(true)
    }
    expect(h.daemon.permissions.pendingElicits.size).toBe(1)
    expect(h.daemon.store.resolvePermissionRequest).not.toHaveBeenCalled()
    expect(h.applied.filter((a) => a.kind === 'notice').map((a) => a.text)).toEqual([
      'Only the person who asked, logged in to their account, can answer this.',
      'Only the person who asked, logged in to their account, can answer this.'
    ])
  })

  it('leaves an asker with no account to the Agent editors: no card', async () => {
    const h = ircTurn(false, { requesterId: 'nick:mahdi', chatApprovals: true })
    void h.daemon.permissions.onAcpPermission('agent-1', 's1', BASH)
    await vi.waitFor(() => expect(h.daemon.store.createPermissionRequest).toHaveBeenCalled())
    expect(h.sent).toEqual([])
    expect(h.daemon.permissions.pendingElicits.size).toBe(0)
  })

  it('leaves the request to the Agent editors when the agent has not opted in', async () => {
    const h = ircTurn(false, { requesterId: ME })
    void h.daemon.permissions.onAcpPermission('agent-1', 's1', BASH)
    await vi.waitFor(() => expect(h.daemon.store.createPermissionRequest).toHaveBeenCalled())
    expect(h.sent).toEqual([])
  })
})
