import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Circle,
  Clock3,
  Command,
  ExternalLink,
  GraduationCap,
  Home,
  Layers3,
  ListTree,
  Menu,
  Monitor,
  Moon,
  Search,
  Sun,
  X,
} from 'lucide-react'
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { MarkdownView } from './components/MarkdownView'
import { allDocuments, examples, labs, lectures, topics } from './content'
import {
  portalUrl,
  projectDocumentHref,
  projectUrl,
  tutorialProjectCatalog,
  type ProjectDocument,
  type ProjectTrack,
  type TutorialProject,
  type TutorialProjectCatalog,
} from './projects'
import { scrollElementIntoView, scrollWindowTo } from './scroll'
import type { HeadingItem, ReadingRecord, ReadingState } from './types'
import { useBodyScrollLock } from './useBodyScrollLock'

type ThemeMode = 'system' | 'light' | 'dark'

type ProjectRoute =
  | { view: 'home' }
  | { view: 'track'; trackId: string }
  | { view: 'document'; routeId: string; section?: string }
  | { view: 'not-found' }

interface PortalEntry {
  slug: string
  externalUrl?: string
  mark: string
  title: string
  subtitle: string
  description: string
  category: string
  level: string
  tags: string[]
  tone: string
  documentCount: number
  trackCount: number
  updatedAt: string
}

interface ProjectSearchResult {
  id: string
  eyebrow: string
  title: string
  context: string
  href: string
  score: number
}

const THEME_KEY = 'os26-theme'

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function parseProjectRoute(): ProjectRoute {
  const hash = window.location.hash.slice(1) || '/'
  const [pathname, query = ''] = hash.split('?', 2)
  const rawParts = pathname.split('/').filter(Boolean)
  const parts = rawParts.map(safeDecode)
  if (parts.some((part) => part === undefined)) return { view: 'not-found' }
  const decoded = parts as string[]
  const params = new URLSearchParams(query)

  if (decoded.length === 0) return { view: 'home' }
  if (decoded[0] === 'track' && decoded.length === 2) return { view: 'track', trackId: decoded[1] }
  if (decoded[0] === 'doc' && decoded.length === 2) {
    return {
      view: 'document',
      routeId: decoded[1],
      section: params.get('section') ?? undefined,
    }
  }
  return { view: 'not-found' }
}

function trackHref(trackId: string): string {
  return `#/track/${encodeURIComponent(trackId)}`
}

function readingKey(project: TutorialProject): string {
  return `project-reading:${project.slug}`
}

function loadReadingState(project: TutorialProject): ReadingState {
  try {
    const parsed = JSON.parse(localStorage.getItem(readingKey(project)) ?? '{}') as ReadingState
    return { records: parsed.records ?? {}, lastVisited: parsed.lastVisited }
  } catch {
    return { records: {} }
  }
}

function useSiteTheme() {
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
      window.document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      window.document.documentElement.dataset.themeMode = mode
      try {
        localStorage.setItem(THEME_KEY, mode)
      } catch {
        // Keep the selected theme for this tab when storage is unavailable.
      }
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [mode])

  const cycle = useCallback(() => {
    setMode((current) => current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system')
  }, [])
  return { mode, cycle }
}

function ThemeIcon({ mode }: { mode: ThemeMode }) {
  if (mode === 'light') return <Sun size={18} />
  if (mode === 'dark') return <Moon size={18} />
  return <Monitor size={18} />
}

function ThemeButton({ mode, onChange }: { mode: ThemeMode; onChange: () => void }) {
  const label = mode === 'system' ? '跟随系统' : mode === 'light' ? '浅色模式' : '深色模式'
  return (
    <button
      className="icon-button portal-theme-button"
      type="button"
      onClick={onChange}
      title={`${label}，点击切换`}
      aria-label={`${label}，点击切换主题`}
    >
      <ThemeIcon mode={mode} />
    </button>
  )
}

function focusMain() {
  const main = window.document.getElementById('main-content')
  main?.setAttribute('tabindex', '-1')
  main?.focus({ preventScroll: true })
}

function SkipLink() {
  return (
    <a
      className="skip-link"
      href="#main-content"
      onClick={(event) => {
        event.preventDefault()
        focusMain()
      }}
    >
      跳到正文
    </a>
  )
}

function useDialogFocus(
  open: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  onClose: () => void,
  initialFocusRef?: React.RefObject<HTMLElement | null>,
) {
  const previousFocus = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previousFocus.current = window.document.activeElement as HTMLElement | null
    const frame = window.requestAnimationFrame(() => {
      const container = containerRef.current
      const fallback = container?.querySelector<HTMLElement>('button:not([disabled]), input, a[href]')
      ;(initialFocusRef?.current ?? fallback)?.focus()
    })
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const container = containerRef.current
      if (!container) return
      const focusable = [...container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )]
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
      window.cancelAnimationFrame(frame)
      window.removeEventListener('keydown', handleKey)
      if (previousFocus.current?.isConnected) previousFocus.current.focus()
    }
  }, [containerRef, initialFocusRef, onClose, open])
}

