import type { CodeExample, ContentDocument, ContentKind, HeadingItem } from './types'

const lectureFiles = import.meta.glob('../../tutorial/lectures/[0-9][0-9]-*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const topicFiles = import.meta.glob('../../tutorial/[0-9][0-9]-*.md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const labFiles = import.meta.glob('../../sources/notes/labs/M[1-9].md', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const exampleFiles = import.meta.glob('../../examples/*.{c,h}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const sourceAssetFiles = import.meta.glob(
  '../../sources/**/*.{png,jpg,jpeg,gif,svg,webp,pdf}',
  {
    eager: true,
    query: '?url',
    import: 'default',
  },
) as Record<string, string>

export const phaseDefinitions = [
  { key: 'foundations', label: '状态机与启动', range: [1, 4], tone: 'cyan' },
  { key: 'virtualization', label: '进程与应用生态', range: [5, 12], tone: 'blue' },
  { key: 'concurrency', label: '并发与异构计算', range: [13, 21], tone: 'violet' },
  { key: 'persistence', label: '设备、存储与数据库', range: [22, 27], tone: 'amber' },
  { key: 'boundaries', label: '安全、隔离与总结', range: [28, 30], tone: 'rose' },
] as const

const exampleDescriptions: Record<string, string> = {
  'state_machine.c': '指令、程序计数器、时间片和调度的最小模型',
  'fork_exec.c': 'fork → exec → wait 的进程生命周期',
  'mmap_cow.c': '私有映射的 COW 与共享映射',
  'pipeline.c': 'pipe + dup2 + exec 如何组成 Shell 管道',
  'mini_malloc.c': '空闲块、切分、复用和碎片',
  'clock_user.c': '配合 LD_PRELOAD 观察虚拟时钟',
  'preload_clock.c': '动态符号插桩共享库',
  'race_counter.c': '数据竞争、原子变量与互斥锁',
  'mutex_transfer.c': '锁顺序和跨对象不变量',
  'bounded_buffer.c': '条件变量与生产者—消费者',
  'semaphore_dag.c': '用信号量表达计算图依赖',
  'parallel_sum.c': '分片、线程局部结果和 false sharing',
  'epoll_timer.c': '单线程事件循环复用多个事件源',
  'device_file.c': '设备文件、read、fstat 与 ioctl',
  'atomic_replace.c': 'fsync + rename + fsync(dir) 的持久替换',
  'wal_kv.c': '可校验、可重放、容忍尾部撕裂的 WAL',
  'constant_time_compare.c': '早停比较造成的计时侧信道',
  'namespace_info.c': '进程所处 namespace 和 cgroup',
}

function cleanInlineMarkdown(value: string): string {
  const codeSpans: string[] = []
  const protectedValue = value.replace(/`([^`]+)`/g, (_match, code: string) => {
    const token = `CODETOK${codeSpans.length}END`
    codeSpans.push(code)
    return token
  })
  return protectedValue
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\\([\[\]_*])/g, '$1')
    .replace(/CODETOK(\d+)END/g, (_match, index: string) => codeSpans[Number(index)] ?? '')
    .trim()
}

export function slugifyHeading(value: string, counts?: Map<string, number>): string {
  const base = cleanInlineMarkdown(value)
    .toLocaleLowerCase('zh-CN')
    .replace(/[“”‘’'"()（）\[\]【】{}：:，,。.!！?？/\\|]/g, ' ')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'section'

  if (!counts) return base
  const seen = counts.get(base) ?? 0
  counts.set(base, seen + 1)
  return seen === 0 ? base : `${base}-${seen + 1}`
}

function extractHeadings(raw: string): HeadingItem[] {
  const counts = new Map<string, number>()
  const headings: HeadingItem[] = []
  let inFence = false
  let currentH2: string | undefined

  for (const line of raw.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = /^(#{1,4})\s+(.+?)\s*$/.exec(line)
    if (!match) continue
    const depth = match[1].length
    const text = cleanInlineMarkdown(match[2])
    const id = slugifyHeading(match[2], counts)
    if (depth === 2) currentH2 = id
    if (depth >= 2) headings.push({ depth, text, id, parentId: depth > 2 ? currentH2 : undefined })
  }
  return headings
}

function extractDescription(raw: string): string {
  let inFence = false
  const paragraphs: string[] = []
  for (const line of raw.split('\n').slice(1)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || !line.trim()) continue
    if (/^(#|>|[-*+] |\d+\. |\|)/.test(line.trim())) continue
    if (line.trim().length < 28) continue
    paragraphs.push(cleanInlineMarkdown(line.trim()))
    if (paragraphs.join(' ').length > 150) break
  }
  return paragraphs.join(' ').slice(0, 180) || '从课程讲义出发，结合机制推导与可复现实验建立完整理解。'
}

function phaseFor(number: number) {
  return phaseDefinitions.find(({ range }) => number >= range[0] && number <= range[1]) ?? phaseDefinitions[0]
}

function estimateReadingMinutes(raw: string): number {
  const prose = raw.replace(/```[\s\S]*?```/g, ' ')
  const chinese = (prose.match(/[\p{Script=Han}]/gu) ?? []).length
  const words = (prose.match(/[A-Za-z][A-Za-z0-9_+-]*/g) ?? []).length
  return Math.max(6, Math.round(chinese / 520 + words / 230))
}

function makeDocument(path: string, raw: string, kind: ContentKind): ContentDocument {
  const filename = path.split('/').pop() ?? path
  const numberMatch = kind === 'lab' ? /M(\d+)/.exec(filename) : /^(\d{2})-/.exec(filename)
  const number = Number(numberMatch?.[1] ?? 0)
  const titleLine = raw.match(/^#\s+(.+)$/m)?.[1] ?? filename
  const title = cleanInlineMarkdown(titleLine)
  const shortTitle = kind === 'lecture'
    ? title.replace(/^第\s*\d+\s*讲[：:]?\s*/, '')
    : kind === 'topic'
      ? title.replace(/^操作系统主题版教程[：:]?\s*/, '').replace(/^第\s*\d+\s*章[：:]?\s*/, '')
      : title.replace(/^M\d+\s*[：:]\s*/i, '')
  const headings = extractHeadings(raw)
  const phase = kind === 'lecture' ? phaseFor(number) : undefined
  const repoPath = path.replace(/^\.\.\/\.\.\//, '')

  return {
    id: kind === 'lab' ? `lab-M${number}` : `${kind}-${String(number).padStart(2, '0')}`,
    kind,
    number,
    title,
    shortTitle,
    filename,
    repoPath,
    raw,
    description: extractDescription(raw),
    headings,
    readingMinutes: estimateReadingMinutes(raw),
    experimentCount: headings.filter(({ text }) => /实验|实践|demo/i.test(text)).length,
    phase: phase?.label ?? (kind === 'topic' ? '主题学习' : 'MiniLab'),
    phaseKey: phase?.key ?? kind,
    searchText: `${title}\n${headings.map((item) => item.text).join('\n')}\n${raw}`.toLocaleLowerCase('zh-CN'),
  }
}

export const lectures = Object.entries(lectureFiles)
  .map(([path, raw]) => makeDocument(path, raw, 'lecture'))
  .sort((a, b) => a.number - b.number)

export const topics = Object.entries(topicFiles)
  .map(([path, raw]) => makeDocument(path, raw, 'topic'))
  .sort((a, b) => a.number - b.number)

export const labs = Object.entries(labFiles)
  .map(([path, raw]) => makeDocument(path, raw, 'lab'))
  .sort((a, b) => a.number - b.number)

export const examples: CodeExample[] = Object.entries(exampleFiles)
  .map(([path, raw]) => {
    const filename = path.split('/').pop() ?? path
    return {
      id: filename.replace(/\.[^.]+$/, ''),
      filename,
      language: filename.endsWith('.c') || filename.endsWith('.h') ? 'c' : 'text',
      raw,
      description: exampleDescriptions[filename] ?? '课程配套的最小可运行示例',
    }
  })
  .sort((a, b) => a.filename.localeCompare(b.filename))

export const allDocuments = [...lectures, ...topics, ...labs]

export const sourceAssets = Object.fromEntries(
  Object.entries(sourceAssetFiles).map(([path, url]) => {
    const marker = path.indexOf('sources/')
    return [marker >= 0 ? path.slice(marker) : path, url]
  }),
) as Record<string, string>

export function normalizeRepoPath(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

export function resolveRepoPath(baseRepoPath: string, target: string): string {
  const base = baseRepoPath.split('/').slice(0, -1).join('/')
  return normalizeRepoPath(`${base}/${target.split('#')[0].split('?')[0]}`)
}

export function findDocument(kind: ContentKind, number: number): ContentDocument | undefined {
  const collection = kind === 'lecture' ? lectures : kind === 'topic' ? topics : labs
  return collection.find((document) => document.number === number)
}
