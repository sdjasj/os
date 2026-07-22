import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Code2,
  Command,
  ExternalLink,
  FlaskConical,
  GraduationCap,
  Home,
  Layers3,
  ListTree,
  Menu,
  Monitor,
  Moon,
  Search,
  Sun,
  TerminalSquare,
  X,
} from 'lucide-react'
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { MarkdownView } from './components/MarkdownView'
import { copyText } from './clipboard'
import {
  allDocuments,
  examples,
  findDocument,
  labs,
  lectures,
  phaseDefinitions,
  topics,
} from './content'
import type {
  CodeExample,
  ContentDocument,
  ContentKind,
  HeadingItem,
  ReadingRecord,
  ReadingState,
} from './types'
import { scrollElementIntoView, scrollWindowTo } from './scroll'
import { useBodyScrollLock } from './useBodyScrollLock'

type ThemeMode = 'system' | 'light' | 'dark'

type Route =
  | { view: 'home' }
  | { view: 'lectures' }
  | { view: 'topics' }
  | { view: 'practice' }
  | { view: 'document'; kind: ContentKind; number: number; section?: string }
  | { view: 'example'; filename: string }
  | { view: 'not-found' }

interface SearchResult {
  id: string
  kind: 'lecture' | 'topic' | 'lab' | 'code'
  eyebrow: string
  title: string
  context: string
  href: string
  score: number
}

const READING_KEY = 'os26-reading-state'
const THEME_KEY = 'os26-theme'

function parseRoute(): Route {
  const hash = window.location.hash.slice(1) || '/'
  const [pathname, query = ''] = hash.split('?')
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent)
  const params = new URLSearchParams(query)

  if (parts.length === 0) return { view: 'home' }
  if (parts[0] === 'lectures' && parts.length === 1) return { view: 'lectures' }
  if (parts[0] === 'topics' && parts.length === 1) return { view: 'topics' }
  if (parts[0] === 'practice' && parts.length === 1) return { view: 'practice' }

  if (parts[0] === 'lecture' && /^\d+$/.test(parts[1] ?? '')) {
    return { view: 'document', kind: 'lecture', number: Number(parts[1]), section: params.get('section') ?? undefined }
  }
  if (parts[0] === 'topic' && /^\d+$/.test(parts[1] ?? '')) {
    return { view: 'document', kind: 'topic', number: Number(parts[1]), section: params.get('section') ?? undefined }
  }
  if (parts[0] === 'lab' && /^M\d+$/i.test(parts[1] ?? '')) {
    return { view: 'document', kind: 'lab', number: Number(parts[1].slice(1)), section: params.get('section') ?? undefined }
  }
  if (parts[0] === 'example' && parts[1]) return { view: 'example', filename: parts.slice(1).join('/') }
  return { view: 'not-found' }
}

function documentHref(document: ContentDocument, section?: string): string {
  const base = document.kind === 'lecture'
    ? `#/lecture/${String(document.number).padStart(2, '0')}`
    : document.kind === 'topic'
      ? `#/topic/${String(document.number).padStart(2, '0')}`
      : `#/lab/M${document.number}`
  return section ? `${base}?section=${encodeURIComponent(section)}` : base
}

function loadReadingState(): ReadingState {
  try {
    const parsed = JSON.parse(localStorage.getItem(READING_KEY) ?? '{}') as ReadingState
    return { records: parsed.records ?? {}, lastVisited: parsed.lastVisited }
  } catch {
    return { records: {} }
  }
}

function routeLabel(route: Route): string {
  if (route.view === 'lectures') return '逐讲教程'
  if (route.view === 'topics') return '主题教程'
  if (route.view === 'practice') return '实验与代码'
  if (route.view === 'document') return route.kind === 'lecture' ? '逐讲教程' : route.kind === 'topic' ? '主题教程' : 'MiniLab'
  if (route.view === 'example') return '代码示例'
  return '课程首页'
}

function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as ThemeMode | null) ?? 'system'
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
        // The visual theme still works for this tab when storage is unavailable.
      }
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [mode])

  const cycle = () => setMode((current) => current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system')
  return { mode, cycle }
}

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === 'light') return <Sun size={18} />
  if (mode === 'dark') return <Moon size={18} />
  return <Monitor size={18} />
}

function AppHeader({ route, onSearch, theme, onTheme, onMenu, menuOpen, searchOpen }: {
  route: Route
  onSearch: () => void
  theme: ThemeMode
  onTheme: () => void
  onMenu: () => void
  menuOpen: boolean
  searchOpen: boolean
}) {
  const themeLabel = theme === 'system' ? '跟随系统' : theme === 'light' ? '浅色模式' : '深色模式'
  return (
    <header className="app-header">
      <div className="header-inner">
        <button className="icon-button mobile-menu-button" type="button" aria-label="打开课程目录" aria-haspopup="dialog" aria-expanded={menuOpen} aria-controls="course-navigation" onClick={onMenu}>
          <Menu size={20} />
        </button>
        <a className="brand" href="#/" aria-label="OS 2026 教程首页">
          <span className="brand-mark">OS</span>
          <span className="brand-copy">
            <strong>系统实验手册</strong>
            <small>JYY · OS/2026</small>
          </span>
        </a>
        <nav className="header-nav" aria-label="主导航">
          <a className={routeLabel(route) === '逐讲教程' ? 'active' : ''} aria-current={routeLabel(route) === '逐讲教程' ? 'page' : undefined} href="#/lectures">逐讲</a>
          <a className={routeLabel(route) === '主题教程' ? 'active' : ''} aria-current={routeLabel(route) === '主题教程' ? 'page' : undefined} href="#/topics">主题</a>
          <a className={['实验与代码', 'MiniLab', '代码示例'].includes(routeLabel(route)) ? 'active' : ''} aria-current={['实验与代码', 'MiniLab', '代码示例'].includes(routeLabel(route)) ? 'page' : undefined} href="#/practice">实践</a>
        </nav>
        <div className="header-actions">
          <button className="search-trigger" type="button" onClick={onSearch} aria-label="搜索全部教程" aria-haspopup="dialog" aria-expanded={searchOpen} aria-controls="global-search">
            <Search size={17} />
            <span>搜索教程</span>
            <kbd><Command size={12} /> K</kbd>
          </button>
          <button className="icon-button" type="button" onClick={onTheme} title={`${themeLabel}，点击切换`} aria-label={`${themeLabel}，点击切换主题`}>
            <ThemeIcon mode={theme} />
          </button>
        </div>
      </div>
    </header>
  )
}

