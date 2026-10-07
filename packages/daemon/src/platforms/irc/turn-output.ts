import type { SessionUpdate } from '@agentclientprotocol/sdk'
import { GithubReplyCollector } from '../../github/poster.js'
import { flattenUnsafeLinks } from '../../messages/agent-links.js'
import { AgentMessageRun, WorkBoundary } from '../../messages/message-boundary.js'
import type { NormalizedMessage } from '../../messages/normalized.js'
import type { WorkspaceFileLinkResolver } from '../../messages/workspace-file-links.js'
import { isNoResponseBody } from '../../session/no-response.js'
import type { TurnOutputContext } from '../turn-output.js'
import type { IrcSendReceipt } from './connection.js'
import { renderIrcText } from './render.js'

/** An answer longer than this is cut, with a notice: a channel is shared, and 1 line per 2s makes a long one a minute. */
export const IRC_MAX_ANSWER_LINES = { channel: 12, dm: 40 }
/** Where a post is one multiline message, it arrives at once and a client can fold it, so it may be long-form. */
export const IRC_MAX_LONG_FORM_LINES = { channel: 200, dm: 400 }
// Progress is one short line, twice per turn at most, at least 15s apart.
const PROGRESS_MAX_BYTES = 300
const PROGRESS_MAX_COUNT = 2
const PROGRESS_MIN_GAP_MS = 15_000
// A notice (e.g. why a question could not be asked here) is a sentence or two.
const NOTICE_MAX_LINES = 3

export type IrcAction = {
  kind: 'post' | 'irc-progress'
  text: string
  attributed: boolean
  recordOnly?: boolean
}

/** What a turn needs from the connection; `IrcConnection` is one. */
export interface IrcReplyPort {
  sendText(
    target: string,
    text: string,
    options?: { maxLines?: number; tags?: Record<string, string> }
  ): Promise<IrcSendReceipt[]>
  /** IRCv3 typing, best effort; absent on a port that cannot show it. */
  typingStart?(target: string): void
  typingStop?(target: string): void
  typingPause?(target: string, paused: boolean): void
  /** Whether a post goes out as one multiline message; absent means line by line. */
  longForm?(): boolean
}

// IRC cannot edit or delete, so nothing streams: one final post, and progress only as rationed completed messages.
export class IrcConverger {
  private readonly collector = new GithubReplyCollector()
  private readonly messages = new AgentMessageRun()
  private readonly work = new WorkBoundary()
  private text = ''
  private phase = ''
  private progressCount = 0
  private lastProgressAt = Number.NEGATIVE_INFINITY
  private finalized = false

  constructor(
    private readonly mode: string,
    private readonly isDm: boolean,
    private readonly resolveFileLink?: WorkspaceFileLinkResolver,
    private readonly now: () => number = () => Date.now()
  ) {}

  onUpdate(update: SessionUpdate): IrcAction[] {
    if (this.finalized) return []
    const actions: IrcAction[] = []
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      const phase = (update._meta as { codex?: { phase?: string } } | undefined)?.codex?.phase ?? ''
      if (this.messages.opens(update) || (phase && this.phase && phase !== this.phase))
        actions.push(...this.completeMessage())
      this.text += update.content.text
      if (phase) this.phase = phase
    } else if (this.work.opens(update)) actions.push(...this.completeMessage())
    this.collector.onUpdate(update)
    return actions
  }

  private progressAllowed(): boolean {
    return this.isDm ? ['medium', 'high'].includes(this.mode) : this.mode === 'high'
  }

  private completeMessage(): IrcAction[] {
    const text = renderIrcText(flattenUnsafeLinks(this.text, { resolveFileLink: this.resolveFileLink })).trim()
    const phase = this.phase
    this.text = ''
    this.phase = ''
    if (
      !this.progressAllowed() ||
      phase === 'final_answer' ||
      !text ||
      isNoResponseBody(text) ||
      text.includes('\n') ||
      Buffer.byteLength(text) > PROGRESS_MAX_BYTES ||
      this.progressCount >= PROGRESS_MAX_COUNT ||
      this.now() - this.lastProgressAt < PROGRESS_MIN_GAP_MS
    )
      return []
    this.progressCount++
    this.lastProgressAt = this.now()
    return [{ kind: 'irc-progress', text, attributed: false }]
  }

  onFinal(_attribution?: unknown): IrcAction[] {
    if (this.finalized) return []
    this.finalized = true
    const markdown = this.collector.finalText(true, { resolveFileLink: this.resolveFileLink })
    const text = markdown && !isNoResponseBody(markdown.trim()) ? renderIrcText(markdown) : ''
    return text
      ? [{ kind: 'post', text, attributed: false, ...(this.mode === 'none' ? { recordOnly: true } : {}) }]
      : []
  }

  flushTerminal(): IrcAction[] {
    return this.onFinal()
  }
  flushBuffered(): IrcAction[] {
    return []
  }
  hasBuffered(): boolean {
    return false
  }
  hasStreamingUpdate(): boolean {
    return false
  }
}

