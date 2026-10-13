// IRC's command replies: `!` hints, room for a model list, and a status line that never links to localhost.
import { describe, it, expect } from 'vitest'
import { ircCommandChrome, ircCommandHints, ircStatusText } from '../src/platforms/irc/command-chrome.js'

const MSG = { channel: '#dev', isDm: false, sender: { id: 'account:mahdi', name: 'mahdi' } } as never
const CTX = { channel: '#dev', replyThread: 'channel', sessionKey: 'k1' }

function port(longForm: boolean) {
  const sent: Array<{ target: string; text: string; maxLines?: number }> = []
  return {
    sent,
    conn: {
      longForm: () => longForm,
      sendText: async (target: string, text: string, options?: { maxLines?: number }) => {
        sent.push({ target, text, maxLines: options?.maxLines })
        return []
      }
    }
  }
}

describe('IRC command replies', () => {
  it('spell commands with ! since an IRC client takes /models as its own', () => {
    expect(ircCommandHints('Model — reply `/models <name or number>`:')).toBe(
      'Model — reply `!models <name or number>`:'
    )
    expect(ircCommandHints('send me a message first, then try /permission again.')).toBe(
      'send me a message first, then try !permission again.'
    )
    expect(ircCommandHints('see /w/models/a.txt and http://x/status')).toBe('see /w/models/a.txt and http://x/status')
  })

  it('send a whole model list, addressed to the asker', () => {
    const { sent, conn } = port(true)
    const list = [
      'Model — reply `/models <name or number>`:',
      ...Array.from({ length: 14 }, (_, i) => `${i + 1}. m${i}`)
    ]
    ircCommandChrome.reply(conn, MSG, CTX, list.join('\n'))
    expect(sent[0]!.text.startsWith('mahdi: Model — reply `!models')).toBe(true)
    expect(sent[0]!.maxLines).toBeGreaterThanOrEqual(15)
  })

  it('keep a line-by-line reply shorter', () => {
    const { sent, conn } = port(false)
    ircCommandChrome.reply(conn, MSG, CTX, 'hi')
    expect(sent[0]!.maxLines).toBe(12)
  })
})

describe('the IRC status line', () => {
  const info = {
    model: 'hack-lite/glm-5.3-flash',
    permissionMode: 'build',
    contextUsed: 12_400,
    contextSize: 128_000,
    totalTokens: 45_200
  }

  it('says the model, mode, context and tokens', () => {
    expect(ircStatusText(info)).toBe('📊 hack-lite/glm-5.3-flash · mode build · context 12k/128k (10%) · 45k tokens')
  })

  it('leaves out a console link only the daemon machine can open', () => {
    expect(ircStatusText(info, 'http://localhost:3000/-/sessions/s1')).not.toContain('localhost')
    expect(ircStatusText(info, 'http://127.0.0.1:3000/-/sessions/s1')).not.toContain('127.0.0.1')
    expect(ircStatusText(info, 'https://console.example.com/-/sessions/s1')).toContain(
      'https://console.example.com/-/sessions/s1'
    )
  })

  it('still answers before the session has details', () => {
    expect(ircStatusText({})).toBe('📊 no details yet')
  })
})