function MobileNavigation({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  useBodyScrollLock(open)

  useEffect(() => {
    if (!open) return
    previousFocus.current = window.document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const first = panel?.querySelector<HTMLElement>('button, a[href]')
    first?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab' || !panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')]
      if (!focusable.length) return
      const firstItem = focusable[0]
      const lastItem = focusable[focusable.length - 1]
      if (event.shiftKey && window.document.activeElement === firstItem) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && window.document.activeElement === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
      if (previousFocus.current?.isConnected) previousFocus.current.focus()
    }
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="drawer-layer" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside id="course-navigation" ref={panelRef} className="mobile-drawer" role="dialog" aria-modal="true" aria-label="课程导航">
        <div className="drawer-head">
          <div><span className="eyebrow">COURSE MAP</span><h2>学习导航</h2></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭课程导航"><X size={20} /></button>
        </div>
        <a className="drawer-primary-link" href="#/" onClick={onClose}><Home size={18} />课程首页</a>
        <a className="drawer-primary-link" href="#/lectures" onClick={onClose}><GraduationCap size={18} />30 讲逐讲教程</a>
        <a className="drawer-primary-link" href="#/topics" onClick={onClose}><Layers3 size={18} />17 章主题教程</a>
        <a className="drawer-primary-link" href="#/practice" onClick={onClose}><FlaskConical size={18} />实验与代码</a>
        <div className="drawer-lecture-grid">
          {lectures.map((lecture) => (
            <a key={lecture.id} href={documentHref(lecture)} onClick={onClose} title={lecture.shortTitle} aria-label={`第 ${lecture.number} 讲：${lecture.shortTitle}`}>
              {String(lecture.number).padStart(2, '0')}
            </a>
          ))}
        </div>
      </aside>
    </div>
  )
}

function ModeCard({ href, icon, eyebrow, title, detail, count, tone }: {
  href: string
  icon: ReactNode
  eyebrow: string
  title: string
  detail: string
  count: string
  tone: string
}) {
  return (
    <a className={`mode-card mode-${tone}`} href={href}>
      <div className="mode-card-top"><span className="mode-icon">{icon}</span><span className="mode-count">{count}</span></div>
      <span className="eyebrow">{eyebrow}</span>
      <h3>{title}</h3>
      <p>{detail}</p>
      <span className="card-link">开始学习 <ArrowRight size={16} /></span>
    </a>
  )
}