export interface IrcTurnState {
  conn?: IrcReplyPort
  /** Where the reply goes: the channel, or for a DM the sender's nick. */
  target: string
  isDm: boolean
  /** Who asked, so a channel answer can be addressed to them the IRC way. */
  askedBy?: string
  /** The msgid every post of the turn replies to (+draft/reply), so a client threads the answer under the question. */
  replyTo?: string
  lastProgress?: string
}

export function initialIrcTurnState(ctx: TurnOutputContext<NormalizedMessage>): IrcTurnState {
  const conn = ctx.egress as IrcReplyPort | undefined
  // Typing runs for the turn's life: started with its state, stopped by the surface's onSettle.
  if (ctx.mode !== 'none') conn?.typingStart?.(ctx.message.channel)
  const replyTo = ircThreadRoot(ctx.message)
  return {
    conn,
    target: ctx.message.channel,
    isDm: ctx.isDm,
    ...(ctx.message.sender.name ? { askedBy: ctx.message.sender.name } : {}),
    ...(replyTo ? { replyTo } : {})
  }
}

/**
 * The thread a turn answers in: the one the question was asked in (threads are flat, a reply names the root), or
 * the question itself. Undefined when the server gave the question no msgid, as there is nothing to reply to.
 */
export function ircThreadRoot(message: NormalizedMessage): string | undefined {
  if (message.replyTo) return message.replyTo
  const prefix = `irc:${message.channel}:`
  const native = message.msgId?.startsWith(prefix) ? message.msgId.slice(prefix.length) : ''
  return native && !native.startsWith('local-') ? native : undefined
}

/** The tags a post of the turn carries: the reply that threads it. */
export function ircThreadTags(state: IrcTurnState): Record<string, string> | undefined {
  return state.replyTo ? { '+draft/reply': state.replyTo } : undefined
}

export async function applyIrcAction(
  state: IrcTurnState,
  action: { kind: string; text?: string; recordOnly?: boolean },
  record: (text: string) => Promise<void>
): Promise<void> {
  if (!action.text) return
  // Core's notices are chrome: posted, never recorded, as on every other surface.
  if (action.kind === 'notice') {
    if (state.conn)
      await state.conn.sendText(state.target, addressed(state, action.text), {
        maxLines: NOTICE_MAX_LINES,
        ...thread(state)
      })
    return
  }
  if (action.kind !== 'post' && action.kind !== 'irc-progress') return
  // A final answer identical to the progress line already sent would be the same line twice.
  if (action.kind === 'post' && !action.recordOnly && action.text === state.lastProgress) return
  await record(action.text)
  if (action.recordOnly || !state.conn) return
  const text = addressed(state, action.text)
  if (action.kind === 'irc-progress') {
    await state.conn.sendText(state.target, text, { maxLines: 1, ...thread(state) })
    state.lastProgress = action.text
    return
  }
  const caps = state.conn.longForm?.() ? IRC_MAX_LONG_FORM_LINES : IRC_MAX_ANSWER_LINES
  await state.conn.sendText(state.target, text, { maxLines: state.isDm ? caps.dm : caps.channel, ...thread(state) })
}

function thread(state: IrcTurnState): { tags?: Record<string, string> } {
  const tags = ircThreadTags(state)
  return tags ? { tags } : {}
}

// `nick: text` is how a channel reply says who it answers; a DM needs no address.
function addressed(state: IrcTurnState, text: string): string {
  return !state.isDm && state.askedBy ? `${state.askedBy}: ${text}` : text
}
