// A question an agent asks in its answer's own words. OpenCode has no structured question in ACP mode: it ends an
// answer with "Which one?" and a numbered list. Read back here, the list rides the answer as the card tag, so
// MosIrcley draws it as buttons, and the next reply to it reaches the agent without addressing it by nick.
import { stripIrcFormatting } from '@agentconnect.md/message'

/** The client tag a card rides; the format is MosIrcley's docs/agent-cards.md. */
export const IRC_CARD_TAG = '+mosircley.de/card'
const MAX_OPTIONS = 12
const MAX_LABEL = 80
// `1. Postgres`, `2) SQLite — small`, `[3] Redis`
const OPTION = /^\s*(?:\[(\d{1,2})\]|(\d{1,2})[.)])\s+(.+?)\s*$/

/**
 * The options an answer ends on, as button labels, or null. They count only as the answer's last list, numbered from
 * 1 without gaps, at least two, and with a question mark on the line before them or after them: a numbered list of
 * steps is not a question.
 */
export function ircSoftQuestion(text: string): string[] | null {
  const lines = stripIrcFormatting(text)
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  // The list may be followed by one closing line ("Or tell me something else?").
  let end = lines.length - 1
  let after = ''
  if (end >= 0 && !OPTION.test(lines[end]!)) {
    after = lines[end]!
    end--
  }
  let start = end
  while (start >= 0 && OPTION.test(lines[start]!)) start--
  const options = lines.slice(start + 1, end + 1).map((l) => OPTION.exec(l)!)
  if (options.length < 2 || options.length > MAX_OPTIONS) return null
  if (options.some((m, i) => Number(m[1] ?? m[2]) !== i + 1)) return null
  let before = start
  while (before >= 0 && !lines[before]!.trim()) before--
  if (!(before >= 0 && lines[before]!.includes('?')) && !after.includes('?')) return null
  return options.map((m) => label(m[3]!))
}

// The option's name, without markdown emphasis or the description after a dash or colon, kept to a button's width.
function label(option: string): string {
  const plain = option.replace(/\*\*|__|`/g, '').trim()
  const name = plain.split(/\s+[—–-]\s+|:\s+/)[0]!.trim() || plain
  return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name
}

/** The card tag for a soft question: options only, so a client shows the whole answer with the buttons under it. */
export function ircSoftQuestionTag(options: string[]): Record<string, string> {
  return { [IRC_CARD_TAG]: JSON.stringify({ v: 1, options }) }
}
