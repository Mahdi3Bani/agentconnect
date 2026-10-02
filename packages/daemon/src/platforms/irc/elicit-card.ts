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
const IRC_DECISION_CAP = 300

const IRC_ELICIT_MARK: Record<ElicitCardMark, string> = {
  answered: '✅',
  dismissed: '🚫',
  waiting: '⏳',
  blocked: '🔒'
}

// Only the kinds one reply answers whole; typed and multi-field asks keep the decline notice.
export const IRC_ELICIT_SURFACE: ElicitSurface = {
  kinds: new Set<ElicitKind>(['enum', 'boolean']),
  optionLimits: {
    enum: { maxOptions: IRC_CARD_MAX_OPTIONS }
  }
}

interface IrcCardDraft {
  text: string
  labels: string[]
}

function cardLabel(label: string): string {
  return clampTo(label.replace(/[\r\n]+/g, ' '), IRC_CARD_MAX_LABEL)
}

/** The card's words: the question, then the numbered options on the same line, then how to answer. */
export function ircElicitText(message: string, target: ElicitTarget): string {
  const options = target.options.map((o, i) => `[${i + 1}] ${cardLabel(o.label)}`).join(' ')
  return `${message.trim()} ${options} (reply to this with a number)`
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

export const ircElicitCards: ElicitCardFacet = {
  platform: 'irc',
  reduction: IRC_ELICIT_SURFACE,

  build(host: ElicitCardHost, turn: ElicitCardTurn, ask: ElicitCardAsk): ElicitCardDraft | null {
    const target = ask.form?.length === 1 ? ask.form[0]! : undefined
    if (ask.url || !target?.options.length) return null
    const state = host.turnState(turn) as IrcTurnState
    // `nick: text` is how a channel line says who it is for, as the turn's answer does.
    const address = !state.isDm && state.askedBy ? `${state.askedBy}: ` : ''
    const draft: IrcCardDraft = {
      text: address + ircElicitText(ask.message, target),
      labels: target.options.map((o) => cardLabel(o.label))
    }
    return draft
  },

  async send(host: ElicitCardHost, turn: ElicitCardTurn, _ask: ElicitCardAsk, draft: ElicitCardDraft) {
    const state = host.turnState(turn) as IrcTurnState
    const { conn, target, isDm } = state
    if (!conn) return undefined
    const { text, labels } = draft as IrcCardDraft
    return await host.postCardSerialized(turn, async () => {
      const [first] = await conn.sendText(target, text, {
        maxLines: isDm ? IRC_MAX_ANSWER_LINES.dm : IRC_MAX_ANSWER_LINES.channel,
        tags: { [IRC_CARD_TAG]: JSON.stringify({ v: 1, options: labels }) }
      })
      // An answer is a reply to the card's msgid. Without one from the server nothing could ever answer it, so the
      // card counts as refused rather than left open forever.
      return first && !first.id.startsWith('local-') ? first.id : undefined
    })
  },

  // Only a reply to THIS card answers it; a reply that names no option gets the instruction again.
  claimReply(handle: ElicitCardHandle, card: ElicitCardTapTarget, reply: ElicitCardReply): ElicitCardTap | null {
    if (handle.ts === undefined || reply.replyTo !== handle.ts) return null
    const target = card.form.length === 1 ? card.form[0]! : undefined
    if (!target) return null
    const index = ircElicitChoice(target, reply.text)
    if (index === null) {
      follow(handle, `Reply with a number from 1 to ${target.options.length}.`)
      return { kind: 'pending' }
    }
    return { kind: 'submit', fields: { [elicitFormBlockId(0)]: elicitOptionToken(index) } }
  },

  // IRC cannot edit the card, so the verdict is a reply to it.
  settle(handle: ElicitCardHandle, card: ElicitCardSettlement): void {
    follow(handle, `${IRC_ELICIT_MARK[card.mark]} ${clampTo(card.text, IRC_DECISION_CAP)}`)
  }
}
