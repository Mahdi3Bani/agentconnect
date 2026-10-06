// IRC's elicitation-card facet: a numbered question answered by replying to it. The options also ride a
// `+mosircley.de/card` client tag, so a client that knows the tag (MosIrcley) draws them as buttons; a tap there
// is the same reply, with the option's label as its text. The tag format is MosIrcley's docs/agent-cards.md.
import type {
  ElicitCardAsk,
  ElicitCardDraft,
  ElicitCardFacet,
  ElicitCardHandle,
  ElicitCardHost,
  ElicitCardMark,
  ElicitCardReply,
  ElicitCardSettlement,
  ElicitCardTap,
  ElicitCardTapTarget,
  ElicitCardTurn
} from '../elicit-card.js'
import { elicitFormBlockId } from '@agentconnect.md/protocol'
import {
  clampTo,
  elicitOptionToken,
  type ElicitKind,
  type ElicitSurface,
  type ElicitTarget
} from '../../slack/render.js'
import { IRC_MAX_ANSWER_LINES, type IrcReplyPort, type IrcTurnState } from './turn-output.js'

export const IRC_CARD_TAG = '+mosircley.de/card'
// The card tag's own limits: a client drops a card that breaks them, leaving only the text.
const IRC_CARD_MAX_OPTIONS = 12
const IRC_CARD_MAX_LABEL = 80
const IRC_CARD_MAX_TEXT = 1000
const IRC_DECISION_CAP = 300

const IRC_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: '✅',
  dismissed: '🚫',
  waiting: '⏳',
  blocked: '🔒'
}

// The kinds one reply answers whole. Which COMBINATIONS a card takes is ircCardShape's call; any other form, a
// multi-select or several questions, is refused by build and keeps core's decline notice.
export const IRC_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean', 'text', 'number']),
  optionLimits: {
    enum: { maxOptions: IRC_CARD_MAX_OPTIONS }
  }
}

interface IrcCardDraft {
  text: string
  labels: string[]
  /** The question without the numbered options, for a client that draws them as buttons instead */
  question: string
}

function cardLabel(label: string): string {
  return clampTo(label.replace(/[\r\n]+/g, ' '), IRC_CARD_MAX_LABEL)
}

/**
 * What one reply can answer: a pick from options, a typed answer, or both — a select with its own free-text box,
 * which is the shape of Claude Code's AskUserQuestion ("pick one, or type your own"). Positions are the form's own,
 * so an answer is keyed as core keys a Confirm. Null for any other form.
 */
export interface IrcCardShape {
  select?: { target: ElicitTarget; index: number }
  typed?: { target: ElicitTarget; index: number }
}

export function ircCardShape(form: readonly ElicitTarget[]): IrcCardShape | null {
  const isSelect = (t: ElicitTarget) => (t.kind === 'enum' || t.kind === 'boolean') && t.options.length > 0
  const isTyped = (t: ElicitTarget) => t.kind === 'text' || t.kind === 'number'
  if (form.length === 1) {
    const [only] = form
    if (isSelect(only!)) return { select: { target: only!, index: 0 } }
    if (isTyped(only!)) return { typed: { target: only!, index: 0 } }
    return null
  }
  if (form.length !== 2) return null
  const s = form.findIndex(isSelect)
  const t = form.findIndex((f) => f.kind === 'text' && f.customAnswerFor !== undefined)
  if (s < 0 || t < 0 || form[t]!.customAnswerFor !== form[s]!.propName) return null
  return { select: { target: form[s]!, index: s }, typed: { target: form[t]!, index: t } }
}

/** The card's words: the question, then any numbered options on the same line, then how to answer. */
export function ircElicitText(message: string, shape: IrcCardShape): string {
  const options = shape.select?.target.options.map((o, i) => `[${i + 1}] ${cardLabel(o.label)}`).join(' ')
  const how = shape.select
    ? shape.typed
      ? 'reply to this with a number, or your own answer'
      : 'reply to this with a number'
    : 'reply to this with your answer'
  return [message.trim(), options, `(${how})`].filter(Boolean).join(' ')
}

/** The card tag's own words: the question alone, since the options are buttons there; a typed answer still needs saying. */
export function ircCardQuestion(message: string, shape: IrcCardShape): string {
  return [message.trim(), shape.typed ? '(or reply to this with your own answer)' : ''].filter(Boolean).join(' ')
}