function portalEntries(): PortalEntry[] {
  const osEntry: PortalEntry = {
    slug: 'os',
    mark: 'OS',
    title: '操作系统实验手册',
    subtitle: 'JYY · OS/2026',
    description: '从状态机出发，沿 30 讲课程、主题教程、MiniLab 与可运行代码读懂现代操作系统。',
    category: '计算机系统',
    level: '入门 → 进阶',
    tags: ['状态机', '并发', '持久化', '系统安全'],
    tone: 'teal',
    documentCount: allDocuments.length,
    trackCount: 3,
    updatedAt: '2026-07-23',
  }
  const rlhfBookEntry: PortalEntry = {
    slug: 'rlhf-book-zh',
    externalUrl: 'https://sdjasj.github.io/rlhf-book-zh/',
    mark: 'RLHF',
    title: 'RLHF 中文书',
    subtitle: 'Nathan Lambert · 非官方中文译本',
    description: '系统讲解指令微调、偏好数据、奖励模型、策略梯度、DPO、RLVR 与语言模型后训练。',
    category: 'AI 与训练系统',
    level: '入门 → 进阶',
    tags: ['RLHF', '奖励模型', 'DPO', 'RLVR'],
    tone: 'violet',
    documentCount: 20,
    trackCount: 1,
    updatedAt: '2026-07-28',
  }
  return [
    osEntry,
    rlhfBookEntry,
    ...tutorialProjectCatalog.map((project) => ({
      slug: project.slug,
      mark: project.mark,
      title: project.title,
      subtitle: project.subtitle,
      description: project.description,
      category: project.category,
      level: project.level,
      tags: project.tags,
      tone: project.tone,
      documentCount: project.documentCount,
      trackCount: project.tracks.length,
      updatedAt: project.updatedAt,
    })),
  ]
}

function PortalProjectCard({ entry }: { entry: PortalEntry }) {
  const external = Boolean(entry.externalUrl)
  return (
    <article className={`portal-project-card portal-tone-${entry.tone}`}>
      <a
        href={entry.externalUrl ?? projectUrl(entry.slug)}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer' : undefined}
        aria-label={external ? `阅读 ${entry.title}（在新标签页打开）` : `打开 ${entry.title} 教程`}
      >
        <div className="portal-card-topline">
          <span className="portal-project-mark" aria-hidden="true">{entry.mark}</span>
          <span className="portal-project-category">{entry.category}</span>
        </div>
        <div className="portal-card-copy">
          <span className="eyebrow">{entry.subtitle}</span>
          <h2>{entry.title}</h2>
          <p>{entry.description}</p>
        </div>
        <ul className="portal-tag-list" aria-label="主题标签">
          {entry.tags.map((tag) => <li key={tag}>{tag}</li>)}
        </ul>
        <div className="portal-card-meta">
          <span><BookOpen size={15} /> {entry.documentCount} 篇内容</span>
          <span><Layers3 size={15} /> {entry.trackCount} 条路线</span>
          <span>{entry.level}</span>
        </div>
        <span className="card-link">
          {external ? <>阅读中文书 <ExternalLink size={16} /></> : <>进入项目 <ArrowRight size={16} /></>}
        </span>
      </a>
    </article>
  )
}

export function ProjectPortal() {
  const entries = useMemo(portalEntries, [])
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部项目')
  const { mode, cycle } = useSiteTheme()
  const categories = useMemo(
    () => ['全部项目', ...new Set(entries.map((entry) => entry.category))],
    [entries],
  )
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    return entries.filter((entry) => {
      if (category !== '全部项目' && entry.category !== category) return false
      if (!normalized) return true
      return [entry.title, entry.subtitle, entry.description, entry.category, entry.level, ...entry.tags]
        .join('\n')
        .toLocaleLowerCase('zh-CN')
        .includes(normalized)
    })
  }, [category, entries, query])
  const totalDocuments = entries.reduce((sum, entry) => sum + entry.documentCount, 0)
  const totalTracks = entries.reduce((sum, entry) => sum + entry.trackCount, 0)

  useEffect(() => {
    window.document.title = '源码学习实验室 · 教程门户'
    scrollWindowTo(0)
  }, [])

  return (
    <>
      <SkipLink />
      <header className="portal-header">
        <div className="portal-header-inner section-shell">
          <a className="brand portal-brand" href={portalUrl()} aria-label="源码学习实验室首页">
            <span className="brand-mark">LAB</span>
            <span className="brand-copy"><strong>源码学习实验室</strong><small>SYSTEMS · AI · SECURITY</small></span>
          </a>
          <nav className="portal-header-nav" aria-label="门户导航">
            <a href="#projects">全部项目</a>
            <a href="#about">学习方式</a>
          </nav>
          <ThemeButton mode={mode} onChange={cycle} />
        </div>
      </header>
      <main id="main-content" className="portal-page">
        <section className="portal-hero section-shell" aria-labelledby="portal-title">
          <div className="portal-hero-copy">
            <span className="eyebrow">SOURCE-GUIDED LEARNING</span>
            <h1 id="portal-title">把复杂项目，<br />读成一条可验证的路线。</h1>
            <p>从操作系统、云端沙箱和分布式运行时，到 LLM 训练与智能体安全。每套教程都锚定真实源码、具体快照和可执行实验。</p>
            <a className="button button-primary" href="#projects">选择一个项目 <ArrowRight size={17} /></a>
          </div>
          <div className="portal-stats" aria-label="教程门户统计">
            <div><strong>{entries.length}</strong><span>个项目</span></div>
            <div><strong>{totalTracks}</strong><span>条学习路线</span></div>
            <div><strong>{totalDocuments}</strong><span>篇教程与实验</span></div>
            <div><strong>{examples.length}</strong><span>个 OS 代码示例</span></div>
          </div>
        </section>

        <section id="projects" className="portal-catalog section-shell" aria-labelledby="catalog-title">
          <div className="section-heading portal-section-heading">
            <div><span className="eyebrow">PROJECT CATALOG</span><h2 id="catalog-title">选择你的下一条学习路线</h2></div>
            <p>搜索项目、技术或概念，也可以按方向缩小范围。</p>
          </div>
          <div className="portal-filters" role="search">
            <label className="portal-search-field">
              <span className="sr-only">搜索项目</span>
              <Search size={18} aria-hidden="true" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目、技术或主题……" />
              {query && <button type="button" onClick={() => setQuery('')} aria-label="清空项目搜索"><X size={16} /></button>}
            </label>
            <label className="portal-category-field">
              <span>分类</span>
              <select value={category} onChange={(event) => setCategory(event.target.value)}>
                {categories.map((item) => <option key={item}>{item}</option>)}
              </select>
            </label>
          </div>
          <div className="portal-result-summary" role="status" aria-live="polite">
            显示 {filtered.length} / {entries.length} 个项目
          </div>
          {filtered.length ? (
            <div className="portal-project-grid">
              {filtered.map((entry) => <PortalProjectCard key={entry.slug} entry={entry} />)}
            </div>
          ) : (
            <div className="portal-empty-state">
              <Search size={28} />
              <h2>没有匹配的项目</h2>
              <p>试试更短的技术名，或切换到“全部项目”。</p>
              <button className="button button-secondary" type="button" onClick={() => { setQuery(''); setCategory('全部项目') }}>清除筛选</button>
            </div>
          )}
        </section>

        <section id="about" className="portal-method section-shell" aria-labelledby="method-title">
          <div><span className="eyebrow">HOW TO USE</span><h2 id="method-title">读、跑、改、测</h2></div>
          <ol>
            <li><strong>读</strong><span>先建立对象、状态与调用链地图。</span></li>
            <li><strong>跑</strong><span>用最小命令观察真实输入输出。</span></li>
            <li><strong>改</strong><span>做一个范围明确、容易撤销的实验。</span></li>
            <li><strong>测</strong><span>用断言、测试和数据验证理解。</span></li>
          </ol>
        </section>
      </main>
      <PortalFooter />
    </>
  )
}