function HomePage({ reading }: { reading: ReadingState }) {
  const completed = Object.values(reading.records).filter((record) => record.completed).length
  const lastDocument = useMemo(() => {
    if (!reading.lastVisited) return undefined
    const id = reading.lastVisited.split(':')[0]
    return allDocuments.find((document) => document.id === id)
  }, [reading.lastVisited])
  const lastRecord = lastDocument ? reading.records[lastDocument.id] : undefined

  return (
    <main id="main-content">
      <section className="hero section-shell">
        <div className="hero-grid">
          <div className="hero-copy">
            <div className="hero-kicker"><span></span> 南京大学 · 操作系统原理 2026</div>
            <h1>从状态机出发，<br />读懂一台计算机。</h1>
            <p className="hero-lead">沿着“状态机 → 进程 → 并发 → 持久化 → 安全与隔离”的主线，把 30 讲课程 PPT 还原成可推导、可运行、可复习的系统教程。</p>
            <div className="hero-actions">
              <a className="button button-primary" href={lastDocument ? documentHref(lastDocument, lastRecord?.lastSection) : documentHref(lectures[0])}>
                {lastDocument ? '继续上次学习' : '从第 1 讲开始'} <ArrowRight size={17} />
              </a>
              <a className="button button-secondary" href="#/lectures"><ListTree size={17} /> 浏览课程目录</a>
            </div>
            <div className="hero-stats" aria-label="教程规模">
              <div><strong>{lectures.length}</strong><span>逐讲详解</span></div>
              <div><strong>{topics.length}</strong><span>主题章节</span></div>
              <div><strong>{labs.length}</strong><span>MiniLab</span></div>
              <div><strong>{examples.length}</strong><span>代码示例</span></div>
            </div>
          </div>
          <div className="hero-notebook" aria-label="课程学习路线">
            <div className="notebook-head"><span>OS / 2026</span><span>STUDY LOG</span></div>
            <div className="notebook-state">
              <span className="state-dot"></span>
              <div><small>CURRENT STATE</small><strong>{lastDocument ? lastDocument.shortTitle : '准备开始学习'}</strong></div>
              <span className="state-percent">{lastRecord?.percent ?? 0}%</span>
            </div>
            <div className="notebook-track">
              {phaseDefinitions.map((phase, index) => (
                <Fragment key={phase.key}>
                  <div className={`track-node tone-${phase.tone}`}><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{phase.label}</strong><small>LECT {String(phase.range[0]).padStart(2, '0')}—{String(phase.range[1]).padStart(2, '0')}</small></div></div>
                  {index < phaseDefinitions.length - 1 && <div className="track-line" />}
                </Fragment>
              ))}
            </div>
            <div className="notebook-foot"><span>{completed} 个内容已完成</span><span>本地保存进度</span></div>
          </div>
        </div>
      </section>

      <section className="mode-section section-shell" aria-labelledby="mode-title">
        <div className="section-heading"><div><span className="eyebrow">THREE PATHS</span><h2 id="mode-title">选择你的学习方式</h2></div><p>按课堂顺序建立完整脉络，按主题集中攻坚，或直接从可运行实验进入。</p></div>
        <div className="mode-grid">
          <ModeCard href="#/lectures" icon={<GraduationCap size={22} />} eyebrow="LECTURE PATH" title="按 30 讲循序学习" detail="逐页覆盖课程 PPT 的概念、推导、例子与思考题，适合第一次系统学习。" count="30 讲" tone="teal" />
          <ModeCard href="#/topics" icon={<Layers3 size={22} />} eyebrow="TOPIC PATH" title="按 17 个主题串联" detail="跨课次重组知识，把进程、并发、文件系统、安全等机制连成完整体系。" count="17 章" tone="violet" />
          <ModeCard href="#/practice" icon={<TerminalSquare size={22} />} eyebrow="LAB PATH" title="从代码和实验切入" detail="用最小 C 程序与 MiniLab 观察系统调用、竞争、持久化和隔离边界。" count={`${labs.length + examples.length} 项`} tone="amber" />
        </div>
      </section>

      <section className="map-section section-shell" aria-labelledby="map-title">
        <div className="section-heading"><div><span className="eyebrow">KNOWLEDGE MAP</span><h2 id="map-title">五个阶段，一条系统主线</h2></div><a className="text-link" href="#/lectures">查看全部课程 <ArrowRight size={15} /></a></div>
        <div className="phase-list">
          {phaseDefinitions.map((phase, index) => {
            const phaseLectures = lectures.filter((lecture) => lecture.number >= phase.range[0] && lecture.number <= phase.range[1])
            return (
              <div className="phase-row" key={phase.key}>
                <div className={`phase-index tone-${phase.tone}`}>{String(index + 1).padStart(2, '0')}</div>
                <div className="phase-title"><span>第 {phase.range[0]}–{phase.range[1]} 讲</span><h3>{phase.label}</h3></div>
                <div className="phase-lectures">
                  {phaseLectures.map((lecture) => <a key={lecture.id} href={documentHref(lecture)}><b>{String(lecture.number).padStart(2, '0')}</b>{lecture.shortTitle}<ChevronRight size={14} /></a>)}
                </div>
              </div>
            )
          })}
        </div>
      </section>
    </main>
  )
}

function DocumentCard({ document, record, nested = false }: { document: ContentDocument; record?: ReadingRecord; nested?: boolean }) {
  return (
    <a className="document-card" href={documentHref(document, record?.lastSection)}>
      <div className="document-card-number">{document.kind === 'lab' ? `M${document.number}` : String(document.number).padStart(2, '0')}</div>
      <div className="document-card-body">
        <div className="document-card-meta"><span>{document.phase}</span><span><Clock3 size={13} /> {document.readingMinutes} 分钟</span>{document.experimentCount > 0 && <span><FlaskConical size={13} /> {document.experimentCount} 个实践点</span>}</div>
        {nested ? <h3>{document.shortTitle}</h3> : <h2>{document.shortTitle}</h2>}
        <p>{document.description}</p>
        {record && <div className="mini-progress" aria-label={`阅读进度 ${record.percent}%`}><span style={{ width: `${record.percent}%` }} /></div>}
      </div>
      <div className="document-card-state">{record?.completed ? <CheckCircle2 size={20} /> : <ChevronRight size={19} />}</div>
    </a>
  )
}

