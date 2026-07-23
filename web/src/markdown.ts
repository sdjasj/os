import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import glsl from 'highlight.js/lib/languages/glsl'
import go from 'highlight.js/lib/languages/go'
import http from 'highlight.js/lib/languages/http'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import makefile from 'highlight.js/lib/languages/makefile'
import plaintext from 'highlight.js/lib/languages/plaintext'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import x86asm from 'highlight.js/lib/languages/x86asm'
import katex from 'katex'
import { marked } from 'marked'
import { examples, resolveRepoPath, sourceAssets } from './content'
import {
  findProjectDocumentByRepoPath,
  projectDocumentHref,
  projectTrackHrefForReadme,
  sourceUrlForRepoPath,
  type ProjectDocument,
} from './projects'
import type { ContentDocument, HeadingItem } from './types'

hljs.registerLanguage('bash', bash)
hljs.registerLanguage('sh', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('c', c)
hljs.registerLanguage('h', c)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('diff', diff)
hljs.registerLanguage('dockerfile', dockerfile)
hljs.registerLanguage('glsl', glsl)
hljs.registerLanguage('go', go)
hljs.registerLanguage('http', http)
hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('js', javascript)
hljs.registerLanguage('json', json)
hljs.registerLanguage('makefile', makefile)
hljs.registerLanguage('make', makefile)
hljs.registerLanguage('text', plaintext)
hljs.registerLanguage('plaintext', plaintext)
hljs.registerLanguage('python', python)
hljs.registerLanguage('py', python)
hljs.registerLanguage('postscript', plaintext)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('ts', typescript)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('asm', x86asm)
hljs.registerLanguage('x86asm', x86asm)
hljs.registerLanguage('cuda', cpp)
hljs.registerLanguage('gdb', plaintext)

marked.setOptions({ gfm: true, breaks: false })

function sourceLectureUrl(repoPath: string): string | undefined {
  const match = /sources\/notes\/lect0?(\d+)\.md$/.exec(repoPath)
  if (!match) return undefined
  return `https://jyywiki.cn/OS/2026/lect${Number(match[1])}.md`
}

function asProjectDocument(document: ContentDocument): ProjectDocument | undefined {
  const candidate = document as Partial<ProjectDocument>
  return candidate.projectSlug && candidate.routeId ? candidate as ProjectDocument : undefined
}

function routeForProjectMarkdownLink(href: string, document: ProjectDocument): string {
  if (/^(https?:|mailto:|tel:)/i.test(href)) return href

  const [pathPart, anchor] = href.split('#', 2)
  if (!pathPart) return projectDocumentHref(document, anchor || undefined)

  const repoPath = resolveRepoPath(document.repoPath, pathPart)
  const targetDocument = findProjectDocumentByRepoPath(document.projectSlug, repoPath)
  if (targetDocument) return projectDocumentHref(targetDocument, anchor || undefined)

  if (/README\.md$/i.test(repoPath)) {
    const trackHref = projectTrackHrefForReadme(document.projectSlug, repoPath)
    if (trackHref) return trackHref
  }

  const sourceUrl = sourceUrlForRepoPath(document.projectSlug, repoPath)
  if (sourceUrl) return anchor ? `${sourceUrl}#${anchor}` : sourceUrl

  return href
}

function routeForMarkdownLink(href: string, document: ContentDocument): string {
  const projectDocument = asProjectDocument(document)
  if (projectDocument) return routeForProjectMarkdownLink(href, projectDocument)
  if (/^(https?:|mailto:|tel:)/i.test(href)) return href
  if (href === '/') return 'https://jyywiki.cn/'
  if (href.startsWith('/OS/')) return `https://jyywiki.cn${href}`

  const [pathPart, anchor] = href.split('#', 2)
  if (!pathPart) {
    const base = document.kind === 'lecture'
      ? `#/lecture/${String(document.number).padStart(2, '0')}`
      : document.kind === 'topic'
        ? `#/topic/${String(document.number).padStart(2, '0')}`
        : `#/lab/M${document.number}`
    return anchor ? `${base}?section=${encodeURIComponent(anchor)}` : base
  }

  if (/README\.md$/.test(pathPart)) {
    const readmePath = resolveRepoPath(document.repoPath, pathPart)
    if (readmePath.startsWith('examples/') || readmePath.includes('/labs/') || document.kind === 'lab') return '#/practice'
    if (readmePath === 'tutorial/README.md') return '#/topics'
    if (readmePath === 'tutorial/lectures/README.md') return '#/lectures'
    if (readmePath.startsWith('sources/')) return 'https://jyywiki.cn/OS/2026/'
    return '#/'
  }

  const lectureMatch = /(?:^|\/)(\d{2})-[^/]+\.md$/.exec(pathPart)
  if (lectureMatch) {
    const target = pathPart.startsWith('../') && !pathPart.includes('lectures/') && document.kind !== 'lecture'
      ? 'topic'
      : 'lecture'
    const route = `#/${target}/${lectureMatch[1]}`
    return anchor ? `${route}?section=${encodeURIComponent(anchor)}` : route
  }

  const labMatch = /(?:^|\/)M(\d+)\.md$/.exec(pathPart)
  if (labMatch) return `#/lab/M${labMatch[1]}`

  const repoPath = resolveRepoPath(document.repoPath, pathPart)
  const originalSource = sourceLectureUrl(repoPath)
  if (originalSource) return originalSource

  if (repoPath.startsWith('examples/')) {
    const filename = repoPath.split('/').pop() ?? ''
    if (examples.some((example) => example.filename === filename)) return `#/example/${filename}`
  }

  if (sourceAssets[repoPath]) return sourceAssets[repoPath]
  return href
}

function assetForImage(src: string, document: ContentDocument): string {
  if (/^(https?:|data:|blob:)/i.test(src)) return src
  const projectDocument = asProjectDocument(document)
  if (projectDocument) {
    const repoPath = resolveRepoPath(document.repoPath, src)
    return sourceUrlForRepoPath(projectDocument.projectSlug, repoPath) ?? src
  }
  const repoPath = resolveRepoPath(document.repoPath, src)
  return sourceAssets[repoPath] ?? (src.startsWith('/OS/') ? `https://jyywiki.cn${src}` : src)
}

function calloutClass(text: string): string | undefined {
  if (/安全|危险|权限|警告|边界/.test(text)) return 'callout-warning'
  if (/误区|反例|不要混淆/.test(text)) return 'callout-misconception'
  if (/实验|实践|动手/.test(text)) return 'callout-experiment'
  if (/Takeaways|小结|总结/.test(text)) return 'callout-summary'
  return undefined
}

export interface RenderedMarkdown {
  html: string
  headings: HeadingItem[]
}

function renderMathOutsideCode(raw: string): string {
  return raw
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) => {
      if (index % 2 === 1) return part
      return part
        .replace(/\\\[([\s\S]*?)\\\]/g, (_match, expression: string) => {
          const html = katex.renderToString(expression.trim(), {
            displayMode: true,
            throwOnError: false,
            strict: false,
          })
          return `\n<div class="math-block">${html}</div>\n`
        })
        .replace(/\\\((.+?)\\\)/g, (_match, expression: string) => {
          return katex.renderToString(expression.trim(), {
            displayMode: false,
            throwOnError: false,
            strict: false,
          })
        })
    })
    .join('')
}

