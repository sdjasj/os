import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import test from 'node:test'
import { createMarkdownParser } from '../src/math.ts'

function parse(source: string, enableMath = true): string {
  return createMarkdownParser(enableMath).parse(source) as string
}

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1
}

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) return markdownFiles(filename)
    return entry.isFile() && entry.name.endsWith('.md') ? [filename] : []
  })
}

test('renders both inline and display delimiter styles', () => {
  const html = parse([
    'Inline \\(x + y\\) and $g_t$.',
    '',
    '\\[',
    '\\sum_{i=1}^{n} i',
    '\\]',
    '',
    '$$\\mathcal L=-\\log p_\\theta(y|x)$$',
  ].join('\n'))

  assert.equal(occurrences(html, 'class="math-block"'), 2)
  assert.equal(occurrences(html, 'class="katex"'), 4)
  assert.equal(occurrences(html, 'encoding="application/x-tex"'), 4)
})

test('leaves every Markdown code form untouched', () => {
  const html = parse([
    '`$inline$` and `\\(inline-code\\)`',
    '',
    '```sh',
    'echo "$fenced" "$$" \\(fenced\\)',
    '```',
    '',
    '````md',
    '```',
    '$$nested-fence$$',
    '```',
    '````',
    '',
    '~~~sh',
    'echo $tilde$ \\(tilde\\)',
    '~~~',
    '',
    '    echo $indented$ \\(indented\\)',
    '',
    'Outside $x$.',
  ].join('\n'))

  assert.equal(occurrences(html, 'class="katex"'), 1)
  assert.match(html, /<code>\$inline\$<\/code>/)
  assert.match(html, /\$\$nested-fence\$\$/)
  assert.match(html, /\$indented\$/)
})

test('does not confuse labels, shell variables, escaped dollars, or currency with math', () => {
  const html = parse([
    '| label | value |',
    '| --- | --- |',
    '| API | \\[OS API\\] |',
    '',
    'Cost $5 and $10; shell $HOME; escaped \\$x\\$; formula $N$，done.',
  ].join('\n'))

  assert.equal(occurrences(html, 'class="katex"'), 1)
  assert.match(html, /\[OS API\]/)
  assert.match(html, /\$5 and \$10/)
  assert.match(html, /shell \$HOME/)
  assert.match(html, /escaped \$x\$/)
})

test('keeps lab pre-rendered KaTeX on the plain parser path', () => {
  const html = parse(
    '<span class="katex"><span class="katex-mathml">\\(G\\)</span><span class="katex-html">G</span></span>',
    false,
  )
  assert.equal(occurrences(html, 'class="katex"'), 1)
  assert.equal(occurrences(html, 'class="math-block"'), 0)
})

test('renders unsupported or untrusted TeX safely without throwing', () => {
  const invalid = parse('$$\\definitelyUnknownCommand{x}$$')
  const untrusted = parse('$$\\href{javascript:alert(1)}{click}$$')

  // With throwOnError disabled, KaTeX deliberately paints an unsupported
  // command red instead of adding the legacy `katex-error` class.
  assert.match(invalid, /class="katex"/)
  assert.match(invalid, /definitelyUnknownCommand/)
  assert.doesNotMatch(invalid, /\$\$/)
  assert.doesNotMatch(untrusted, /href=["']javascript:/i)
})

test('renders deterministically', () => {
  const source = '$$A_i=\\frac{R_i-\\mu}{\\sigma+\\epsilon}$$'
  assert.equal(parse(source), parse(source))
})

test('renders the complete tutorial corpus with the audited formula counts', () => {
  const siteRoot = fileURLToPath(new URL('../..', import.meta.url))
  const files = [
    ...markdownFiles(path.join(siteRoot, 'tutorial')),
    ...markdownFiles(path.join(siteRoot, 'projects')),
  ]
  const parser = createMarkdownParser(true)
  let displayCount = 0
  let formulaCount = 0
  let errorCount = 0

  for (const filename of files) {
    const html = parser.parse(readFileSync(filename, 'utf8')) as string
    displayCount += occurrences(html, 'class="math-block"')
    formulaCount += occurrences(html, 'class="katex"')
    errorCount += occurrences(html, 'katex-error')
  }

  assert.equal(displayCount, 79)
  assert.equal(formulaCount, 82)
  assert.equal(errorCount, 0)
})