function PortalFooter() {
  return (
    <footer className="site-footer portal-footer">
      <div>
        <a className="brand footer-brand" href={portalUrl()}>
          <span className="brand-mark">LAB</span>
          <span className="brand-copy"><strong>源码学习实验室</strong><small>READ · RUN · CHANGE · TEST</small></span>
        </a>
        <p>教程用于学习与研究；涉及安全、云资源和第三方内容时，请遵守项目许可与授权边界。</p>
      </div>
      <div className="footer-links"><a href="#projects">项目目录</a><a href="#about">学习方式</a></div>
    </footer>
  )
}

function ProjectHeader({
  project,
  route,
  theme,
  onTheme,
  onSearch,
  onMenu,
  menuOpen,
  searchOpen,
}: {
  project: TutorialProject
  route: ProjectRoute
  theme: ThemeMode
  onTheme: () => void
  onSearch: () => void
  onMenu: () => void
  menuOpen: boolean
  searchOpen: boolean
}) {
  const currentTrack = route.view === 'track'
    ? route.trackId
    : route.view === 'document'
      ? project.documents.find((item) => item.routeId === route.routeId)?.trackId
      : undefined
  return (
    <header className="app-header project-header">
      <div className="header-inner project-header-inner">
        <button
          className="icon-button mobile-menu-button"
          type="button"
          onClick={onMenu}
          aria-label="打开项目目录"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          aria-controls="project-navigation"
        ><Menu size={20} /></button>
        <a className="brand project-brand" href="#/" aria-label={`${project.title} 项目首页`}>
          <span className="brand-mark">{project.mark}</span>
          <span className="brand-copy"><strong>{project.title}</strong><small>{project.subtitle}</small></span>
        </a>
        <nav className="header-nav project-header-nav" aria-label="项目学习路线">
          <a className={route.view === 'home' ? 'active' : ''} aria-current={route.view === 'home' ? 'page' : undefined} href="#/">项目首页</a>
          {project.tracks.map((track) => (
            <a key={track.id} className={currentTrack === track.id ? 'active' : ''} aria-current={currentTrack === track.id ? 'page' : undefined} href={trackHref(track.id)}>{track.title}</a>
          ))}
        </nav>
        <div className="header-actions project-header-actions">
          <a className="project-portal-link" href={portalUrl()}><Layers3 size={16} /> <span>全部项目</span></a>
          <button className="search-trigger" type="button" onClick={onSearch} aria-label={`搜索 ${project.title} 教程`} aria-haspopup="dialog" aria-expanded={searchOpen} aria-controls="project-search">
            <Search size={17} /><span>项目内搜索</span><kbd><Command size={12} /> K</kbd>
          </button>
          <ThemeButton mode={theme} onChange={onTheme} />
        </div>
      </div>
    </header>
  )
}

function ProjectNavigationDrawer({ project, open, onClose }: {
  project: TutorialProject
  open: boolean
  onClose: () => void
}) {
  const panelRef = useRef<HTMLElement>(null)
  useBodyScrollLock(open)
  useDialogFocus(open, panelRef, onClose)
  if (!open) return null
  return (
    <div className="drawer-layer project-drawer-layer" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <aside id="project-navigation" ref={panelRef} className="mobile-drawer project-mobile-drawer" role="dialog" aria-modal="true" aria-label={`${project.title} 项目目录`}>
        <div className="drawer-head"><div><span className="eyebrow">PROJECT MAP</span><h2>{project.title}</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="关闭项目目录"><X size={20} /></button></div>
        <a className="drawer-primary-link" href={portalUrl()} onClick={onClose}><Layers3 size={18} />全部项目</a>
        <a className="drawer-primary-link" href="#/" onClick={onClose}><Home size={18} />项目首页</a>
        {project.tracks.map((track) => (
          <div className="project-drawer-track" key={track.id}>
            <a className="drawer-primary-link" href={trackHref(track.id)} onClick={onClose}><GraduationCap size={18} />{track.title}</a>
            <nav aria-label={`${track.title}章节`}>
              {track.documents.map((item) => <a key={item.id} href={projectDocumentHref(item)} onClick={onClose}><span>{item.displayNumber}</span>{item.shortTitle}</a>)}
            </nav>
          </div>
        ))}
      </aside>
    </div>
  )
}

