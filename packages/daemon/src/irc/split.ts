/** RFC 1459 §2.3: a message is at most 512 bytes including the trailing CRLF; IRCv3 tags have their own budget. */
export const IRC_LINE_MAX_BYTES = 512

// RFC 1123 hostname ceiling; used when the server has not yet told us our own host.
const UNKNOWN_HOST_BYTES = 63
// Common USERLEN plus the '~' an ident-less connection gets.
const UNKNOWN_USER_BYTES = 11

const encoder = new TextEncoder()
const byteLength = (s: string) => encoder.encode(s).length

export interface IrcSelfMask {
  nick: string
  username?: string
  host?: string
}

/** Payload bytes left for PRIVMSG text once the server has prepended our full `:nick!user@host` to relay it. */
export function ircPayloadBudget(command: string, target: string, self: IrcSelfMask): number {
  const prefix =
    1 +
    byteLength(self.nick) +
    1 +
    (self.username ? byteLength(self.username) : UNKNOWN_USER_BYTES) +
    1 +
    (self.host ? byteLength(self.host) : UNKNOWN_HOST_BYTES) +
    1
  return IRC_LINE_MAX_BYTES - 2 - prefix - byteLength(`${command} ${target} :`)
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Split text into IRC lines of at most `maxBytes`, breaking at whitespace where possible and never inside a grapheme. */
export function splitIrcText(text: string, maxBytes: number): string[] {
  if (maxBytes < 4) throw new Error(`IRC payload budget of ${maxBytes} bytes cannot hold one code point`)
  const out: string[] = []
  // CR, LF and NUL end or corrupt an IRC line, so each source line becomes its own message.
  for (const source of text.replace(/\x00/g, '').split(/\r\n|\r|\n/)) {
    if (!source.trim()) continue
    out.push(...splitLine(source, maxBytes))
  }
  return out
}

function splitLine(line: string, maxBytes: number): string[] {
  const out: string[] = []
  let current: { g: string; bytes: number }[] = []
  let size = 0
  // Index in `current` just past the last whitespace grapheme: the preferred break point.
  let lastSpace = -1

  const flush = (upTo: number) => {
    const head = current.slice(0, upTo)
    const text = head
      .map((x) => x.g)
      .join('')
      .trimEnd()
    if (text) out.push(text)
    current = current.slice(upTo)
    while (current.length && /^\s+$/.test(current[0]!.g)) current.shift()
    size = current.reduce((n, x) => n + x.bytes, 0)
    lastSpace = -1
    current.forEach((x, i) => {
      if (/^\s+$/.test(x.g)) lastSpace = i + 1
    })
  }

  for (const { segment } of segmenter.segment(line)) {
    // A grapheme wider than a whole line (a long combining run) falls back to code points; nothing better exists.
    const pieces = byteLength(segment) > maxBytes ? [...segment] : [segment]
    for (const g of pieces) {
      const bytes = byteLength(g)
      if (size + bytes > maxBytes) flush(lastSpace > 0 ? lastSpace : current.length)
      current.push({ g, bytes })
      size += bytes
      if (/^\s+$/.test(g)) lastSpace = current.length
    }
  }
  flush(current.length)
  return out
}
