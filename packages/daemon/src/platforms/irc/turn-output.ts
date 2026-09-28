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
// Progress is one short line, twice per turn at most, at least 15s apart.
const PROGRESS_MAX_BYTES = 300
const PROGRESS_MAX_COUNT = 2
const PROGRESS_MIN_GAP_MS = 15_000

export type IrcAction = {
  kind: 'post' | 'irc-progress'
  text: string
  attributed: boolean
  recordOnly?: boolean
}

/** What a turn needs from the connection; `IrcConnection` is one. */
export interface IrcReplyPort {
  sendText(target: string, text: string, options?: { maxLines?: number }): Promise<IrcSendReceipt[]>
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
  lastProgress?: string
}

export function initialIrcTurnState(ctx: TurnOutputContext<NormalizedMessage>): IrcTurnState {
  return {
    conn: ctx.egress as IrcReplyPort | undefined,
    target: ctx.message.channel,
    isDm: ctx.isDm,
    ...(ctx.message.sender.name ? { askedBy: ctx.message.sender.name } : {})
  }
}

export async function applyIrcAction(
  state: IrcTurnState,
  action: { kind: string; text?: string; recordOnly?: boolean },
  record: (text: string) => Promise<void>
): Promise<void> {
  if (!action.text || (action.kind !== 'post' && action.kind !== 'irc-progress')) return
  // A final answer identical to the progress line already sent would be the same line twice.
  if (action.kind === 'post' && !action.recordOnly && action.text === state.lastProgress) return
  await record(action.text)
  if (action.recordOnly || !state.conn) return
  // `nick: text` is how a channel reply says who it answers; a DM needs no address.
  const text = !state.isDm && state.askedBy ? `${state.askedBy}: ${action.text}` : action.text
  if (action.kind === 'irc-progress') {
    await state.conn.sendText(state.target, text, { maxLines: 1 })
    state.lastProgress = action.text
    return
  }
  await state.conn.sendText(state.target, text, {
    maxLines: state.isDm ? IRC_MAX_ANSWER_LINES.dm : IRC_MAX_ANSWER_LINES.channel
  })
}