function ProjectHomePage({ project, reading }: { project: TutorialProject; reading: ReadingState }) {
  const completed = project.documents.filter((item) => reading.records[item.id]?.completed).length
  const lastDocument = project.documents.find((item) => item.id === reading.lastVisited)
  const lastRecord = lastDocument ? reading.records[lastDocument.id] : undefined
  const totalMinutes = project.documents.reduce((sum, item) => sum + item.readingMinutes, 0)
  return (
    <main id="main-content" className={`project-home project-tone-${project.tone}`}>
      <section className="project-hero section-shell">
        <div className="project-hero-copy">
          <span className="eyebrow">{project.category} · {project.level}</span>
          <h1>{project.title}<br /><em>{project.subtitle}</em></h1>
          <p>{project.description}</p>
          {project.safetyNote && <div className="project-safety-note" role="note">{project.safetyNote}</div>}
          <div className="hero-actions">
            {lastDocument ? (
              <a className="button button-primary" href={projectDocumentHref(lastDocument, lastRecord?.lastSection)}>继续上次学习 <ArrowRight size={17} /></a>
            ) : project.documents[0] ? (
              <a className="button button-primary" href={projectDocumentHref(project.documents[0])}>从第一章开始 <ArrowRight size={17} /></a>
            ) : null}
            {project.tracks[0] && <a className="button button-secondary" href={trackHref(project.tracks[0].id)}><ListTree size={17} /> 浏览学习路线</a>}
          </div>
          <ul className="project-tag-list" aria-label="项目主题">
            {project.tags.map((tag) => <li key={tag}>{tag}</li>)}
          </ul>
        </div>
        <div className="project-hero-panel" aria-label="项目教程统计">
          <div className="project-snapshot"><small>CODE SNAPSHOT</small><strong>{project.snapshot}</strong><span>更新于 {project.updatedAt}</span></div>
          <div className="project-stat-grid">
            <div><strong>{project.documents.length}</strong><span>篇教程</span></div>
            <div><strong>{project.tracks.length}</strong><span>条路线</span></div>
            <div><strong>{totalMinutes}</strong><span>分钟阅读</span></div>
            <div><strong>{completed}</strong><span>篇已完成</span></div>
          </div>
          {project.repositoryUrl && <a className="text-link" href={project.repositoryUrl} target="_blank" rel="noreferrer">查看源码仓库 <ExternalLink size={14} /></a>}
        </div>
      </section>

      <section className="project-tracks section-shell" aria-labelledby="project-tracks-title">
        <div className="section-heading"><div><span className="eyebrow">LEARNING TRACKS</span><h2 id="project-tracks-title">沿一条主线深入</h2></div><p>每条路线都有稳定顺序；阅读记录只保存在当前浏览器。</p></div>
        <div className="project-track-grid">
          {project.tracks.map((track, index) => {
            const trackCompleted = track.documents.filter((item) => reading.records[item.id]?.completed).length
            return (
              <article className="project-track-card" key={track.id}>
                <div className="project-track-index">{String(index + 1).padStart(2, '0')}</div>
                <span className="eyebrow">{track.eyebrow}</span>
                <h3>{track.title}</h3>
                <p>{track.description}</p>
                <div className="project-track-progress"><span style={{ width: `${track.documents.length ? (trackCompleted / track.documents.length) * 100 : 0}%` }} /><small>{trackCompleted} / {track.documents.length} 已完成</small></div>
                <a className="card-link" href={trackHref(track.id)}>查看路线 <ArrowRight size={16} /></a>
              </article>
            )
          })}
        </div>
      </section>
    </main>
  )
}

function ProjectTrackPage({ project, track, reading }: {
  project: TutorialProject
  track: ProjectTrack
  reading: ReadingState
}) {
  const completed = track.documents.filter((item) => reading.records[item.id]?.completed).length
  return (
    <main id="main-content" className="collection-page project-track-page section-shell">
      <div className="article-breadcrumb"><a href="#/">项目首页</a><ChevronRight size={13} /><span>{track.title}</span></div>
      <section className="page-intro project-track-intro">
        <span className="eyebrow">{track.eyebrow}</span>
        <h1>{track.title}</h1>
        <p>{track.description}</p>
        <div className="project-track-summary"><span><BookOpen size={16} /> {track.documents.length} 篇教程</span><span><CheckCircle2 size={16} /> {completed} 篇已完成</span></div>
      </section>
      <section className="document-list project-document-list" aria-label={`${track.title}章节`}>
        {track.documents.map((item) => {
          const record = reading.records[item.id]
          return (
            <a className="document-card project-document-card" href={projectDocumentHref(item, record?.lastSection)} key={item.id}>
              <span className="document-card-number">{item.displayNumber}</span>
              <div><span className="eyebrow">{item.phase}</span><h2>{item.shortTitle}</h2><p>{item.description}</p><div className="document-card-meta"><span><Clock3 size={14} /> {item.readingMinutes} 分钟</span><span><ListTree size={14} /> {item.headings.filter((heading) => heading.depth === 2).length} 节</span></div></div>
              <div className="document-card-state">{record?.completed ? <><CheckCircle2 size={18} /> 已完成</> : record?.percent ? `${record.percent}%` : <ChevronRight size={18} />}</div>
            </a>
          )
        })}
      </section>
      <div className="project-track-actions"><a className="button button-secondary" href="#/"><ArrowLeft size={16} /> 返回 {project.title} 首页</a></div>
    </main>
  )
}

function ProjectChapterRail({ project, current, open, onClose }: {
  project: TutorialProject
  current: ProjectDocument
  open: boolean
  onClose: () => void
}) {
  return (
    <aside id="project-reader-rail" className={`reader-rail project-reader-rail ${open ? 'rail-open' : ''}`} aria-label="项目章节" role={open ? 'dialog' : undefined} aria-modal={open || undefined}>
      <div className="rail-head"><span className="eyebrow">PROJECT CHAPTERS</span><button type="button" className="icon-button rail-close" onClick={onClose} aria-label="关闭章节目录"><X size={19} /></button></div>
      <div className="project-rail-home"><a href="#/" onClick={onClose}><Home size={16} /> {project.title} 首页</a></div>
      {project.tracks.map((track) => (
        <div className="project-rail-group" key={track.id}>
          <a className="project-rail-track" href={trackHref(track.id)} onClick={onClose}>{track.title}<ChevronRight size={14} /></a>
          <nav aria-label={track.title}>
            {track.documents.map((item) => (
              <a key={item.id} href={projectDocumentHref(item)} className={item.id === current.id ? 'active' : ''} aria-current={item.id === current.id ? 'page' : undefined} onClick={onClose} title={item.shortTitle}>
                <span>{item.displayNumber}</span><div><strong>{item.shortTitle}</strong><small>{track.eyebrow}</small></div>
              </a>
            ))}
          </nav>
        </div>
      ))}
    </aside>
  )
}