/** The option a reply names: its 1-based number, or its label or value — the button label MosIrcley sends too. */
export function ircElicitChoice(target: ElicitTarget, text: string): number | null {
  const said = text.normalize('NFKC').trim().toLowerCase()
  if (/^\d{1,2}$/.test(said)) {
    const n = Number(said)
    return n >= 1 && n <= target.options.length ? n - 1 : null
  }
  const named = (o: { value: string; label: string }) =>
    [o.label, o.value, cardLabel(o.label)].some((s) => s.normalize('NFKC').trim().toLowerCase() === said)
  const index = target.options.findIndex(named)
  return index >= 0 ? index : null
}

function follow(handle: ElicitCardHandle, text: string): void {
  if (handle.ts === undefined) return
  const conn = handle.conn as Partial<IrcReplyPort> | undefined
  void conn?.sendText?.(handle.channel, text, { maxLines: 1, tags: { '+draft/reply': handle.ts } }).catch(() => {})
}

// Answered: the agent goes back to work. A refused answer (core re-validates) leaves it showing as working until
// the turn settles, which is the honest side to err on.
function resumeTyping(handle: ElicitCardHandle): void {
  ;(handle.conn as Partial<IrcReplyPort> | undefined)?.typingPause?.(handle.channel, false)
}

export const ircElicitCards: ElicitCardFacet = {
  platform: 'irc',
  reduction: IRC_ELICIT_SURFACE,

  build(host: ElicitCardHost, turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    const shape = ask.form && !ask.url ? ircCardShape(ask.form) : null
    if (!shape) return null
    const state = host.turnState(turn) as IrcTurnState
    // `nick: text` is how a channel line says who it is for, as the turn's answer does.
    const address = !state.isDm && state.askedBy ? `${state.askedBy}: ` : ''
    const draft: IrcCardDraft = {
      text: address + ircElicitText(ask.message, shape),
      labels: shape.select?.target.options.map((o) => cardLabel(o.label)) ?? [],
      question: clampTo(address + ircCardQuestion(ask.message, shape), IRC_CARD_MAX_TEXT)
    }
    return draft
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, _ask: ElicitCardAsk, draft: ElicitCardDraft) {
    const state = host.turnState(turn) as IrcTurnState
    const { conn, target, isDm } = state
    if (!conn) return undefined
    const { text, labels, question } = draft as IrcCardDraft
    return await host.postCardSerialized(turn, async () => {
      const [first] = await conn.sendText(target, text, {
        maxLines: isDm ? IRC_MAX_ANSWER_LINES.dm : IRC_MAX_ANSWER_LINES.channel,
        // A typed question has no buttons, so no card tag: a client shows it as the message it is.
        ...(labels.length
          ? { tags: { [IRC_CARD_TAG]: JSON.stringify({ v: 1, options: labels, text: question }) } }
          : {})
      })
      // An answer is a reply to the card's msgid. Without one from the server nothing could ever answer it, so the
      // card counts as refused rather than left open forever.
      if (!first || first.id.startsWith('local-')) return undefined
      // The agent is waiting on a person now, not working.
      conn.typingPause?.(target, true)
      return first.id
    })
  },

  // Only a reply to THIS card answers it. A pick wins over the typed box, so "2" is an option, not the text "2";
  // a reply that is neither gets the instruction again. A typed answer is validated by core, as a Confirm's is.
  claimReply(handle: ElicitCardHandle, card: ElicitCardTapTarget, reply: ElicitCardReply): ElicitCardTap | null {
    if (handle.ts === undefined || reply.replyTo !== handle.ts) return null
    const shape = ircCardShape(card.form)
    if (!shape) return null
    const { select, typed } = shape
    const picked = select ? ircElicitChoice(select.target, reply.text) : null
    if (select && picked !== null) {
      resumeTyping(handle)
      return { kind: 'submit', fields: { [elicitFormBlockId(select.index)]: elicitOptionToken(picked) } }
    }
    const said = reply.text.trim()
    if (typed && said) {
      resumeTyping(handle)
      return { kind: 'submit', fields: { [elicitFormBlockId(typed.index)]: said } }
    }
    follow(
      handle,
      select ? `Reply with a number from 1 to ${select.target.options.length}.` : 'Reply with your answer.'
    )
    return { kind: 'pending' }
  },

  // Anyone can take a nick, so only a NickServ account is an identity: the asker approves, and only when logged in.
  chatApprover(requesterId: string | undefined): string | null {
    return requesterId?.startsWith('account:') ? requesterId : null
  },

  // IRC cannot edit the card, so the verdict is a reply to it.
  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void {
    follow(handle, `${IRC_ELICIT_MARK[card.mark]} ${clampTo(card.text, IRC_DECISION_CAP)}`)
  }
}