export function renderMarkdown(document: ContentDocument): RenderedMarkdown {
  const publishableRaw = asProjectDocument(document)
    ? document.raw.replaceAll('/home/yanzhen/', '/path/to/')
    : document.raw
  const preparedMarkdown = document.kind === 'lab' ? publishableRaw : renderMathOutsideCode(publishableRaw)
  const rawHtml = marked.parse(preparedMarkdown) as string
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['target', 'rel', 'loading', 'decoding', 'data-lightbox'],
  })
  const parsed = new DOMParser().parseFromString(cleanHtml, 'text/html')
  const headings: HeadingItem[] = []
  const counts = new Map<string, number>()
  let currentH2: string | undefined

  parsed.querySelectorAll<HTMLHeadingElement>('h1, h2, h3, h4').forEach((heading) => {
    const text = heading.textContent?.trim() ?? 'section'
    const base = text
      .toLocaleLowerCase('zh-CN')
      .replace(/[“”‘’'"()（）\[\]【】{}：:，,。.!！?？/\\|]/g, ' ')
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'section'
    const seen = counts.get(base) ?? 0
    counts.set(base, seen + 1)
    const id = seen === 0 ? base : `${base}-${seen + 1}`
    const depth = Number(heading.tagName.slice(1))
    heading.id = id
    heading.tabIndex = -1
    if (depth === 2) currentH2 = id
    if (depth >= 2) headings.push({ depth, text, id, parentId: depth > 2 ? currentH2 : undefined })

    const marker = calloutClass(text)
    if (marker) heading.classList.add(marker)
    if (/PPT.*覆盖|覆盖表/.test(text)) heading.classList.add('audit-heading')

    const anchor = parsed.createElement('a')
    anchor.className = 'heading-anchor'
    anchor.href = routeForMarkdownLink(`#${id}`, document)
    anchor.setAttribute('aria-label', `打开“${text}”的章节锚点`)
    anchor.textContent = '#'
    heading.append(anchor)
  })

  const titleHeading = parsed.querySelector('h1')
  if (document.kind === 'lab' && titleHeading) {
    let sibling = titleHeading.previousSibling
    while (sibling) {
      const previous = sibling.previousSibling
      sibling.parentNode?.removeChild(sibling)
      sibling = previous
    }
  }
  titleHeading?.remove()

  parsed.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
    if (link.classList.contains('heading-anchor')) return
    const href = link.getAttribute('href') ?? ''
    const resolved = routeForMarkdownLink(href, document)
    link.setAttribute('href', resolved)
    if (/^https?:/i.test(resolved)) {
      link.target = '_blank'
      link.rel = 'noreferrer noopener'
      link.classList.add('external-link')
    }
  })

  parsed.querySelectorAll<HTMLImageElement>('img').forEach((image) => {
    image.src = assetForImage(image.getAttribute('src') ?? '', document)
    image.loading = 'lazy'
    image.decoding = 'async'
    image.dataset.lightbox = 'true'
    image.tabIndex = 0
    image.setAttribute('role', 'button')
    image.setAttribute('aria-label', `${image.alt || '教程图片'}，打开大图`)
  })

  parsed.querySelectorAll('table').forEach((table) => {
    const wrapper = parsed.createElement('div')
    wrapper.className = 'table-scroll'
    wrapper.tabIndex = 0
    wrapper.setAttribute('role', 'region')
    wrapper.setAttribute('aria-label', '可横向滚动的数据表格')
    table.parentNode?.insertBefore(wrapper, table)
    wrapper.append(table)
  })

  parsed.querySelectorAll<HTMLElement>('pre code').forEach((code) => {
    const language = [...code.classList]
      .find((className) => className.startsWith('language-'))
      ?.replace('language-', '')
    const source = code.textContent ?? ''
    try {
      const escaped: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
      const result = language && hljs.getLanguage(language)
        ? hljs.highlight(source, { language })
        : { value: source.replace(/[&<>]/g, (character) => escaped[character] ?? character) }
      code.innerHTML = result.value
      code.classList.add('hljs')
      const pre = code.parentElement
      if (pre) {
        pre.tabIndex = 0
        pre.setAttribute('aria-label', `${language?.toUpperCase() ?? 'TEXT'} 代码，可横向滚动`)
        if (language) pre.dataset.language = language.toUpperCase()
      }
    } catch {
      // Marked has already escaped code. Leaving it untouched is the safe fallback.
    }
  })

  return { html: parsed.body.innerHTML, headings }
}