function ProjectTableOfContents({ project, tutorialDocument, headings, active, mobile, onClose }: {
  project: TutorialProject
  tutorialDocument: ProjectDocument
  headings: HeadingItem[]
  active?: string
  mobile?: boolean
  onClose?: () => void
}) {
  const activeHeading = headings.find((heading) => heading.id === active)
  const activeParent = activeHeading?.depth === 2 ? activeHeading.id : activeHeading?.parentId
  const visible = headings.filter((heading) => heading.depth === 2 || (heading.depth === 3 && heading.parentId === activeParent))
  return (
    <aside id={mobile ? 'project-mobile-toc' : undefined} className={mobile ? 'toc-sheet project-toc-sheet' : 'reader-toc project-reader-toc'} aria-label="本页目录" role={mobile ? 'dialog' : undefined} aria-modal={mobile || undefined}>
      <div className="toc-head"><span className="eyebrow">ON THIS PAGE</span>{mobile && <button className="icon-button" type="button" onClick={onClose} aria-label="关闭本页目录"><X size={19} /></button>}</div>
      <nav>
        {visible.map((heading) => (
          <a key={heading.id} className={`${heading.depth === 3 ? 'toc-h3' : ''} ${active === heading.id ? 'active' : ''}`} aria-current={active === heading.id ? 'location' : undefined} href={projectDocumentHref(tutorialDocument, heading.id)} onClick={onClose}>
            <span />{heading.text}
          </a>
        ))}
      </nav>
      {project.repositoryUrl && <div className="toc-source"><ExternalLink size={14} /><a href={project.repositoryUrl} target="_blank" rel="noreferrer">浏览上游源码仓库</a></div>}
    </aside>
  )
}