function CollectionPage({ kind, reading }: { kind: 'lecture' | 'topic'; reading: ReadingState }) {
  const documents = kind === 'lecture' ? lectures : topics
  const isLecture = kind === 'lecture'
  return (
    <main id="main-content" className="collection-page section-shell">
      <div className="page-intro">
        <span className="eyebrow">{isLecture ? 'LECTURE PATH · 01—30' : 'TOPIC PATH · 01—17'}</span>
        <h1>{isLecture ? '30 讲逐讲教程' : '17 章主题教程'}</h1>
        <p>{isLecture ? '严格沿课程节奏展开。每一讲完整覆盖 PPT 涉及的内容，再用代码、状态机和实验把机制落到可观察的行为。' : '把散落在不同课次中的概念重新组合。适合完成逐讲学习后复习，也适合围绕一个问题集中攻坚。'}</p>
      </div>
      {isLecture ? (
        <div className="phase-collections">
          {phaseDefinitions.map((phase) => (
            <section key={phase.key} className="collection-group">
              <div className="collection-group-head"><span className={`phase-pip tone-${phase.tone}`} /><div><span>LECT {String(phase.range[0]).padStart(2, '0')}—{String(phase.range[1]).padStart(2, '0')}</span><h2>{phase.label}</h2></div></div>
              <div className="document-list">
                {documents.filter((item) => item.number >= phase.range[0] && item.number <= phase.range[1]).map((document) => <DocumentCard key={document.id} document={document} record={reading.records[document.id]} nested />)}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="document-list topic-list">{documents.map((document) => <DocumentCard key={document.id} document={document} record={reading.records[document.id]} />)}</div>
      )}
    </main>
  )
}

function PracticePage({ reading }: { reading: ReadingState }) {
  return (
    <main id="main-content" className="practice-page section-shell">
      <div className="page-intro practice-intro">
        <span className="eyebrow">LEARN BY OBSERVING</span>
        <h1>实验与代码</h1>
        <p>操作系统的概念只有变成可观察的行为，才真正属于你。先阅读最小例子，再修改参数、制造边界条件，并用系统工具验证自己的预测。</p>
      </div>
      <section className="practice-section" aria-labelledby="minilab-title">
        <div className="practice-section-head"><div><span className="eyebrow">GUIDED LABS</span><h2 id="minilab-title">9 个 MiniLab</h2></div><p>每个实验都给出目标、步骤、预期现象和机制解释。</p></div>
        <div className="lab-grid">
          {labs.map((lab) => (
            <a className="lab-card" href={documentHref(lab, reading.records[lab.id]?.lastSection)} key={lab.id}>
              <div className="lab-card-id">M{lab.number}</div>
              <div><span>{lab.readingMinutes} 分钟 · {lab.headings.length} 个小节</span><h3>{lab.shortTitle}</h3><p>{lab.description}</p></div>
              {reading.records[lab.id]?.completed ? <CheckCircle2 size={19} /> : <ArrowRight size={18} />}
            </a>
          ))}
        </div>
      </section>
      <section className="practice-section" aria-labelledby="examples-title">
        <div className="practice-section-head"><div><span className="eyebrow">RUNNABLE C</span><h2 id="examples-title">{examples.length} 个最小代码示例</h2></div><p>保留问题本身，去掉框架噪声；每个程序都可以独立编译、运行和修改。</p></div>
        <div className="example-grid">
          {examples.map((example) => (
            <a className="example-card" href={`#/example/${encodeURIComponent(example.filename)}`} key={example.id}>
              <div className="file-icon"><Code2 size={19} /></div>
              <div><h3>{example.filename}</h3><p>{example.description}</p></div>
              <ChevronRight size={17} />
            </a>
          ))}
        </div>
      </section>
    </main>
  )
}

function ExamplePage({ example }: { example: CodeExample }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (await copyText(example.raw)) {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } else {
      setCopied(false)
    }
  }
  return (
    <main id="main-content" className="example-page section-shell">
      <a className="back-link" href="#/practice"><ArrowLeft size={16} /> 返回实验与代码</a>
      <div className="example-hero">
        <div className="file-icon file-icon-large"><Code2 size={24} /></div>
        <div><span className="eyebrow">RUNNABLE EXAMPLE · C</span><h1>{example.filename}</h1><p>{example.description}</p></div>
      </div>
      <div className="run-hint"><TerminalSquare size={20} /><div><strong>运行建议</strong><p>在 Linux 环境中阅读源码，先预测输出，再使用仓库 <code>examples/Makefile</code> 编译运行。涉及 namespace、设备或性能计数器的程序可能需要额外权限。</p></div></div>
      <div className="standalone-code">
        <div className="standalone-code-head"><span>{example.filename}</span><button type="button" onClick={copy}>{copied ? <Check size={15} /> : <Code2 size={15} />}{copied ? '已复制' : '复制源码'}</button></div>
        <pre><code>{example.raw}</code></pre>
      </div>
      <div className="example-actions"><a className="button button-secondary" href="#/practice"><ArrowLeft size={16} /> 查看其他实验</a><a className="button button-primary" href="#/lecture/01">回到课程主线 <ArrowRight size={16} /></a></div>
    </main>
  )
}

function LectureRail({ current, open, onClose }: { current: ContentDocument; open: boolean; onClose: () => void }) {
  const collection = current.kind === 'lecture' ? lectures : current.kind === 'topic' ? topics : labs
  const label = current.kind === 'lecture' ? '30 讲课程' : current.kind === 'topic' ? '17 章主题' : '9 个 MiniLab'
  return (
    <aside id="reader-rail" className={`reader-rail ${open ? 'rail-open' : ''}`} aria-label={label} role={open ? 'dialog' : undefined} aria-modal={open || undefined}>
      <div className="rail-head"><span className="eyebrow">{label}</span><button type="button" className="icon-button rail-close" onClick={onClose} aria-label="关闭章节目录"><X size={19} /></button></div>
      <nav>
        {collection.map((document) => (
          <a key={document.id} href={documentHref(document)} className={document.id === current.id ? 'active' : ''} aria-current={document.id === current.id ? 'page' : undefined} onClick={onClose} title={document.shortTitle}>
            <span>{document.kind === 'lab' ? `M${document.number}` : String(document.number).padStart(2, '0')}</span>
            <div><strong>{document.shortTitle}</strong><small>{document.phase}</small></div>
          </a>
        ))}
      </nav>
    </aside>
  )
}

function TableOfContents({ document, headings, active, mobile, onClose }: {
  document: ContentDocument
  headings: HeadingItem[]
  active?: string
  mobile?: boolean
  onClose?: () => void
}) {
  const activeHeading = headings.find((heading) => heading.id === active)
  const activeParent = activeHeading?.depth === 2 ? activeHeading.id : activeHeading?.parentId
  const visible = headings.filter((heading) => heading.depth === 2 || (heading.depth === 3 && heading.parentId === activeParent))
  return (
    <aside id={mobile ? 'mobile-toc' : undefined} className={mobile ? 'toc-sheet' : 'reader-toc'} aria-label="本讲目录" role={mobile ? 'dialog' : undefined} aria-modal={mobile || undefined}>
      <div className="toc-head"><span className="eyebrow">ON THIS PAGE</span>{mobile && <button className="icon-button" type="button" onClick={onClose} aria-label="关闭本讲目录"><X size={19} /></button>}</div>
      <nav>
        {visible.map((heading) => (
          <a key={heading.id} className={`${heading.depth === 3 ? 'toc-h3' : ''} ${active === heading.id ? 'active' : ''}`} aria-current={active === heading.id ? 'location' : undefined} href={documentHref(document, heading.id)} onClick={onClose}>
            <span />{heading.text}
          </a>
        ))}
      </nav>
      <div className="toc-source"><ExternalLink size={14} /><a href="https://jyywiki.cn/OS/2026/" target="_blank" rel="noreferrer">课程原始站点</a></div>
    </aside>
  )
}

function ReaderPage({ document, initialSection, record, onProgress, onComplete }: {
  document: ContentDocument
  initialSection?: string
  record?: ReadingRecord
  onProgress: (percent: number, section?: string) => void
  onComplete: () => void
}) {
  const [headings, setHeadings] = useState<HeadingItem[]>(document.headings.filter((heading) => heading.depth >= 2))
  const [active, setActive] = useState<string | undefined>(initialSection ?? record?.lastSection)
  const [progress, setProgress] = useState(record?.percent ?? 0)
  const [railOpen, setRailOpen] = useState(false)
  const [tocOpen, setTocOpen] = useState(false)
  const articleRef = useRef<HTMLElement>(null)
  const activeRef = useRef(active)
  const onProgressRef = useRef(onProgress)
  const handledLocationRef = useRef<string | undefined>(undefined)
  const overlayPreviousFocusRef = useRef<HTMLElement | null>(null)
  useBodyScrollLock(railOpen || tocOpen)

  useEffect(() => {
    activeRef.current = active
  }, [active])

  useEffect(() => {
    onProgressRef.current = onProgress
  }, [onProgress])

  useEffect(() => {
    setProgress(record?.percent ?? 0)
    setActive(initialSection ?? record?.lastSection)
    handledLocationRef.current = undefined
    window.document.title = `${document.shortTitle} · OS/2026`
  }, [document.id])

  const receiveHeadings = useCallback((items: HeadingItem[]) => setHeadings(items), [])

  useEffect(() => {
    const section = initialSection ?? record?.lastSection
    const locationKey = `${document.id}:${initialSection ?? '__resume__'}`
    if (handledLocationRef.current === locationKey) return
    if (!section) {
      scrollWindowTo(0)
      const frame = window.requestAnimationFrame(() => {
        handledLocationRef.current = locationKey
        const title = articleRef.current?.querySelector<HTMLElement>('h1')
        title?.setAttribute('tabindex', '-1')
        title?.focus({ preventScroll: true })
      })
      return () => window.cancelAnimationFrame(frame)
    }
    let cancelled = false
    let settleTimer: number | undefined
    let focusTimer: number | undefined
    const positionTarget = () => {
      if (cancelled) return
      const target = window.document.getElementById(section)
      if (!target) return
      handledLocationRef.current = locationKey
      scrollElementIntoView(target)
      if (focusTimer) window.clearTimeout(focusTimer)
      focusTimer = window.setTimeout(() => {
        if (!cancelled) window.document.getElementById(section)?.focus({ preventScroll: true })
      }, 80)
    }
    const frame = window.requestAnimationFrame(() => {
      positionTarget()
      const target = window.document.getElementById(section)
      if (!target) return
      const earlierImages = [...(articleRef.current?.querySelectorAll<HTMLImageElement>('img') ?? [])]
        .filter((image) => Boolean(image.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING))
      earlierImages.forEach((image) => { image.loading = 'eager' })
      Promise.allSettled(earlierImages.map((image) => image.decode())).then(positionTarget)
      window.document.fonts?.ready.then(positionTarget)
      settleTimer = window.setTimeout(positionTarget, 700)
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      if (settleTimer) window.clearTimeout(settleTimer)
      if (focusTimer) window.clearTimeout(focusTimer)
    }
  }, [document.id, initialSection])

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1221px)')
    const closeMobileOverlays = () => {
      if (!desktop.matches) return
      setRailOpen(false)
      setTocOpen(false)
    }
    closeMobileOverlays()
    desktop.addEventListener('change', closeMobileOverlays)
    return () => desktop.removeEventListener('change', closeMobileOverlays)
  }, [])

  useEffect(() => {
    if (!railOpen && !tocOpen) return
    const panel = window.document.querySelector<HTMLElement>(railOpen ? '#reader-rail' : '#mobile-toc')
    if (!panel) return
    overlayPreviousFocusRef.current = window.document.activeElement as HTMLElement | null
    const focusable = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')]
    focusable[0]?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        railOpen ? setRailOpen(false) : setTocOpen(false)
        return
      }
      if (event.key !== 'Tab' || !focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && window.document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && window.document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
      if (overlayPreviousFocusRef.current?.isConnected) overlayPreviousFocusRef.current.focus()
    }
  }, [railOpen, tocOpen])

  useEffect(() => {
    let scheduled = false
    let persistTimer: number | undefined
    let pending: { percent: number; section?: string } | undefined
    let persistedSection = activeRef.current
    const persist = (percent: number, section?: string, immediately = false) => {
      pending = { percent, section }
      if (persistTimer) window.clearTimeout(persistTimer)
      if (immediately) {
        onProgressRef.current(percent, section)
        pending = undefined
        persistedSection = section
        return
      }
      persistTimer = window.setTimeout(() => {
        if (pending) onProgressRef.current(pending.percent, pending.section)
        pending = undefined
      }, 160)
    }
    const update = () => {
      scheduled = false
      const article = articleRef.current
      if (!article) return
      const start = article.offsetTop
      const end = start + article.offsetHeight - window.innerHeight
      const nextProgress = end <= start ? 100 : Math.round(Math.min(100, Math.max(0, ((window.scrollY - start) / (end - start)) * 100)))
      setProgress(nextProgress)

      const candidates = [...article.querySelectorAll<HTMLElement>('h2[id], h3[id]')]
      let nextActive: string | undefined
      for (const heading of candidates) {
        if (heading.getBoundingClientRect().top <= 170) nextActive = heading.id
        else break
      }
      const sectionChanged = Boolean(nextActive && nextActive !== activeRef.current)
      if (sectionChanged && nextActive) {
        activeRef.current = nextActive
        setActive(nextActive)
        const url = documentHref(document, nextActive)
        window.history.replaceState(null, '', url)
      }
      persist(nextProgress, nextActive, sectionChanged || nextActive !== persistedSection)
    }
    const onScroll = () => {
      if (scheduled) return
      scheduled = true
      window.requestAnimationFrame(update)
    }
    const initialFrame = window.requestAnimationFrame(update)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      window.cancelAnimationFrame(initialFrame)
      if (persistTimer) window.clearTimeout(persistTimer)
      if (pending) onProgressRef.current(pending.percent, pending.section)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [document.id])

  const collection = document.kind === 'lecture' ? lectures : document.kind === 'topic' ? topics : labs
  const index = collection.findIndex((item) => item.id === document.id)
  const previous = collection[index - 1]
  const next = collection[index + 1]
  const typeLabel = document.kind === 'lecture' ? `第 ${document.number} 讲` : document.kind === 'topic' ? `主题 ${String(document.number).padStart(2, '0')}` : `MiniLab M${document.number}`

  return (
    <main id="main-content" className="reader-page">
      <div className="reading-progress" style={{ width: `${progress}%` }} role="progressbar" aria-label="本章阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} />
      <button className="rail-overlay" type="button" aria-label="关闭章节目录" data-visible={railOpen} onClick={() => setRailOpen(false)} />
      <LectureRail current={document} open={railOpen} onClose={() => setRailOpen(false)} />
      <article ref={articleRef} className="reader-article">
        <header className="article-header">
          <div className="article-breadcrumb"><a href="#/">首页</a><ChevronRight size={13} /><a href={document.kind === 'lecture' ? '#/lectures' : document.kind === 'topic' ? '#/topics' : '#/practice'}>{routeLabel({ view: 'document', kind: document.kind, number: document.number })}</a></div>
          <div className="article-kicker"><span>{typeLabel}</span><span>{document.phase}</span></div>
          <h1>{document.shortTitle}</h1>
          <p>{document.description}</p>
          <div className="article-meta"><span><Clock3 size={15} /> 约 {document.readingMinutes} 分钟</span><span><ListTree size={15} /> {headings.filter((heading) => heading.depth === 2).length} 个核心小节</span>{document.experimentCount > 0 && <span><FlaskConical size={15} /> {document.experimentCount} 个实践点</span>}</div>
        </header>
        <MarkdownView content={document} onHeadings={receiveHeadings} />
        <footer className="article-footer">
          <div className="completion-card">
            <div className={record?.completed ? 'completion-icon completed' : 'completion-icon'}>{record?.completed ? <CheckCircle2 size={24} /> : <Circle size={24} />}</div>
            <div><strong>{record?.completed ? '本章已完成' : '完成这一章了吗？'}</strong><p>完成状态由你确认，不会因为滚动到底自动勾选。</p></div>
            <button type="button" className={record?.completed ? 'button button-secondary' : 'button button-primary'} onClick={onComplete}>{record?.completed ? '取消完成' : '标记为完成'}</button>
          </div>
          <nav className="article-pagination" aria-label="前后章节">
            {previous ? <a href={documentHref(previous)}><ArrowLeft size={18} /><span><small>上一{document.kind === 'lecture' ? '讲' : '章'}</small><strong>{previous.shortTitle}</strong></span></a> : <span />}
            {next ? <a href={documentHref(next)}><span><small>下一{document.kind === 'lecture' ? '讲' : '章'}</small><strong>{next.shortTitle}</strong></span><ArrowRight size={18} /></a> : <span />}
          </nav>
        </footer>
      </article>
      <TableOfContents document={document} headings={headings} active={active} />
      <div className="mobile-reader-bar">
        <button type="button" onClick={() => { setTocOpen(false); setRailOpen(true) }} aria-expanded={railOpen} aria-controls="reader-rail" aria-haspopup="dialog"><Menu size={18} /><span>章节</span></button>
        <button type="button" onClick={() => { setRailOpen(false); setTocOpen(true) }} aria-expanded={tocOpen} aria-controls="mobile-toc" aria-haspopup="dialog"><ListTree size={18} /><span>本讲目录</span></button>
        {next ? <a href={documentHref(next)}><ArrowRight size={18} /><span>下一{document.kind === 'lecture' ? '讲' : '章'}</span></a> : <a href="#/"><Home size={18} /><span>首页</span></a>}
      </div>
      {tocOpen && <div className="toc-layer" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setTocOpen(false) }}><div><TableOfContents document={document} headings={headings} active={active} mobile onClose={() => setTocOpen(false)} /></div></div>}
    </main>
  )
}

