import katex from 'katex'
import { Marked, type MarkedExtension, type Tokens } from 'marked'

interface MathToken extends Tokens.Generic {
  type: 'blockMath' | 'inlineMath'
  raw: string
  text: string
  display: boolean
}

const katexOptions = {
  throwOnError: false,
  strict: 'ignore' as const,
  trust: false,
  maxExpand: 1_000,
  maxSize: 50,
  output: 'htmlAndMathml' as const,
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character] ?? character)
}

function renderMath(token: MathToken): string {
  try {
    const html = katex.renderToString(token.text.trim(), {
      ...katexOptions,
      displayMode: token.display,
    })
    return token.display ? `<div class="math-block">${html}</div>\n` : html
  } catch {
    return escapeHtml(token.raw)
  }
}

function findClosingDelimiter(
  source: string,
  delimiter: string,
  start: number,
  singleLine = false,
): number {
  let braceLevel = 0
  for (let index = start; index < source.length; index += 1) {
    if (singleLine && source[index] === '\n') return -1
    if (braceLevel <= 0 && source.startsWith(delimiter, index)) {
      if (delimiter !== '$' || (source[index - 1] !== '$' && source[index + 1] !== '$')) return index
    }
    if (source[index] === '\\') {
      index += 1
    } else if (source[index] === '{') {
      braceLevel += 1
    } else if (source[index] === '}') {
      braceLevel -= 1
    }
  }
  return -1
}

function displayMathStart(source: string): number | undefined {
  const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source)
  if (!match) return undefined
  return match.index + (match[0].startsWith('\n') ? 1 : 0)
}

function tokenizeDisplayMath(source: string): MathToken | undefined {
  const opening = /^( {0,3})(\$\$|\\\[)/.exec(source)
  if (!opening) return undefined

  const left = opening[2]
  const right = left === '$$' ? '$$' : '\\]'
  let contentStart = opening[0].length

  // Bracket-style display math must use delimiter-only lines. This keeps
  // escaped prose such as `\[OS API\]` in Markdown tables as literal text.
  if (left === '\\[') {
    const openingLineEnd = source.indexOf('\n', contentStart)
    if (openingLineEnd < 0 || source.slice(contentStart, openingLineEnd).trim()) return undefined
    contentStart = openingLineEnd + 1
  }

  const closingStart = findClosingDelimiter(source, right, contentStart)
  if (closingStart < 0) return undefined

  if (left === '\\[') {
    const closingLineStart = source.lastIndexOf('\n', closingStart - 1) + 1
    if (source.slice(closingLineStart, closingStart).trim()) return undefined
  }

  const closingEnd = closingStart + right.length
  const lineEnd = source.indexOf('\n', closingEnd)
  const suffix = source.slice(closingEnd, lineEnd < 0 ? source.length : lineEnd)
  if (suffix.trim()) return undefined

  const rawEnd = lineEnd < 0 ? closingEnd : lineEnd + 1
  const text = source.slice(contentStart, closingStart).trim()
  if (!text) return undefined

  return {
    type: 'blockMath',
    raw: source.slice(0, rawEnd),
    text,
    display: true,
  }
}

function inlineMathStart(source: string): number | undefined {
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\\') {
      if (source[index + 1] === '(') return index
      index += 1
      continue
    }
    if (
      source[index] === '$'
      && source[index - 1] !== '$'
      && source[index + 1] !== '$'
      && source[index + 1] !== undefined
      && !/\s/.test(source[index + 1])
    ) return index
  }
  return undefined
}

function tokenizeInlineMath(source: string): MathToken | undefined {
  if (source.startsWith('\\(')) {
    const closingStart = findClosingDelimiter(source, '\\)', 2, true)
    if (closingStart < 0) return undefined
    const text = source.slice(2, closingStart)
    if (!text.trim()) return undefined
    return {
      type: 'inlineMath',
      raw: source.slice(0, closingStart + 2),
      text,
      display: false,
    }
  }

  if (source[0] !== '$' || source[1] === '$' || source[1] === undefined || /\s/.test(source[1])) {
    return undefined
  }
  const closingStart = findClosingDelimiter(source, '$', 1, true)
  if (closingStart < 0 || /\s/.test(source[closingStart - 1])) return undefined

  // Avoid treating common currency ranges such as `$5–$10` as mathematics.
  if (/\d/.test(source[1]) && /\d/.test(source[closingStart + 1] ?? '')) return undefined

  const text = source.slice(1, closingStart)
  if (!text.trim()) return undefined
  return {
    type: 'inlineMath',
    raw: source.slice(0, closingStart + 1),
    text,
    display: false,
  }
}

const blockMathExtension = {
  name: 'blockMath',
  level: 'block' as const,
  start: displayMathStart,
  tokenizer: tokenizeDisplayMath,
  renderer: (token: Tokens.Generic) => renderMath(token as MathToken),
}

const inlineMathExtension = {
  name: 'inlineMath',
  level: 'inline' as const,
  start: inlineMathStart,
  tokenizer: tokenizeInlineMath,
  renderer: (token: Tokens.Generic) => renderMath(token as MathToken),
}

export const markdownMathExtension: MarkedExtension = {
  extensions: [blockMathExtension, inlineMathExtension],
}

export function createMarkdownParser(enableMath: boolean): Marked {
  const options: MarkedExtension = { gfm: true, breaks: false }
  return enableMath
    ? new Marked(options, markdownMathExtension)
    : new Marked(options)
}