function ProjectReader({
  project,
  tutorialDocument,
  initialSection,
  record,
  onProgress,
  onComplete,
}: {
  project: TutorialProject
  tutorialDocument: ProjectDocument
  initialSection?: string
  record?: ReadingRecord
  onProgress: (percent: number, section?: string) => void
  onComplete: () => void
}) {
  const resumeSectionRef = useRef(initialSection ?? record?.lastSection)
  const [headings, setHeadings] = useState<HeadingItem[]>(tutorialDocument.headings.filter((heading) => heading.depth >= 2))
  const [active, setActive] = useState<string | undefined>(resumeSectionRef.current)
  const [progress, setProgress] = useState(record?.percent ?? 0)
  const [railOpen, setRailOpen] = useState(false)
  const [tocOpen, setTocOpen] = useState(false)
  const articleRef = useRef<HTMLElement>(null)
  const activeRef = useRef(active)
  const onProgressRef = useRef(onProgress)
  const handledLocationRef = useRef<string | undefined>(undefined)
  const overlayPreviousFocusRef = useRef<HTMLElement | null>(null)
  useBodyScrollLock(railOpen || tocOpen)

  useEffect(() => { activeRef.current = active }, [active])
  useEffect(() => { onProgressRef.current = onProgress }, [onProgress])
  useEffect(() => {
    if (initialSection) {
      resumeSectionRef.current = initialSection
      setActive(initialSection)
      handledLocationRef.current = undefined
    }
  }, [initialSection])
  const receiveHeadings = useCallback((items: HeadingItem[]) => setHeadings(items), [])

  useEffect(() => {
    window.document.title = `${tutorialDocument.shortTitle} · ${project.title}`
    const section = initialSection ?? resumeSectionRef.current
    const locationKey = `${tutorialDocument.id}:${section ?? '__top__'}`
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
    const position = () => {
      if (cancelled) return
      const target = window.document.getElementById(section)
      if (!target) return
      handledLocationRef.current = locationKey
      scrollElementIntoView(target)
      window.setTimeout(() => { if (!cancelled) target.focus({ preventScroll: true }) }, 40)
    }
    const frame = window.requestAnimationFrame(() => {
      position()
      settleTimer = window.setTimeout(position, 450)
      window.document.fonts?.ready.then(position)
    })
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frame)
      if (settleTimer) window.clearTimeout(settleTimer)
    }
  }, [headings.length, initialSection, project.title, tutorialDocument.id, tutorialDocument.shortTitle])

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1221px)')
    const closeOverlays = () => {
      if (!desktop.matches) return
      setRailOpen(false)
      setTocOpen(false)
    }
    closeOverlays()
    desktop.addEventListener('change', closeOverlays)
    return () => desktop.removeEventListener('change', closeOverlays)
  }, [])

  useEffect(() => {
    if (!railOpen && !tocOpen) return
    const panel = window.document.querySelector<HTMLElement>(railOpen ? '#project-reader-rail' : '#project-mobile-toc')
    if (!panel) return
    overlayPreviousFocusRef.current = window.document.activeElement as HTMLElement | null
    const focusable = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')]
    focusable[0]?.focus()
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
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
    const persist = (percent: number, section?: string, immediate = false) => {
      pending = { percent, section }
      if (persistTimer) window.clearTimeout(persistTimer)
      if (immediate) {
        onProgressRef.current(percent, section)
        pending = undefined
        return
      }
      persistTimer = window.setTimeout(() => {
        if (pending) onProgressRef.current(pending.percent, pending.section)
        pending = undefined
      }, 180)
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
      const changed = Boolean(nextActive && nextActive !== activeRef.current)
      if (changed && nextActive) {
        activeRef.current = nextActive
        setActive(nextActive)
        window.history.replaceState(null, '', projectDocumentHref(tutorialDocument, nextActive))
      }
      persist(nextProgress, nextActive, changed)
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
  }, [tutorialDocument.id])

  const index = project.documents.findIndex((item) => item.id === tutorialDocument.id)
  const previous = project.documents[index - 1]
  const next = project.documents[index + 1]
  const track = project.tracks.find((item) => item.id === tutorialDocument.trackId)

  return (
    <main id="main-content" className="reader-page project-reader-page">
      <div className="reading-progress" style={{ width: `${progress}%` }} role="progressbar" aria-label="本章阅读进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress} />
      <button className="rail-overlay" type="button" aria-label="关闭章节目录" data-visible={railOpen} onClick={() => setRailOpen(false)} />
      <ProjectChapterRail project={project} current={tutorialDocument} open={railOpen} onClose={() => setRailOpen(false)} />
      <article ref={articleRef} className="reader-article project-reader-article">
        <header className="article-header">
          <div className="article-breadcrumb"><a href="#/">项目首页</a><ChevronRight size={13} />{track ? <a href={trackHref(track.id)}>{track.title}</a> : <span>教程</span>}</div>
          <div className="article-kicker"><span>{tutorialDocument.displayNumber}</span><span>{track?.eyebrow ?? tutorialDocument.phase}</span></div>
          <h1>{tutorialDocument.shortTitle}</h1>
          <p>{tutorialDocument.description}</p>
          <div className="article-meta"><span><Clock3 size={15} /> 约 {tutorialDocument.readingMinutes} 分钟</span><span><ListTree size={15} /> {headings.filter((heading) => heading.depth === 2).length} 个核心小节</span>{tutorialDocument.experimentCount > 0 && <span><GraduationCap size={15} /> {tutorialDocument.experimentCount} 个实践点</span>}</div>
        </header>
        <MarkdownView content={tutorialDocument} onHeadings={receiveHeadings} />
        <footer className="article-footer">
          <div className="completion-card">
            <div className={record?.completed ? 'completion-icon completed' : 'completion-icon'}>{record?.completed ? <CheckCircle2 size={24} /> : <Circle size={24} />}</div>
            <div><strong>{record?.completed ? '本章已完成' : '完成这一章了吗？'}</strong><p>完成状态由你确认，并只保存在当前浏览器。</p></div>
            <button type="button" className={record?.completed ? 'button button-secondary' : 'button button-primary'} onClick={onComplete}>{record?.completed ? '取消完成' : '标记为完成'}</button>
          </div>
          <nav className="article-pagination" aria-label="前后章节">
            {previous ? <a href={projectDocumentHref(previous)}><ArrowLeft size={18} /><span><small>上一章</small><strong>{previous.shortTitle}</strong></span></a> : <span />}
            {next ? <a href={projectDocumentHref(next)}><span><small>下一章</small><strong>{next.shortTitle}</strong></span><ArrowRight size={18} /></a> : <span />}
          </nav>
        </footer>
      </article>
      <ProjectTableOfContents project={project} tutorialDocument={tutorialDocument} headings={headings} active={active} />
      <div className="mobile-reader-bar project-mobile-reader-bar">
        <button type="button" onClick={() => { setTocOpen(false); setRailOpen(true) }} aria-expanded={railOpen} aria-controls="project-reader-rail" aria-haspopup="dialog"><Menu size={18} /><span>章节</span></button>
        <button type="button" onClick={() => { setRailOpen(false); setTocOpen(true) }} aria-expanded={tocOpen} aria-controls="project-mobile-toc" aria-haspopup="dialog"><ListTree size={18} /><span>本页目录</span></button>
        {next ? <a href={projectDocumentHref(next)}><ArrowRight size={18} /><span>下一章</span></a> : <a href="#/"><Home size={18} /><span>项目首页</span></a>}
      </div>
      {tocOpen && <div className="toc-layer project-toc-layer" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setTocOpen(false) }}><div><ProjectTableOfContents project={project} tutorialDocument={tutorialDocument} headings={headings} active={active} mobile onClose={() => setTocOpen(false)} /></div></div>}
    </main>
  )
}

