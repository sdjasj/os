import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Home,
  ListTree,
  Monitor,
  Moon,
  Minus,
  Plus,
  Search,
  ShieldCheck,
  Sun,
  X,
} from 'lucide-react'
import {
  type FormEvent,
  type TouchEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import {
  formatPdfSize,
  pdfBookHref,
  pdfBooks,
  pdfLibrarySummary,
  type PdfBook,
} from './pdfLibrary'
import { portalUrl } from './projects'
import { useBodyScrollLock } from './useBodyScrollLock'

type ThemeMode = 'system' | 'light' | 'dark'
type ZoomMode = 'fit' | number
type PdfRoute =
  | { view: 'library' }
  | { view: 'reader'; bookId: string; page: number }
  | { view: 'not-found' }

interface ReadingProgress {
  page: number
  total: number
  updatedAt: number
}

interface ReadingState {
  [bookId: string]: ReadingProgress
}

interface OutlineItem {
  id: string
  title: string
  depth: number
  page: number
}

interface RawOutlineItem {
  title: string
  dest: string | unknown[] | null
  items: RawOutlineItem[]
}

const THEME_KEY = 'os26-theme'
const READING_KEY = 'pdf-library-reading-v1'
let pdfJsPromise: Promise<typeof import('pdfjs-dist')> | undefined

const pdfCMapAssets = import.meta.glob('../node_modules/pdfjs-dist/cmaps/*.bcmap', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

const pdfCMapUrls = new Map(
  Object.entries(pdfCMapAssets).map(([path, url]) => [path.split('/').pop() ?? path, url]),
)

class BundledPdfBinaryDataFactory {
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    if (kind !== 'cMapUrl') throw new Error(`Unsupported PDF.js binary data kind: ${kind}`)
    const url = pdfCMapUrls.get(filename)
    if (!url) throw new Error(`Missing bundled PDF.js CMap: ${filename}`)
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Unable to load bundled PDF.js CMap: ${filename}`)
    return new Uint8Array(await response.arrayBuffer())
  }
}

function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import('pdfjs-dist').then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
      return pdfjs
    })
  }
  return pdfJsPromise
}

function parsePdfRoute(): PdfRoute {
  const hash = window.location.hash.slice(1) || '/'
  const [pathname, query = ''] = hash.split('?', 2)
  const rawParts = pathname.split('/').filter(Boolean)
  let parts: string[]
  try {
    parts = rawParts.map(decodeURIComponent)
  } catch {
    return { view: 'not-found' }
  }
  if (!parts.length) return { view: 'library' }
  if (parts[0] === 'read' && parts.length === 2) {
    const requestedPage = Number(new URLSearchParams(query).get('page') ?? '1')
    return {
      view: 'reader',
      bookId: parts[1],
      page: Number.isFinite(requestedPage) ? Math.max(1, Math.round(requestedPage)) : 1,
    }
  }
  return { view: 'not-found' }
}

function readProgress(): ReadingState {
  try {
    const parsed = JSON.parse(localStorage.getItem(READING_KEY) ?? '{}') as ReadingState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveProgress(book: PdfBook, page: number, total: number) {
  try {
    const current = readProgress()
    current[book.id] = { page, total, updatedAt: Date.now() }
    localStorage.setItem(READING_KEY, JSON.stringify(current))
  } catch {
    // Reading still works when browser storage is unavailable.
  }
}

function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY)
      return saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system'
    } catch {
      return 'system'
    }
  })

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = mode === 'dark' || (mode === 'system' && media.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      document.documentElement.dataset.themeMode = mode
      try {
        localStorage.setItem(THEME_KEY, mode)
      } catch {
        // The selected theme still applies to this tab.
      }
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [mode])

  return {
    mode,
    cycle: () => setMode((current) => current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system'),
  }
}

function ThemeButton({ mode, onClick }: { mode: ThemeMode; onClick: () => void }) {
  const label = mode === 'system' ? '跟随系统' : mode === 'light' ? '浅色模式' : '深色模式'
  const icon = mode === 'system' ? <Monitor size={18} /> : mode === 'light' ? <Sun size={18} /> : <Moon size={18} />
  return <button className="icon-button" type="button" onClick={onClick} title={`${label}，点击切换`} aria-label={`${label}，点击切换主题`}>{icon}</button>
}

function PdfLibraryHeader({ mode, onTheme }: { mode: ThemeMode; onTheme: () => void }) {
  return (
    <header className="portal-header pdf-library-header">
      <div className="portal-header-inner section-shell">
        <a className="brand portal-brand" href="#/" aria-label="PDF 阅读书库首页">
          <span className="brand-mark">PDF</span>
          <span className="brand-copy"><strong>PDF 阅读书库</strong><small>READ · RESUME · REVIEW</small></span>
        </a>
        <nav className="portal-header-nav" aria-label="PDF 书库导航">
          <a href="#catalog">全部书目</a>
          <a href="#reading-note">阅读说明</a>
        </nav>
        <a className="project-portal-link pdf-portal-link" href={portalUrl()}><Home size={16} /><span>项目门户</span></a>
        <ThemeButton mode={mode} onClick={onTheme} />
      </div>
    </header>
  )
}

function PdfBookCard({ book, progress }: { book: PdfBook; progress?: ReadingProgress }) {
  const savedPage = Math.min(progress?.page ?? 1, book.pages)
  const started = Boolean(progress)
  const percent = started ? Math.min(100, Math.round(savedPage / book.pages * 100)) : 0
  return (
    <article className={`pdf-book-card portal-tone-${book.tone}`}>
      <a href={pdfBookHref(book.id, savedPage)} aria-label={`${started ? '继续阅读' : '开始阅读'}《${book.title}》`}>
        <div className="pdf-book-cover" aria-hidden="true">
          <span>{book.mark}</span>
          <small>{book.category}</small>
          <strong>PDF</strong>
        </div>
        <div className="pdf-book-copy">
          <div className="pdf-book-kicker"><span>{book.category}</span><span>{book.pages} 页 · {formatPdfSize(book.bytes)}</span></div>
          <h2>{book.title}</h2>
          <p className="pdf-book-subtitle">{book.subtitle}</p>
          <p>{book.description}</p>
          <ul className="portal-tag-list" aria-label="主题标签">
            {book.tags.map((tag) => <li key={tag}>{tag}</li>)}
          </ul>
          {book.safetyNote && <div className="pdf-card-safety"><ShieldCheck size={14} />双用途内容 · 请遵守授权边界</div>}
          <div className="pdf-card-bottom">
            {started ? (
              <div className="pdf-card-progress" aria-label={`阅读进度 ${percent}%`}>
                <div><span>上次读到第 {savedPage} 页</span><span>{percent}%</span></div>
                <span><i style={{ width: `${percent}%` }} /></span>
              </div>
            ) : <span className="pdf-card-unread"><FileText size={14} />尚未开始</span>}
            <span className="card-link">{started ? '继续阅读' : '开始阅读'} <ArrowRight size={16} /></span>
          </div>
        </div>
      </a>
    </article>
  )
}

function PdfLibraryHome() {
  const { mode, cycle } = useTheme()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部主题')
  const progress = useMemo(readProgress, [])
  const categories = useMemo(() => ['全部主题', ...new Set(pdfBooks.map((book) => book.category))], [])
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return pdfBooks.filter((book) => {
      if (category !== '全部主题' && book.category !== category) return false
      if (!normalized) return true
      return [book.title, book.subtitle, book.description, book.category, ...book.tags]
        .join('\n')
        .toLocaleLowerCase('zh-CN')
        .includes(normalized)
    })
  }, [category, query])

  useEffect(() => {
    document.title = 'PDF 阅读书库 · 源码学习实验室'
    window.scrollTo({ top: 0 })
  }, [])

  return (
    <>
      <a className="skip-link" href="#catalog">跳到书目</a>
      <PdfLibraryHeader mode={mode} onTheme={cycle} />
      <main className="pdf-library-page">
        <section className="pdf-library-hero section-shell" aria-labelledby="pdf-library-title">
          <div>
            <span className="eyebrow">RESPONSIVE PDF READER</span>
            <h1 id="pdf-library-title">把资料放进一个<br />随时接着读的书架。</h1>
            <p>覆盖大模型、智能体、强化学习、GPU 与安全方向。按页加载、自动适配屏幕，并在本机保存每本书的阅读位置。</p>
            <a className="button button-primary" href="#catalog">浏览全部书目 <ArrowRight size={17} /></a>
          </div>
          <div className="pdf-library-stats" aria-label="PDF 书库统计">
            <div><strong>{pdfLibrarySummary.bookCount}</strong><span>本 PDF</span></div>
            <div><strong>{pdfLibrarySummary.pageCount}</strong><span>页内容</span></div>
            <div><strong>{pdfLibrarySummary.categoryCount}</strong><span>个主题</span></div>
          </div>
        </section>

        <section id="reading-note" className="pdf-safety-note section-shell">
          <ShieldCheck size={21} />
          <div><strong>公开阅读与安全边界</strong><p>书库保留文件内的原始署名与来源说明，不重新授权第三方材料。安全类内容仅限合法学习、防御研究，以及自有、隔离或明确授权的测试环境。</p></div>
        </section>

        <section id="catalog" className="pdf-catalog section-shell" aria-labelledby="pdf-catalog-title">
          <div className="section-heading portal-section-heading">
            <div><span className="eyebrow">PDF CATALOG</span><h2 id="pdf-catalog-title">选择一本，继续读下去</h2></div>
            <p>支持标题、主题与技术关键词搜索。</p>
          </div>
          <div className="portal-filters" role="search">
            <label className="portal-search-field">
              <span className="sr-only">搜索 PDF</span>
              <Search size={18} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索书名、概念或技术……" />
              {query && <button type="button" onClick={() => setQuery('')} aria-label="清空搜索"><X size={16} /></button>}
            </label>
            <label className="portal-category-field">
              <span>主题</span>
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                {categories.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
          </div>
          <div className="portal-result-summary" role="status" aria-live="polite">显示 {filtered.length} / {pdfBooks.length} 本</div>
          {filtered.length ? (
            <div className="pdf-book-grid">{filtered.map((book) => <PdfBookCard key={book.id} book={book} progress={progress[book.id]} />)}</div>
          ) : (
            <div className="portal-empty-state"><Search size={28} /><h2>没有匹配的 PDF</h2><p>试试更短的关键词，或切换到“全部主题”。</p><button className="button button-secondary" type="button" onClick={() => { setQuery(''); setCategory('全部主题') }}>清除筛选</button></div>
          )}
        </section>
      </main>
      <footer className="site-footer pdf-library-footer">
        <div><a className="brand footer-brand" href="#/"><span className="brand-mark">PDF</span><span className="brand-copy"><strong>PDF 阅读书库</strong><small>10 BOOKS · 948 PAGES</small></span></a><p>阅读位置仅保存在当前浏览器，不会上传。下载、引用或再分发时请遵守各文件中的署名和许可说明。</p></div>
        <div className="footer-links"><a href="#catalog">全部书目</a><a href={portalUrl()}>项目门户</a></div>
      </footer>
    </>
  )
}

async function destinationPage(documentProxy: PDFDocumentProxy, destination: string | unknown[] | null): Promise<number | undefined> {
  if (!destination) return undefined
  const explicit = typeof destination === 'string' ? await documentProxy.getDestination(destination) : destination
  if (!explicit?.length) return undefined
  const reference = explicit[0]
  if (typeof reference === 'number') return reference + 1
  if (reference && typeof reference === 'object' && 'num' in reference && 'gen' in reference) {
    return (await documentProxy.getPageIndex(reference as { num: number; gen: number })) + 1
  }
  return undefined
}

async function flattenOutline(documentProxy: PDFDocumentProxy, nodes: RawOutlineItem[], depth = 0, items: OutlineItem[] = []): Promise<OutlineItem[]> {
  for (const node of nodes) {
    if (items.length >= 160) break
    const page = await destinationPage(documentProxy, node.dest)
    if (page) items.push({ id: `${items.length}-${page}-${node.title}`, title: node.title.trim(), depth: Math.min(depth, 2), page })
    if (node.items?.length) await flattenOutline(documentProxy, node.items, depth + 1, items)
  }
  return items
}

function PdfOutline({ items, currentPage, onPage }: { items: OutlineItem[]; currentPage: number; onPage: (page: number) => void }) {
  if (!items.length) return <p className="pdf-outline-empty">这份 PDF 没有内置目录，请使用页码导航。</p>
  return (
    <nav className="pdf-outline-list" aria-label="PDF 目录">
      {items.map((item) => (
        <button key={item.id} className={item.page === currentPage ? 'active' : ''} style={{ '--outline-depth': item.depth } as React.CSSProperties} type="button" onClick={() => onPage(item.page)}>
          <span>{item.title}</span><small>{item.page}</small>
        </button>
      ))}
    </nav>
  )
}

function PageInput({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const [value, setValue] = useState(String(page))
  useEffect(() => setValue(String(page)), [page])
  const submit = (event?: FormEvent) => {
    event?.preventDefault()
    const next = Number(value)
    if (Number.isFinite(next)) onPage(Math.max(1, Math.min(total, Math.round(next))))
    else setValue(String(page))
  }
  return (
    <form className="pdf-page-input" onSubmit={submit}>
      <label><span className="sr-only">当前页</span><input inputMode="numeric" pattern="[0-9]*" value={value} onChange={(event) => setValue(event.target.value)} onBlur={() => submit()} aria-label={`当前第 ${page} 页，共 ${total} 页`} /></label>
      <span>/ {total}</span>
    </form>
  )
}

function PdfReader({ book, initialPage }: { book: PdfBook; initialPage: number }) {
  const { mode, cycle } = useTheme()
  const [documentProxy, setDocumentProxy] = useState<PDFDocumentProxy>()
  const [currentPage, setCurrentPage] = useState(Math.min(initialPage, book.pages))
  const [pageCount, setPageCount] = useState(book.pages)
  const [zoom, setZoom] = useState<ZoomMode>('fit')
  const [actualScale, setActualScale] = useState(1)
  const [stageWidth, setStageWidth] = useState(0)
  const [outline, setOutline] = useState<OutlineItem[]>([])
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [loadingDocument, setLoadingDocument] = useState(true)
  const [loadingPage, setLoadingPage] = useState(false)
  const [error, setError] = useState<string>()
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 })
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textLayerRef = useRef<HTMLDivElement>(null)
  const touchStart = useRef<{ x: number; y: number } | undefined>(undefined)
  useBodyScrollLock(outlineOpen)

  const goToPage = useCallback((page: number) => {
    setCurrentPage(Math.max(1, Math.min(pageCount, Math.round(page))))
    setOutlineOpen(false)
  }, [pageCount])

  useEffect(() => {
    document.title = `${book.title} · PDF 阅读书库`
  }, [book.title])

  useEffect(() => {
    let cancelled = false
    let loadingTask: PDFDocumentLoadingTask | undefined
    let loadedDocument: PDFDocumentProxy | undefined
    setLoadingDocument(true)
    setError(undefined)
    loadPdfJs()
      .then((pdfjs) => {
        if (cancelled) return undefined
        loadingTask = pdfjs.getDocument({
          url: book.url,
          cMapUrl: 'bundled:/',
          cMapPacked: true,
          useWorkerFetch: false,
          BinaryDataFactory: BundledPdfBinaryDataFactory,
        })
        return loadingTask.promise
      })
      .then(async (loaded) => {
        if (!loaded || cancelled) return
        loadedDocument = loaded
        setDocumentProxy(loaded)
        setPageCount(loaded.numPages)
        setCurrentPage((page) => Math.min(page, loaded.numPages))
        const rawOutline = await loaded.getOutline() as RawOutlineItem[] | null
        if (!cancelled && rawOutline) setOutline(await flattenOutline(loaded, rawOutline))
      })
      .catch(() => { if (!cancelled) setError('PDF 加载失败，请检查网络后重试，或直接打开原文件。') })
      .finally(() => { if (!cancelled) setLoadingDocument(false) })
    return () => {
      cancelled = true
      setDocumentProxy(undefined)
      if (loadingTask) void loadingTask.destroy()
      else if (loadedDocument) void loadedDocument.cleanup()
    }
  }, [book.url])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const update = () => setStageWidth(stage.clientWidth)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!documentProxy || !stageWidth) return
    let cancelled = false
    let renderTask: RenderTask | undefined
    let textLayer: { cancel(): void; render(): Promise<unknown> } | undefined
    setLoadingPage(true)
    setError(undefined)

    Promise.all([documentProxy.getPage(currentPage), loadPdfJs()])
      .then(async ([pdfPage, pdfjs]) => {
        if (cancelled) return
        const baseViewport = pdfPage.getViewport({ scale: 1 })
        const fitScale = Math.max(0.3, Math.min(2.25, (stageWidth - (stageWidth < 620 ? 24 : 52)) / baseViewport.width))
        const scale = zoom === 'fit' ? fitScale : zoom
        const viewport = pdfPage.getViewport({ scale })
        const outputScale = Math.min(window.devicePixelRatio || 1, 2)
        const canvas = canvasRef.current
        const textContainer = textLayerRef.current
        if (!canvas || !textContainer) return

        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        textContainer.replaceChildren()
        textContainer.style.width = `${Math.floor(viewport.width)}px`
        textContainer.style.height = `${Math.floor(viewport.height)}px`
        textContainer.style.setProperty('--scale-factor', String(scale))
        textContainer.style.setProperty('--total-scale-factor', String(scale))
        setPageSize({ width: Math.floor(viewport.width), height: Math.floor(viewport.height) })
        setActualScale(scale)

        renderTask = pdfPage.render({
          canvas,
          viewport,
          transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
        })
        const textContentPromise = pdfPage.getTextContent()
        await renderTask.promise
        if (cancelled) return
        textLayer = new pdfjs.TextLayer({
          textContentSource: await textContentPromise,
          container: textContainer,
          viewport,
        })
        await textLayer.render()
      })
      .catch((reason: unknown) => {
        if (!cancelled && !(reason instanceof Error && reason.name === 'RenderingCancelledException')) {
          setError('这一页暂时无法渲染，可尝试刷新或打开原 PDF。')
        }
      })
      .finally(() => { if (!cancelled) setLoadingPage(false) })

    return () => {
      cancelled = true
      renderTask?.cancel()
      textLayer?.cancel()
    }
  }, [currentPage, documentProxy, stageWidth, zoom])

  useEffect(() => {
    saveProgress(book, currentPage, pageCount)
    window.history.replaceState(null, '', pdfBookHref(book.id, currentPage))
    stageRef.current?.scrollTo({ top: 0, left: 0 })
  }, [book, currentPage, pageCount])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.matches('input, select, textarea, button, a')) return
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        event.preventDefault()
        goToPage(currentPage - 1)
      } else if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
        event.preventDefault()
        goToPage(currentPage + 1)
      } else if (event.key === 'Escape') {
        setOutlineOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentPage, goToPage])

  const zoomIn = () => setZoom(Math.min(2.8, (zoom === 'fit' ? actualScale : zoom) * 1.2))
  const zoomOut = () => setZoom(Math.max(0.35, (zoom === 'fit' ? actualScale : zoom) / 1.2))
  const onTouchStart = (event: TouchEvent) => {
    if (event.touches.length === 1) touchStart.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }
  }
  const onTouchEnd = (event: TouchEvent) => {
    const start = touchStart.current
    touchStart.current = undefined
    if (!start || !event.changedTouches.length) return
    const dx = event.changedTouches[0].clientX - start.x
    const dy = event.changedTouches[0].clientY - start.y
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) goToPage(currentPage + (dx < 0 ? 1 : -1))
  }

  const outlinePanel = <PdfOutline items={outline} currentPage={currentPage} onPage={goToPage} />

  return (
    <div className="pdf-reader-app">
      <header className="pdf-reader-header">
        <a className="pdf-reader-back" href="#/"><ArrowLeft size={17} /><span>书库</span></a>
        <div className="pdf-reader-title"><span className={`pdf-reader-mark portal-tone-${book.tone}`}>{book.mark}</span><div><strong>{book.title}</strong><small>{book.subtitle}</small></div></div>
        <div className="pdf-reader-actions">
          <a className="icon-button" href={book.url} download={book.filename} title="下载 PDF" aria-label={`下载《${book.title}》`}><Download size={18} /></a>
          <a className="icon-button" href={book.url} target="_blank" rel="noreferrer" title="在浏览器中打开原 PDF" aria-label="打开原 PDF"><ExternalLink size={18} /></a>
          <ThemeButton mode={mode} onClick={cycle} />
        </div>
      </header>

      <div className="pdf-reader-body">
        <aside className="pdf-reader-sidebar">
          <div className="pdf-sidebar-head"><span className="eyebrow">DOCUMENT OUTLINE</span><h2>文档目录</h2><p>{book.pages} 页 · {formatPdfSize(book.bytes)}</p></div>
          {book.safetyNote && <div className="pdf-reader-safety"><ShieldCheck size={16} /><span>{book.safetyNote}</span></div>}
          {outlinePanel}
        </aside>

        <main className="pdf-reader-main">
          <div className="pdf-reader-toolbar" aria-label="PDF 阅读控制">
            <button className="pdf-tool-button pdf-outline-trigger" type="button" onClick={() => setOutlineOpen(true)}><ListTree size={17} /><span>目录</span></button>
            <div className="pdf-page-controls">
              <button className="pdf-tool-button" type="button" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)} aria-label="上一页"><ChevronLeft size={18} /></button>
              <PageInput page={currentPage} total={pageCount} onPage={goToPage} />
              <button className="pdf-tool-button" type="button" disabled={currentPage >= pageCount} onClick={() => goToPage(currentPage + 1)} aria-label="下一页"><ChevronRight size={18} /></button>
            </div>
            <div className="pdf-zoom-controls">
              <button className="pdf-tool-button" type="button" onClick={zoomOut} aria-label="缩小"><Minus size={17} /></button>
              <button className={`pdf-fit-button ${zoom === 'fit' ? 'active' : ''}`} type="button" onClick={() => setZoom('fit')}>{zoom === 'fit' ? '适合宽度' : `${Math.round(actualScale * 100)}%`}</button>
              <button className="pdf-tool-button" type="button" onClick={zoomIn} aria-label="放大"><Plus size={17} /></button>
            </div>
            <span className="pdf-reader-hint">← → 翻页 · 滑动切页 · 可选择文字</span>
          </div>

          <div ref={stageRef} className="pdf-page-scroll" aria-busy={loadingDocument || loadingPage} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
            <div className="pdf-page-centered">
              <div className={`pdf-page-shell ${pageSize.height ? 'page-ready' : ''}`} style={{ width: pageSize.width || undefined, height: pageSize.height || undefined }}>
                <canvas ref={canvasRef} aria-label={`《${book.title}》第 ${currentPage} 页`} role="img" />
                <div ref={textLayerRef} className="pdf-text-layer textLayer" />
                {(loadingDocument || loadingPage) && <div className="pdf-page-loading" role="status"><span className="project-loading-spinner" /><strong>{loadingDocument ? '正在打开 PDF…' : `正在渲染第 ${currentPage} 页…`}</strong></div>}
                {error && <div className="pdf-page-error" role="alert"><FileText size={28} /><strong>{error}</strong><a className="button button-secondary" href={book.url} target="_blank" rel="noreferrer">打开原 PDF <ExternalLink size={15} /></a></div>}
              </div>
            </div>
          </div>

          <nav className="pdf-mobile-controls" aria-label="移动端翻页">
            <button type="button" disabled={currentPage <= 1} onClick={() => goToPage(currentPage - 1)}><ChevronLeft size={19} /><span>上一页</span></button>
            <button type="button" onClick={() => setOutlineOpen(true)}><ListTree size={19} /><span>{currentPage} / {pageCount}</span></button>
            <button type="button" disabled={currentPage >= pageCount} onClick={() => goToPage(currentPage + 1)}><ChevronRight size={19} /><span>下一页</span></button>
          </nav>
        </main>
      </div>

      {outlineOpen && (
        <div className="pdf-outline-layer" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setOutlineOpen(false) }}>
          <section className="pdf-outline-drawer" role="dialog" aria-modal="true" aria-label="PDF 目录">
            <div className="drawer-head"><div><span className="eyebrow">DOCUMENT OUTLINE</span><h2>{book.title}</h2></div><button className="icon-button" type="button" onClick={() => setOutlineOpen(false)} aria-label="关闭目录"><X size={20} /></button></div>
            {book.safetyNote && <div className="pdf-reader-safety"><ShieldCheck size={16} /><span>{book.safetyNote}</span></div>}
            {outlinePanel}
          </section>
        </div>
      )}
    </div>
  )
}

function PdfNotFound() {
  const { mode, cycle } = useTheme()
  return (
    <><PdfLibraryHeader mode={mode} onTheme={cycle} /><main className="not-found section-shell"><span className="eyebrow">PDF NOT FOUND</span><h1>没有找到这本 PDF。</h1><p>链接可能已失效，回到书库重新选择一本即可。</p><a className="button button-primary" href="#/"><BookOpen size={17} />返回 PDF 书库</a></main></>
  )
}

export function PdfLibraryApp() {
  const [route, setRoute] = useState<PdfRoute>(parsePdfRoute)
  useEffect(() => {
    const onHashChange = () => setRoute(parsePdfRoute())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  if (route.view === 'library') return <PdfLibraryHome />
  if (route.view === 'reader') {
    const book = pdfBooks.find((item) => item.id === route.bookId)
    if (book) return <PdfReader key={book.id} book={book} initialPage={route.page} />
  }
  return <PdfNotFound />
}