function findSnippet(text: string, query: string): string {
  const compact = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`|\[\]()]/g, ' ').replace(/\s+/g, ' ').trim()
  const lower = compact.toLocaleLowerCase('zh-CN')
  const index = lower.indexOf(query)
  const start = Math.max(0, index >= 0 ? index - 42 : 0)
  const snippet = compact.slice(start, start + 150)
  return `${start > 0 ? '…' : ''}${snippet}${start + 150 < compact.length ? '…' : ''}`
}

function searchContent(query: string): SearchResult[] {
  const normalized = query.trim().toLocaleLowerCase('zh-CN')
  if (!normalized) return []
  const terms = normalized.split(/\s+/).filter(Boolean)
  const results: SearchResult[] = []

  for (const document of allDocuments) {
    if (!terms.every((term) => document.searchText.includes(term))) continue
    const title = document.title.toLocaleLowerCase('zh-CN')
    const matchingHeading = document.headings.find((heading) => terms.every((term) => heading.text.toLocaleLowerCase('zh-CN').includes(term)))
      ?? document.headings.find((heading) => terms.some((term) => heading.text.toLocaleLowerCase('zh-CN').includes(term)))
    let score = 20
    if (title === normalized) score += 200
    if (title.includes(normalized)) score += 100
    if (matchingHeading) score += matchingHeading.text.toLocaleLowerCase('zh-CN').includes(normalized) ? 75 : 35
    const kindLabel = document.kind === 'lecture' ? `第 ${document.number} 讲` : document.kind === 'topic' ? `主题 ${String(document.number).padStart(2, '0')}` : `MiniLab M${document.number}`
    results.push({
      id: document.id,
      kind: document.kind,
      eyebrow: matchingHeading ? `${kindLabel} › ${matchingHeading.text}` : kindLabel,
      title: document.shortTitle,
      context: findSnippet(document.raw, normalized),
      href: documentHref(document, matchingHeading?.id),
      score,
    })
  }

  for (const example of examples) {
    const haystack = `${example.filename}\n${example.description}\n${example.raw}`.toLocaleLowerCase('zh-CN')
    if (!terms.every((term) => haystack.includes(term))) continue
    results.push({
      id: `code-${example.id}`,
      kind: 'code',
      eyebrow: `代码示例 › ${example.filename}`,
      title: example.description,
      context: findSnippet(example.raw, normalized),
      href: `#/example/${encodeURIComponent(example.filename)}`,
      score: example.filename.toLocaleLowerCase('zh-CN').includes(normalized) ? 130 : 30,
    })
  }
  return results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title)).slice(0, 24)
}