function findSnippet(text: string, query: string): string {
  const compact = text.replace(/```[\s\S]*?```/g, ' ').replace(/[#>*_`|\[\]()]/g, ' ').replace(/\s+/g, ' ').trim()
  const lower = compact.toLocaleLowerCase('zh-CN')
  const index = lower.indexOf(query)
  const start = Math.max(0, index >= 0 ? index - 42 : 0)
  const snippet = compact.slice(start, start + 160)
  return `${start > 0 ? '…' : ''}${snippet}${start + 160 < compact.length ? '…' : ''}`
}

function searchProject(project: TutorialProject, query: string): ProjectSearchResult[] {
  const normalized = query.trim().toLocaleLowerCase('zh-CN')
  if (!normalized) return []
  const terms = normalized.split(/\s+/).filter(Boolean)
  return project.documents
    .flatMap((item): ProjectSearchResult[] => {
      if (!terms.every((term) => item.searchText.includes(term))) return []
      const title = item.title.toLocaleLowerCase('zh-CN')
      const heading = item.headings.find((candidate) => terms.every((term) => candidate.text.toLocaleLowerCase('zh-CN').includes(term)))
        ?? item.headings.find((candidate) => terms.some((term) => candidate.text.toLocaleLowerCase('zh-CN').includes(term)))
      let score = 20
      if (title === normalized) score += 200
      else if (title.includes(normalized)) score += 100
      if (heading) score += heading.text.toLocaleLowerCase('zh-CN').includes(normalized) ? 75 : 35
      const track = project.tracks.find((candidate) => candidate.id === item.trackId)
      return [{
        id: item.id,
        eyebrow: heading ? `${track?.title ?? item.phase} › ${heading.text}` : track?.title ?? item.phase,
        title: item.shortTitle,
        context: findSnippet(item.raw, normalized),
        href: projectDocumentHref(item, heading?.id),
        score,
      }]
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'))
    .slice(0, 30)
}

function ProjectSearchDialog({ project, open, onClose }: {
  project: TutorialProject
  open: boolean
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const results = useMemo(() => searchProject(project, query), [project, query])
  useBodyScrollLock(open)
  useDialogFocus(open, dialogRef, onClose, inputRef)

  useEffect(() => { if (open) { setQuery(''); setActiveIndex(0) } }, [open])
  useEffect(() => { setActiveIndex(0) }, [query])
  useEffect(() => {
    if (!open || !results[activeIndex]) return
    window.document.getElementById(`project-search-result-${activeIndex}`)?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, results])

  if (!open) return null
  const suggestions = project.tags.slice(0, 5)
  return (
    <div className="search-layer project-search-layer" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section id="project-search" ref={dialogRef} className="search-dialog project-search-dialog" role="dialog" aria-modal="true" aria-label={`搜索 ${project.title} 教程`}>
        <div className="search-input-row"><Search size={21} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); setActiveIndex((index) => (index + 1) % results.length) }
          else if (event.key === 'ArrowUp' && results.length) { event.preventDefault(); setActiveIndex((index) => (index - 1 + results.length) % results.length) }
          else if (event.key === 'Enter' && results[activeIndex]) { window.location.hash = results[activeIndex].href.slice(1); onClose() }
        }} placeholder={`搜索 ${project.title} 的概念、API 或实验……`} aria-label="搜索词" role="combobox" aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls={results.length ? 'project-search-results' : undefined} aria-activedescendant={results[activeIndex] ? `project-search-result-${activeIndex}` : undefined} /><button className="search-close" type="button" onClick={onClose} aria-label="关闭搜索"><X size={18} /></button></div>
        <div className="search-content">
          {!query.trim() ? (
            <div className="search-empty"><span className="eyebrow">SEARCH THIS PROJECT</span><h2>跨 {project.documents.length} 篇教程全文搜索</h2><p>可以输入中文概念、英文 API、类名或函数名。</p><div className="suggestion-list">{suggestions.map((item) => <button key={item} type="button" onClick={() => setQuery(item)}>{item}</button>)}</div></div>
          ) : results.length ? (
            <div className="search-results"><div className="search-result-count" aria-live="polite">找到 {results.length} 个最相关结果</div><div id="project-search-results" className="search-result-list" role="listbox">{results.map((result, index) => <a id={`project-search-result-${index}`} role="option" aria-selected={index === activeIndex} className={index === activeIndex ? 'active' : ''} key={result.id} href={result.href} onPointerEnter={() => setActiveIndex(index)} onFocus={() => setActiveIndex(index)} onClick={onClose}><span className="result-kind kind-topic">文</span><div><small>{result.eyebrow}</small><h3>{result.title}</h3><p>{result.context}</p></div><ChevronRight size={18} /></a>)}</div></div>
          ) : (
            <div className="no-results" role="status" aria-live="polite"><Search size={28} /><h2>没有找到“{query}”</h2><p>试试更短的概念、API 名或去掉空格。</p></div>
          )}
        </div>
        <div className="search-foot"><span><kbd>↵</kbd> 打开结果</span><span><kbd>Esc</kbd> 关闭</span><span>范围：当前项目全部教程</span></div>
      </section>
    </div>
  )
}

function ProjectNotFoundPage({ project }: { project: TutorialProject }) {
  return (
    <main id="main-content" className="not-found project-not-found section-shell">
      <span className="eyebrow">404 · UNKNOWN PROJECT STATE</span>
      <h1>这个项目页面不存在。</h1>
      <p>链接可能已经失效。回到 {project.title} 首页，重新选择一条学习路线。</p>
      <div className="hero-actions"><a className="button button-primary" href="#/"><Home size={17} /> 回到项目首页</a><a className="button button-secondary" href={portalUrl()}><Layers3 size={17} /> 全部项目</a></div>
    </main>
  )
}

function ProjectFooter({ project }: { project: TutorialProject }) {
  return (
    <footer className="site-footer project-footer">
      <div><a className="brand footer-brand" href="#/"><span className="brand-mark">{project.mark}</span><span className="brand-copy"><strong>{project.title}</strong><small>{project.subtitle}</small></span></a><p>教程基于源码快照 {project.snapshot} 整理；实践时请遵守项目许可证、资源成本与授权边界。</p></div>
      <div className="footer-links"><a href={portalUrl()}>全部项目</a>{project.tracks.map((track) => <a key={track.id} href={trackHref(track.id)}>{track.title}</a>)}{project.repositoryUrl && <a href={project.repositoryUrl} target="_blank" rel="noreferrer">源码仓库 <ExternalLink size={13} /></a>}</div>
    </footer>
  )
}

export function ProjectTutorialApp({ project }: { project: TutorialProject }) {
  const [route, setRoute] = useState<ProjectRoute>(parseProjectRoute)
  const [searchOpen, setSearchOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [reading, setReading] = useState<ReadingState>(() => loadReadingState(project))
  const { mode, cycle } = useSiteTheme()
  const openSearch = useCallback(() => setSearchOpen(true), [])
  const closeSearch = useCallback(() => setSearchOpen(false), [])
  const openMenu = useCallback(() => setMenuOpen(true), [])
  const closeMenu = useCallback(() => setMenuOpen(false), [])

  useEffect(() => {
    setReading(loadReadingState(project))
  }, [project])

  useEffect(() => {
    const update = () => {
      setRoute(parseProjectRoute())
      setSearchOpen(false)
      setMenuOpen(false)
    }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  useEffect(() => {
    if (route.view === 'document') return
    scrollWindowTo(0)
    const title = route.view === 'track'
      ? project.tracks.find((track) => track.id === route.trackId)?.title ?? '页面未找到'
      : route.view === 'not-found' ? '页面未找到' : project.subtitle
    window.document.title = `${title} · ${project.title}`
    const frame = window.requestAnimationFrame(focusMain)
    return () => window.cancelAnimationFrame(frame)
  }, [project, route])

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1221px)')
    const closeDesktopDrawer = () => { if (desktop.matches) setMenuOpen(false) }
    closeDesktopDrawer()
    desktop.addEventListener('change', closeDesktopDrawer)
    return () => desktop.removeEventListener('change', closeDesktopDrawer)
  }, [])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
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
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [openSearch])

  const writeReading = useCallback((id: string, update: Partial<ReadingRecord>) => {
    setReading((current) => {
      const previous = current.records[id] ?? { percent: 0, completed: false, updatedAt: 0 }
      const merged: ReadingRecord = { ...previous, ...update, lastSection: update.lastSection ?? previous.lastSection, updatedAt: Date.now() }
      if (previous.percent === merged.percent && previous.completed === merged.completed && previous.lastSection === merged.lastSection && current.lastVisited === id) return current
      const next: ReadingState = { records: { ...current.records, [id]: merged }, lastVisited: id }
      try {
        localStorage.setItem(readingKey(project), JSON.stringify(next))
      } catch {
        // Preserve in-memory progress when storage is blocked or full.
      }
      return next
    })
  }, [project])

  let page: ReactNode
  if (route.view === 'home') {
    page = <ProjectHomePage project={project} reading={reading} />
  } else if (route.view === 'track') {
    const track = project.tracks.find((item) => item.id === route.trackId)
    page = track ? <ProjectTrackPage project={project} track={track} reading={reading} /> : <ProjectNotFoundPage project={project} />
  } else if (route.view === 'document') {
    const tutorialDocument = project.documents.find((item) => item.routeId === route.routeId)
    page = tutorialDocument ? (
      <ProjectReader
        key={tutorialDocument.id}
        project={project}
        tutorialDocument={tutorialDocument}
        initialSection={route.section}
        record={reading.records[tutorialDocument.id]}
        onProgress={(percent, section) => writeReading(tutorialDocument.id, { percent, lastSection: section })}
        onComplete={() => writeReading(tutorialDocument.id, {
          completed: !reading.records[tutorialDocument.id]?.completed,
          percent: Math.max(reading.records[tutorialDocument.id]?.percent ?? 0, 1),
        })}
      />
    ) : <ProjectNotFoundPage project={project} />
  } else {
    page = <ProjectNotFoundPage project={project} />
  }

  return (
    <>
      <SkipLink />
      <ProjectHeader project={project} route={route} theme={mode} onTheme={cycle} onSearch={openSearch} onMenu={openMenu} menuOpen={menuOpen} searchOpen={searchOpen} />
      {page}
      <ProjectFooter project={project} />
      <ProjectNavigationDrawer project={project} open={menuOpen} onClose={closeMenu} />
      <ProjectSearchDialog project={project} open={searchOpen} onClose={closeSearch} />
    </>
  )
}

