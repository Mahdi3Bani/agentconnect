import type { Nodes, RootContent } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'

const BOLD = '\x02'
const ITALIC = '\x1d'
const MONO = '\x11'

/**
 * Agent markdown as IRC text: bold and italics become mIRC codes, links show their URL, code keeps its lines. Blocks
 * are paragraphs, a blank line apart: a multiline message keeps it, and line by line a blank line is not sent.
 */
export function renderIrcText(markdown: string): string {
  return fromMarkdown(markdown)
    .children.map((node) => block(node, '').join('\n'))
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function blocks(nodes: RootContent[], indent: string): string[] {
  return nodes.flatMap((node) => block(node, indent))
}

function block(node: RootContent, indent: string): string[] {
  switch (node.type) {
    case 'paragraph':
      return prefixLines(inline(node), indent)
    case 'heading':
      return prefixLines(`${BOLD}${inline(node)}${BOLD}`, indent)
    // Fences are dropped but the lines are kept verbatim, each in monospace (\x11): IRC has no code block, a client
    // that draws monospace shows one, and one that does not still reads the indentation.
    case 'code':
      return node.value.split('\n').map((line) => indent + (line ? `${MONO}${line}${MONO}` : ''))
    case 'blockquote':
      return blocks(node.children, indent).map((line) => `> ${line}`)
    case 'list':
      return node.children.flatMap((item, i) => {
        const marker = node.ordered ? `${(node.start ?? 1) + i}. ` : '- '
        const [first = '', ...rest] = blocks(item.children, indent + ' '.repeat(marker.length))
        return [indent + marker + first.slice(indent.length + marker.length), ...rest]
      })
    case 'thematicBreak':
      return [indent + '---']
    case 'html':
      return prefixLines(node.value, indent)
    case 'definition':
      return []
    default:
      return 'children' in node ? prefixLines(inline(node), indent) : []
  }
}

function prefixLines(text: string, indent: string): string[] {
  return text.split('\n').map((line) => indent + line)
}

function inline(node: Nodes): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.type === 'inlineCode' ? `\`${node.value}\`` : node.value
    case 'strong':
      return `${BOLD}${children(node)}${BOLD}`
    case 'emphasis':
      return `${ITALIC}${children(node)}${ITALIC}`
    case 'break':
      return '\n'
    case 'link': {
      const text = children(node)
      return !text || text === node.url ? node.url : `${text} <${node.url}>`
    }
    case 'image':
      return node.alt ? `${node.alt} <${node.url}>` : node.url
    case 'html':
      return node.value
    default:
      return 'children' in node ? children(node) : ''
  }
}

function children(node: Nodes): string {
  return 'children' in node ? (node.children as Nodes[]).map(inline).join('') : ''
}

// Toggle codes the renderer emits; clients reset all of them at the end of a line, and \x0f resets them mid-line.
const TOGGLES = ['\x02', '\x1d', '\x1f', '\x1e', '\x11']
/** Bytes {@link carryFormatting} may add to one line: a reopen and a close per toggle. */
export const IRC_FORMATTING_CARRY_BYTES = TOGGLES.length * 2

/** Close each line's open toggles at its end and reopen them on the next, since IRC clients reset at every line. */
export function carryFormatting(lines: string[]): string[] {
  let open: string[] = []
  return lines.map((line) => {
    const reopened = open.join('') + line
    const state = new Set<string>()
    for (const ch of reopened) {
      if (ch === '\x0f') state.clear()
      else if (TOGGLES.includes(ch)) {
        if (state.has(ch)) state.delete(ch)
        else state.add(ch)
      }
    }
    open = [...state]
    return reopened + [...open].reverse().join('')
  })
}