function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const results = useMemo(() => searchContent(query), [query])
  useBodyScrollLock(open)

  useEffect(() => setActiveIndex(0), [query])

  useEffect(() => {
    if (!open || !results[activeIndex]) return
    window.document.getElementById(`search-result-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, results])

  useEffect(() => {
    if (!open) return
    previousFocus.current = window.document.activeElement as HTMLElement | null
    setQuery('')
    window.setTimeout(() => inputRef.current?.focus(), 0)
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key !== 'Tab' || !dialogRef.current) return
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('input, button:not([disabled]), a[href]')]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && window.document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && window.document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('keydown', handleKey)
      if (previousFocus.current?.isConnected) previousFocus.current.focus()
    }
  }, [open, onClose])

  if (!open) return null
  const suggestions = ['fork', 'pthread_mutex_lock', 'fsync', 'WAL', 'CUDA']
  return (
    <div className="search-layer" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section id="global-search" ref={dialogRef} className="search-dialog" role="dialog" aria-modal="true" aria-label="搜索全部教程">
        <div className="search-input-row"><Search size={21} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); setActiveIndex((index) => (index + 1) % results.length) }
          else if (event.key === 'ArrowUp' && results.length) { event.preventDefault(); setActiveIndex((index) => (index - 1 + results.length) % results.length) }
          else if (event.key === 'Enter' && results[activeIndex]) { window.location.hash = results[activeIndex].href.slice(1); onClose() }
        }} placeholder="搜索概念、API、实验或代码……" aria-label="搜索词" role="combobox" aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls={results.length > 0 ? 'search-results' : undefined} aria-activedescendant={results[activeIndex] ? `search-result-${activeIndex}` : undefined} /><button className="search-close" type="button" onClick={onClose} aria-label="关闭搜索"><X size={18} /></button></div>
        <div className="search-content">
          {!query.trim() ? (
            <div className="search-empty"><span className="eyebrow">TRY A QUERY</span><h2>跨 30 讲、17 章和全部代码搜索</h2><p>中文概念、英文 API 和代码符号都可以直接输入。</p><div className="suggestion-list">{suggestions.map((item) => <button key={item} type="button" onClick={() => setQuery(item)}>{item}</button>)}</div></div>
          ) : results.length ? (
            <div className="search-results"><div className="search-result-count" aria-live="polite">找到 {results.length} 个最相关结果</div><div id="search-results" className="search-result-list" role="listbox">{results.map((result, index) => <a id={`search-result-${index}`} role="option" aria-selected={index === activeIndex} className={index === activeIndex ? 'active' : ''} key={result.id} href={result.href} onPointerEnter={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)} onClick={onClose}><span className={`result-kind kind-${result.kind}`}>{result.kind === 'lecture' ? '讲' : result.kind === 'topic' ? '题' : result.kind === 'lab' ? '验' : '码'}</span><div><small>{result.eyebrow}</small><h3>{result.title}</h3><p>{result.context}</p></div><ChevronRight size={18} /></a>)}</div></div>
          ) : (
            <div className="no-results" role="status" aria-live="polite"><Search size={28} /><h2>没有找到“{query}”</h2><p>试试更短的概念、系统调用名，或去掉空格后重试。</p></div>
          )}
        </div>
        <div className="search-foot"><span><kbd>↵</kbd> 打开结果</span><span><kbd>Esc</kbd> 关闭</span><span>搜索范围：教程、标题、代码</span></div>
      </section>
    </div>
  )
}

function NotFoundPage() {
  return <main id="main-content" className="not-found section-shell"><span className="eyebrow">404 · INVALID STATE</span><h1>这个状态不存在。</h1><p>链接可能已经失效，回到课程地图重新选择一个学习入口。</p><a className="button button-primary" href="#/"><Home size={17} /> 回到首页</a></main>
}

export function App() {
  const [route, setRoute] = useState<Route>(parseRoute)
  const [searchOpen, setSearchOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [reading, setReading] = useState<ReadingState>(loadReadingState)
  const { mode, cycle } = useTheme()
  const openSearch = useCallback(() => setSearchOpen(true), [])
  const closeSearch = useCallback(() => setSearchOpen(false), [])
  const openMenu = useCallback(() => setMenuOpen(true), [])
  const closeMenu = useCallback(() => setMenuOpen(false), [])

  useEffect(() => {
    const update = () => {
      setRoute(parseRoute())
      setSearchOpen(false)
      setMenuOpen(false)
    }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  useEffect(() => {
    if (route.view === 'document' && findDocument(route.kind, route.number)) return
    scrollWindowTo(0)
    const title = route.view === 'lectures' ? '30 讲逐讲教程' : route.view === 'topics' ? '17 章主题教程' : route.view === 'practice' ? '实验与代码' : route.view === 'example' ? route.filename : route.view === 'not-found' || route.view === 'document' ? '页面未找到' : '系统实验手册'
    window.document.title = `${title} · OS/2026`
    const frame = window.requestAnimationFrame(() => {
      const main = window.document.getElementById('main-content')
      main?.setAttribute('tabindex', '-1')
      main?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [route])

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1221px)')
    const closeMobileMenu = () => { if (desktop.matches) setMenuOpen(false) }
    closeMobileMenu()
    desktop.addEventListener('change', closeMobileMenu)
    return () => desktop.removeEventListener('change', closeMobileMenu)
  }, [])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable
      if (window.document.documentElement.dataset.overlayOpen === 'true' || window.document.querySelector('[aria-modal="true"]')) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        openSearch()
      } else if (event.key === '/' && !editing) {
        event.preventDefault()
        openSearch()
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [openSearch])

  const writeReading = useCallback((id: string, update: Partial<ReadingRecord>, lastSection?: string) => {
    setReading((current) => {
      const previous = current.records[id] ?? { percent: 0, completed: false, updatedAt: 0 }
      const merged: ReadingRecord = {
        ...previous,
        ...update,
        lastSection: update.lastSection ?? previous.lastSection,
        updatedAt: Date.now(),
      }
      const nextLastVisited = `${id}:${lastSection ?? merged.lastSection ?? ''}`
      if (
        previous.percent === merged.percent
        && previous.completed === merged.completed
        && previous.lastSection === merged.lastSection
        && current.lastVisited === nextLastVisited
      ) return current
      const next: ReadingState = {
        records: { ...current.records, [id]: merged },
        lastVisited: nextLastVisited,
      }
      try {
        localStorage.setItem(READING_KEY, JSON.stringify(next))
      } catch {
        // Keep in-memory progress even if storage is blocked or full.
      }
      return next
    })
  }, [])

  let page: ReactNode
  if (route.view === 'home') page = <HomePage reading={reading} />
  else if (route.view === 'lectures') page = <CollectionPage kind="lecture" reading={reading} />
  else if (route.view === 'topics') page = <CollectionPage kind="topic" reading={reading} />
  else if (route.view === 'practice') page = <PracticePage reading={reading} />
  else if (route.view === 'document') {
    const document = findDocument(route.kind, route.number)
    if (!document) page = <NotFoundPage />
    else page = <ReaderPage document={document} initialSection={route.section} record={reading.records[document.id]} onProgress={(percent, section) => writeReading(document.id, { percent, lastSection: section }, section)} onComplete={() => writeReading(document.id, { completed: !reading.records[document.id]?.completed, percent: Math.max(reading.records[document.id]?.percent ?? 0, 1) }, reading.records[document.id]?.lastSection)} />
  } else if (route.view === 'example') {
    const example = examples.find((item) => item.filename === route.filename)
    page = example ? <ExamplePage example={example} /> : <NotFoundPage />
  } else page = <NotFoundPage />

  return (
    <>
      <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); const main = window.document.getElementById('main-content'); main?.setAttribute('tabindex', '-1'); main?.focus() }}>跳到正文</a>
      <AppHeader route={route} onSearch={openSearch} theme={mode} onTheme={cycle} onMenu={openMenu} menuOpen={menuOpen} searchOpen={searchOpen} />
      {page}
      <footer className="site-footer"><div><a className="brand footer-brand" href="#/"><span className="brand-mark">OS</span><span className="brand-copy"><strong>系统实验手册</strong><small>JYY · OS/2026</small></span></a><p>基于 JYY 原课程 PPT 整理的非官方学习教程；转载、修改和再分发请保留原作者署名，并遵守 CC BY-NC 4.0 非商业许可。</p></div><div className="footer-links"><a href="#/lectures">逐讲教程</a><a href="#/topics">主题教程</a><a href="#/practice">实验与代码</a><a href="https://jyywiki.cn/OS/2026/" target="_blank" rel="noreferrer">课程原站 <ExternalLink size={13} /></a><a href="https://creativecommons.org/licenses/by-nc/4.0/" target="_blank" rel="noreferrer">CC BY-NC 4.0 <ExternalLink size={13} /></a></div></footer>
      <MobileNavigation open={menuOpen} onClose={closeMenu} />
      <SearchDialog open={searchOpen} onClose={closeSearch} />
    </>
  )
}