export function ProjectLoadingPage({ project, error = false, onRetry }: {
  project: TutorialProjectCatalog
  error?: boolean
  onRetry?: () => void
}) {
  const { mode, cycle } = useSiteTheme()
  useEffect(() => {
    window.document.title = `${error ? '加载失败' : '正在加载'} · ${project.title}`
  }, [error, project.title])
  return (
    <>
      <SkipLink />
      <header className="portal-header project-loading-header">
        <div className="portal-header-inner section-shell">
          <a className="brand project-brand" href={portalUrl()} aria-label="返回全部项目">
            <span className="brand-mark">{project.mark}</span>
            <span className="brand-copy"><strong>{project.title}</strong><small>{project.subtitle}</small></span>
          </a>
          <ThemeButton mode={mode} onChange={cycle} />
        </div>
      </header>
      <main id="main-content" className="project-loading-page section-shell">
        <div className="project-loading-card" role={error ? 'alert' : 'status'} aria-live={error ? 'assertive' : 'polite'} aria-busy={!error}>
          {!error && <span className="project-loading-spinner" aria-hidden="true" />}
          <span className="eyebrow">{error ? 'LOAD FAILED' : 'LOADING PROJECT'}</span>
          <h1>{error ? '教程内容加载失败。' : `正在打开 ${project.title}`}</h1>
          <p>{error ? '网络连接可能中断，或教程资源暂时不可用。' : `正在按需载入 ${project.documentCount} 篇教程；门户没有预下载这些正文。`}</p>
          <div className="hero-actions">
            {error && onRetry && <button className="button button-primary" type="button" onClick={onRetry}>重新加载</button>}
            <a className="button button-secondary" href={portalUrl()}><Layers3 size={17} /> 返回项目门户</a>
          </div>
        </div>
      </main>
    </>
  )
}

export function UnknownProjectPage({ slug }: { slug?: string } = {}) {
  const { mode, cycle } = useSiteTheme()
  useEffect(() => {
    window.document.title = '项目未找到 · 源码学习实验室'
    scrollWindowTo(0)
  }, [])
  return (
    <>
      <SkipLink />
      <header className="portal-header unknown-project-header"><div className="portal-header-inner section-shell"><a className="brand portal-brand" href={portalUrl()}><span className="brand-mark">LAB</span><span className="brand-copy"><strong>源码学习实验室</strong><small>PROJECT NOT FOUND</small></span></a><ThemeButton mode={mode} onChange={cycle} /></div></header>
      <main id="main-content" className="not-found unknown-project-page section-shell">
        <span className="eyebrow">404 · UNKNOWN PROJECT</span>
        <h1>没有找到这个项目。</h1>
        <p>{slug ? `“${slug}” 不在当前教程目录中。` : '当前地址没有对应的教程项目。'} 返回门户查看全部可用项目。</p>
        <a className="button button-primary" href={portalUrl()}><Layers3 size={17} /> 返回项目门户</a>
      </main>
      <PortalFooter />
    </>
  )
}
