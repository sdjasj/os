import { slugifyHeading } from './content'
import type { ContentDocument, HeadingItem } from './types'

const projectMarkdownFiles = import.meta.glob('../../projects/*/**/*.md', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>

export type ProjectTone = 'teal' | 'blue' | 'violet' | 'amber' | 'rose' | 'slate'

export interface ProjectDocument extends ContentDocument {
  projectSlug: string
  routeId: string
  trackId: string
  displayNumber: string
  repositoryUrl?: string
  repositoryRef?: string
}

export interface ProjectTrack {
  id: string
  eyebrow: string
  title: string
  description: string
  documents: ProjectDocument[]
}

export interface RepositoryRoot {
  pathPrefix: string
  url: string
  ref: string
}

export interface TutorialProject {
  slug: string
  mark: string
  title: string
  subtitle: string
  description: string
  category: string
  level: string
  tags: string[]
  tone: ProjectTone
  updatedAt: string
  snapshot: string
  repositoryUrl?: string
  repositoryRef?: string
  repositoryRoots?: RepositoryRoot[]
  safetyNote?: string
  tracks: ProjectTrack[]
  documents: ProjectDocument[]
}

export interface ProjectTrackCatalog {
  id: string
  eyebrow: string
  title: string
  description: string
  documentCount: number
}

export interface TutorialProjectCatalog extends Omit<TutorialProject, 'tracks' | 'documents'> {
  tracks: ProjectTrackCatalog[]
  documentCount: number
}

interface TrackSeed {
  id: string
  eyebrow: string
  title: string
  description: string
  copiedDirectory: string
  originalDirectory: string
  originalPath?: (relativePath: string) => string
  include: (relativePath: string) => boolean
  order?: (relativePath: string) => number
  routeName?: (relativePath: string) => string
}

interface ProjectSeed extends Omit<TutorialProject, 'tracks' | 'documents'> {
  tracks: TrackSeed[]
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim()
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
    const trimmed = line.trim()
    if (inFence || !trimmed || /^(#|>|[-*+] |\d+\. |\|)/.test(trimmed)) continue
    if (trimmed.length < 26) continue
    paragraphs.push(cleanInlineMarkdown(trimmed))
    if (paragraphs.join(' ').length > 150) break
  }
  return paragraphs.join(' ').slice(0, 180) || '沿真实源码与可运行实验建立项目的完整心智模型。'
}

function estimateReadingMinutes(raw: string): number {
  const prose = raw.replace(/```[\s\S]*?```/g, ' ')
  const chinese = (prose.match(/[\p{Script=Han}]/gu) ?? []).length
  const words = (prose.match(/[A-Za-z][A-Za-z0-9_+-]*/g) ?? []).length
  return Math.max(5, Math.round(chinese / 520 + words / 230))
}

function numericPrefix(path: string): number {
  const filename = path.split('/').pop() ?? path
  const match = /^(\d{2})[-_]/.exec(filename)
  return match ? Number(match[1]) : 10_000
}

function routeStem(path: string): string {
  return (path.split('/').pop() ?? path)
    .replace(/\.md$/i, '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLocaleLowerCase() || 'chapter'
}

function makeDocument(
  project: ProjectSeed,
  track: TrackSeed,
  copiedPath: string,
  relativePath: string,
  raw: string,
  index: number,
): ProjectDocument {
  const filename = relativePath.split('/').pop() ?? relativePath
  const title = cleanInlineMarkdown(raw.match(/^#\s+(.+)$/m)?.[1] ?? filename)
  const shortTitle = title
    .replace(/^第\s*\d+\s*[章节讲]?\s*[：:]?\s*/, '')
    .replace(/^\d+[.·、\s:：-]+/, '')
    .trim()
  const headings = extractHeadings(raw)
  const routeName = track.routeName?.(relativePath) ?? routeStem(relativePath)
  const routeId = `${track.id}--${routeName}`
  const repoPath = (track.originalPath?.(relativePath) ?? `${track.originalDirectory}${relativePath}`).replace(/^\/+/, '')

  return {
    id: `project:${project.slug}:${routeId}`,
    kind: 'topic',
    number: index + 1,
    title,
    shortTitle,
    filename,
    repoPath,
    raw,
    description: extractDescription(raw),
    headings,
    readingMinutes: estimateReadingMinutes(raw),
    experimentCount: headings.filter(({ text }) => /实验|实践|练习|lab|exercise|demo/i.test(text)).length,
    phase: track.title,
    phaseKey: track.id,
    searchText: `${title}\n${headings.map((heading) => heading.text).join('\n')}\n${raw}`.toLocaleLowerCase('zh-CN'),
    projectSlug: project.slug,
    routeId,
    trackId: track.id,
    displayNumber: String(index + 1).padStart(2, '0'),
    repositoryUrl: project.repositoryUrl,
    repositoryRef: project.repositoryRef,
  }
}

const projectSeeds: ProjectSeed[] = [
  {
    slug: 'cubesandbox',
    mark: 'CS',
    title: 'CubeSandbox',
    subtitle: '云原生沙箱源码学习',
    description: '从一次 Sandbox 创建请求出发，贯通控制面、Cubelet、MicroVM、网络、快照、SDK 与运维控制台。',
    category: '系统与云原生',
    level: '中级 → 进阶',
    tags: ['MicroVM', 'KVM', 'eBPF', '容器运行时'],
    tone: 'teal',
    updatedAt: '2026-07-22',
    snapshot: '07c95b9',
    repositoryUrl: 'https://github.com/TencentCloud/CubeSandbox',
    repositoryRef: '07c95b9',
    tracks: [{
      id: 'source', eyebrow: 'SOURCE WALKTHROUGH', title: '源码学习主线',
      description: '沿真实请求链逐层理解平台架构，并在每章完成动手练习与自测。',
      copiedDirectory: 'cubesandbox/guide/', originalDirectory: 'docs/learning-guide/',
      include: (path) => /^\d{2}-.+\.md$/.test(path),
    }],
  },
  {
    slug: 'e2b',
    mark: 'E2B',
    title: 'E2B',
    subtitle: '云端代码沙箱 SDK 源码导读',
    description: '从 Sandbox 生命周期到命令流、PTY、文件、Volume、Template 和跨语言 SDK，读懂 E2B 的完整实现边界。',
    category: '系统与云原生',
    level: '入门 → 进阶',
    tags: ['Sandbox', 'SDK', 'OpenAPI', 'PTY'],
    tone: 'blue',
    updatedAt: '2026-07-22',
    snapshot: 'be1ffa19f',
    repositoryUrl: 'https://github.com/e2b-dev/E2B',
    repositoryRef: 'be1ffa19f',
    tracks: [{
      id: 'source', eyebrow: 'SDK INTERNALS', title: '源码与实验主线',
      description: '先建立项目全景，再沿公开 API 追踪协议、实现、测试和代码生成。',
      copiedDirectory: 'e2b/guide/', originalDirectory: 'docs/zh-cn/',
      include: (path) => path === 'PROJECT_OVERVIEW.md' || /^tutorial\/\d{2}-.+\.md$/.test(path),
      order: (path) => path === 'PROJECT_OVERVIEW.md' ? -1 : numericPrefix(path),
    }],
  },
  {
    slug: 'minimind',
    mark: 'MM',
    title: 'MiniMind',
    subtitle: '从 Transformer 到 Agentic RL',
    description: '用一套小而完整的语言模型代码，串起 Tokenizer、Transformer、训练、偏好优化、推理服务和多轮工具强化学习。',
    category: 'AI 与训练系统',
    level: '入门 → 进阶',
    tags: ['Transformer', 'LLM', 'GRPO', 'Agentic RL'],
    tone: 'violet',
    updatedAt: '2026-07-21',
    snapshot: '512eed0',
    repositoryUrl: 'https://github.com/jingyaogong/minimind',
    repositoryRef: '512eed0',
    tracks: [
      {
        id: 'main', eyebrow: 'MODEL TO TRAINING', title: '语言模型主线',
        description: '从必要数学与 PyTorch 基础开始，逐步走到训练工程、后训练、推理和排错。',
        copiedDirectory: 'minimind/main/', originalDirectory: 'tutorial/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
        order: (path) => {
          const value = numericPrefix(path)
          if (value <= 5) return value
          if (value === 12) return 5.5
          return value + 1
        },
      },
      {
        id: 'agentic-rl', eyebrow: 'DEEP DIVE', title: 'Agentic RL 专题',
        description: '逐 token 拆解多轮工具轨迹、奖励、Mask、GRPO/CISPO 与 SGLang rollout。',
        copiedDirectory: 'minimind/agentic-rl/', originalDirectory: 'tutorial/agentic-rl/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
      },
    ],
  },
  {
    slug: 'ray',
    mark: 'RAY',
    title: 'Ray',
    subtitle: '分布式计算：先会用，再读源码',
    description: '两条互补路线覆盖 Ray Core、Data、Train、Tune、Serve、RLlib、集群运维以及 Python/C++ 运行时调用链。',
    category: '分布式系统',
    level: '入门 → 进阶',
    tags: ['Tasks', 'Actors', 'Object Store', 'ML Platform'],
    tone: 'blue',
    updatedAt: '2026-07-20',
    snapshot: '6623e6b1e7',
    repositoryUrl: 'https://github.com/ray-project/ray',
    repositoryRef: '6623e6b1e7',
    tracks: [
      {
        id: 'usage', eyebrow: 'START HERE', title: '使用与功能教程',
        description: '从本机最小例子出发，学会为数据、训练、调参、服务和强化学习选择正确组件。',
        copiedDirectory: 'ray/usage/', originalDirectory: 'ray_usage_guide/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
      },
      {
        id: 'source', eyebrow: 'INTERNALS', title: '源码学习教程',
        description: '沿远程任务、对象、Actor、调度和容错链路理解 Ray 为什么这样工作。',
        copiedDirectory: 'ray/source/', originalDirectory: 'ray_learning_tutorial/',
        include: (path) => /^\d{2}_.+\.md$/.test(path) || path === 'glossary.md',
        order: (path) => path === 'glossary.md' ? 100 : numericPrefix(path),
      },
    ],
  },
  {
    slug: 'strix',
    mark: 'SX',
    title: 'Strix',
    subtitle: '安全智能体源码学习',
    description: '沿一次获授权扫描的数据流，理解 CLI、模型配置、Agent、工具、沙箱、多 Agent 会话、报告与 Web Viewer。',
    category: 'AI 与安全',
    level: '中级 → 进阶',
    tags: ['Agent', 'Sandbox', 'SARIF', 'Security'],
    tone: 'rose',
    updatedAt: '2026-07-22',
    snapshot: '48b4821',
    repositoryUrl: 'https://github.com/usestrix/strix',
    repositoryRef: '48b4821',
    safetyNote: '双用途安全内容：只在你拥有或明确获准测试的目标上实践。',
    tracks: [{
      id: 'source', eyebrow: 'AUTHORIZED SECURITY', title: '源码学习主线',
      description: '先用快速概览建立地图，再按一次扫描的真实状态与数据流深入。',
      copiedDirectory: 'strix/guide/', originalDirectory: 'docs/',
      include: (path) => path === 'PROJECT_OVERVIEW_ZH.md' || /^\d{2}-.+\.md$/.test(path),
      order: (path) => path === 'PROJECT_OVERVIEW_ZH.md' ? -1 : numericPrefix(path),
      originalPath: (path) => path === 'PROJECT_OVERVIEW_ZH.md' ? `docs/${path}` : `docs/learning-guide/${path}`,
    }],
  },
  {
    slug: 'arvo',
    mark: 'AV',
    title: 'ARVO',
    subtitle: '漏洞数据构造与 E2E 基准解读',
    description: '结合论文、源码、数据库与实测结果，理解可复现漏洞数据怎样构造，以及 CyberGym-E2E 如何把它转成智能体任务。',
    category: '研究与安全',
    level: '进阶',
    tags: ['OSS-Fuzz', 'Dataset', 'CyberGym', 'Reproducibility'],
    tone: 'amber',
    updatedAt: '2026-07-22',
    snapshot: 'multi-repository study',
    repositoryUrl: 'https://github.com/n132/arvo',
    repositoryRef: 'master',
    repositoryRoots: [
      { pathPrefix: 'arvo-upstream/', url: 'https://github.com/n132/arvo', ref: 'bceb742e4a8e563f0d53ea2e000496d85291168c' },
      { pathPrefix: 'arvo-meta-upstream/', url: 'https://github.com/n132/ARVO-Meta', ref: '588baee081fce79267d5b3df20a5aeb055869635' },
      { pathPrefix: 'arvo-meta/', url: 'https://github.com/n132/ARVO-Meta', ref: '588baee081fce79267d5b3df20a5aeb055869635' },
      { pathPrefix: 'arvo-evaluation/', url: 'https://github.com/sefcom/ARVO', ref: 'c213f61599ce5f384c1305edbcf0658758b7f1d6' },
      { pathPrefix: 'cybergym-e2e-upstream/', url: 'https://github.com/sunblaze-ucb/cybergym-e2e', ref: 'b861317f11641b14ab6ba08b5179d0b044601057' },
    ],
    safetyNote: '内容涉及真实漏洞与补丁，只在隔离、获授权的研究环境中验证。',
    tracks: [{
      id: 'research', eyebrow: 'PAPER TO DATA', title: '论文与数据构造',
      description: '先理解 ARVO 的复现流水线，再看端到端漏洞修复基准如何从中演化。',
      copiedDirectory: 'arvo/guide/', originalDirectory: 'docs/',
      include: (path) => path.endsWith('.md'),
      order: (path) => path.startsWith('ARVO_') ? 0 : 1,
      routeName: (path) => path.startsWith('ARVO_') ? 'arvo-paper-and-dataset' : 'cybergym-e2e',
    }],
  },
  {
    slug: 'mini-swe-agent',
    mark: 'SWE',
    title: 'mini-SWE-agent',
    subtitle: '极简软件工程智能体导读',
    description: '用一份紧凑指南理解 Agent 循环、配置、工具、输出、调试、批量评测和 Python 扩展方式。',
    category: 'AI Agent',
    level: '入门 → 中级',
    tags: ['Coding Agent', 'SWE-bench', 'Tools', 'Evaluation'],
    tone: 'slate',
    updatedAt: '2026-07-22',
    snapshot: '38c01a19',
    repositoryUrl: 'https://github.com/SWE-agent/mini-swe-agent',
    repositoryRef: '38c01a19',
    tracks: [{
      id: 'guide', eyebrow: 'QUICK DEEP DIVE', title: '项目学习指南',
      description: '在一篇长文中完成从快速开始到内部循环、扩展与评测的全景学习。',
      copiedDirectory: 'mini-swe-agent/guide/', originalDirectory: '',
      include: (path) => path === 'PROJECT_GUIDE_ZH.md',
      routeName: () => 'project-guide',
    }],
  },
  {
    slug: 'openhands',
    mark: 'OH',
    title: 'OpenHands',
    subtitle: '自动化软件工程智能体源码学习',
    description: '沿用户消息的真实链路，贯通 App Server、SDK 边界、Sandbox、事件流、React 前端、密钥安全与 Enterprise 扩展。',
    category: 'AI Agent',
    level: '入门 → 进阶',
    tags: ['Coding Agent', 'FastAPI', 'Sandbox', 'React'],
    tone: 'amber',
    updatedAt: '2026-07-24',
    snapshot: '6b04532',
    repositoryUrl: 'https://github.com/OpenHands/OpenHands',
    repositoryRef: '6b04532541bf2b757d4820d31387b6cba6ffcaea',
    tracks: [{
      id: 'source', eyebrow: 'SOURCE WALKTHROUGH', title: '源码与实践主线',
      description: '先补齐 Coding Agent 背景，再沿创建会话、实时事件和安全边界读通前后端，最后完成端到端练习。',
      copiedDirectory: 'openhands/guide/', originalDirectory: '',
      include: (path) => /^\d{2}-.+\.md$/.test(path),
      originalPath: (path) => ({
        '00-learning-roadmap.md': 'Development.md',
        '01-coding-agent-foundations.md': 'frontend/src/utils/handle-event-for-ui.ts',
        '02-repository-architecture.md': 'README.md',
        '03-backend-bootstrap-and-di.md': 'openhands/app_server/config.py',
        '04-conversation-lifecycle.md': 'openhands/app_server/app_conversation/app_conversation_router.py',
        '05-agent-server-and-sdk-boundary.md': 'pyproject.toml',
        '06-events-streaming-and-state.md': 'openhands/app_server/event/event_service.py',
        '07-sandbox-runtime-and-security.md': 'openhands/app_server/sandbox/sandbox_service.py',
        '08-frontend-architecture.md': 'frontend/src/entry.client.tsx',
        '09-realtime-chat-dataflow.md': 'frontend/src/contexts/conversation-websocket-context.tsx',
        '10-settings-secrets-and-auth.md': 'openhands/app_server/settings/settings_models.py',
        '11-enterprise-extension.md': 'enterprise/saas_server.py',
        '12-testing-and-debugging.md': 'tests/unit/app_server/test_sandbox_service.py',
        '13-build-an-end-to-end-feature.md': 'frontend/src/hooks/query/use-settings.ts',
        '14-capstone-and-glossary.md': 'README.md',
      } as Record<string, string>)[path] ?? 'README.md',
    }],
  },
  {
    slug: 'codex',
    mark: 'CX',
    title: 'Codex',
    subtitle: '从终端入口到 Agent 运行时',
    description: '沿一次 Turn 的真实链路，贯通 CLI、TUI、app-server、Responses API、工具、沙箱、上下文、持久化与多 Agent。',
    category: 'AI Agent',
    level: '入门 → 进阶',
    tags: ['Rust', 'Coding Agent', 'JSON-RPC', 'Sandbox'],
    tone: 'teal',
    updatedAt: '2026-07-26',
    snapshot: '61a4488',
    repositoryUrl: 'https://github.com/openai/codex',
    repositoryRef: '61a44880a85d2fd0d8770908dea5733495e571c8',
    tracks: [{
      id: 'source', eyebrow: 'SOURCE WALKTHROUGH', title: '源码与系统主线',
      description: '先补齐 Rust、异步与 Agent 背景，再沿入口、运行时、工具和持久化链路完成源码实验。',
      copiedDirectory: 'codex/guide/', originalDirectory: '',
      include: (path) => /^\d{2}-.+\.md$/.test(path),
      originalPath: (path) => ({
        '00-learning-roadmap.md': 'README.md',
        '01-rust-async-agent-foundations.md': 'codex-rs/core/src/client_common.rs',
        '02-workspace-and-crate-map.md': 'codex-rs/Cargo.toml',
        '03-cli-bootstrap-and-dispatch.md': 'codex-rs/cli/src/main.rs',
        '04-tui-event-loop.md': 'codex-rs/tui/src/app.rs',
        '05-app-server-jsonrpc.md': 'codex-rs/app-server/README.md',
        '06-core-session-protocol.md': 'codex-rs/core/src/session/mod.rs',
        '07-responses-turn-loop.md': 'codex-rs/core/src/session/turn.rs',
        '08-tool-routing-dispatch.md': 'codex-rs/core/src/tools/router.rs',
        '09-shell-apply-patch-unified-exec.md': 'codex-rs/core/src/tools/runtimes/shell.rs',
        '10-config-approval-sandbox.md': 'codex-rs/core/src/tools/orchestrator.rs',
        '11-mcp-apps-extensions.md': 'codex-rs/codex-mcp/src/connection_manager.rs',
        '12-agents-skills-plugins-hooks.md': 'codex-rs/core/src/agents_md.rs',
        '13-context-history-compaction.md': 'codex-rs/core/src/context_manager/history.rs',
        '14-rollout-resume-fork.md': 'codex-rs/rollout/src/recorder.rs',
        '15-multi-agent-and-goals.md': 'codex-rs/core/src/agent/control.rs',
        '16-exec-sdk-programmatic.md': 'codex-rs/exec/src/lib.rs',
        '17-testing-debugging-observability.md': 'codex-rs/core/tests/suite/web_search.rs',
        '18-feature-workshop-and-glossary.md': 'AGENTS.md',
      } as Record<string, string>)[path] ?? 'README.md',
    }],
  },
  {
    slug: 'openclaw',
    mark: 'OC',
    title: 'OpenClaw',
    subtitle: '多渠道 AI Agent 平台源码学习',
    description: '从 CLI 与 Gateway 启动出发，沿消息链路、Agent 工具循环、会话上下文、插件 SDK、Telegram 与 SQLite 建立完整心智模型。',
    category: 'AI Agent',
    level: '入门 → 进阶',
    tags: ['Agent Runtime', 'Gateway', 'Plugin SDK', 'Channels'],
    tone: 'teal',
    updatedAt: '2026-07-26',
    snapshot: 'fc3476b',
    repositoryUrl: 'https://github.com/openclaw/openclaw',
    repositoryRef: 'fc3476b116b982d96e94cc86e3daf0f080c84ada',
    tracks: [{
      id: 'source', eyebrow: 'SOURCE WALKTHROUGH', title: '源码与实践主线',
      description: '先补齐 TypeScript、Node.js 与协议背景，再沿真实源码读通启动、消息、Agent、插件、频道和状态，最后完成递进式实验。',
      copiedDirectory: 'openclaw/guide/', originalDirectory: 'docs/internal/openclaw-code-study/',
      include: (path) => /^\d{2}-.+\.md$/.test(path),
    }],
  },
  {
    slug: 'hands-on-modern-rl',
    mark: 'RL',
    title: 'Hands-On Modern RL',
    subtitle: '从经典控制到 LLM 与 Agentic RL',
    description: '沿可运行实验贯通 MDP、DQN、策略梯度、PPO、RLHF、DPO、GRPO/RLVR，以及 Agentic 与 VLM 强化学习。',
    category: 'AI 与训练系统',
    level: '入门 → 进阶',
    tags: ['Reinforcement Learning', 'PPO', 'LLM Alignment', 'Agentic RL'],
    tone: 'violet',
    updatedAt: '2026-07-26',
    snapshot: '7c0372d',
    repositoryUrl: 'https://github.com/walkinglabs/hands-on-modern-rl',
    repositoryRef: '7c0372d4806c0dc478df46ed522ab64e58dda1d6',
    tracks: [{
      id: 'guide', eyebrow: 'PRACTICE TO FRONTIER', title: '代码驱动学习主线',
      description: '从经典控制的最小实验出发，逐步走到语言模型对齐、多轮智能体与多模态强化学习。',
      copiedDirectory: 'hands-on-modern-rl/guide/', originalDirectory: '',
      include: (path) => /^\d{2}-.+\.md$/.test(path),
      originalPath: (path) => ({
        '00-learning-roadmap.md': 'README.md',
        '01-foundations-and-environment.md': 'code/README.md',
        '02-bandits-and-exploration.md': 'code/chapter03_mdp/two_armed_bandit.py',
        '03-mdp-bellman-q-learning.md': 'code/chapter03_mdp/gridworld_q_learning.py',
        '04-dqn-from-table-to-network.md': 'code/chapter04_dqn/dqn_cartpole.py',
        '05-policy-gradient-reinforce.md': 'code/chapter05_policy_gradient/reinforce_cartpole.py',
        '06-actor-critic-continuous-control.md': 'code/chapter05_policy_gradient/actor_critic_cartpole.py',
        '07-ppo-gae-clipping.md': 'code/chapter07_ppo/ppo_from_scratch.py',
        '08-rlhf-pipeline.md': 'code/chapter08_rlhf/rlhf_ppo_train.py',
        '09-dpo-preference-optimization.md': 'code/chapter09_alignment/dpo_hands_on.py',
        '10-grpo-rlvr.md': 'code/chapter09_grpo_rlvr/grpo_math_reasoning.py',
        '11-agentic-rl-credit-assignment.md': 'code/chapter10_agentic_rl/multi_turn_rl.py',
        '12-vlm-marl-search.md': 'code/chapter11_vlm_rl/vlm_grpo_train.py',
        '13-debugging-capstone.md': 'code/appendix_common_pitfalls/debug_training_collapse.py',
      } as Record<string, string>)[path] ?? 'README.md',
    }],
  },
  {
    slug: 'pwn-college',
    mark: 'PWN',
    title: 'pwn.college 中文教程（非官方）',
    subtitle: '从 Linux 基础到系统与软件利用',
    description: '按官方主学习路径建立终端、汇编、网络、密码、程序安全、系统安全与软件利用的完整原理框架。',
    category: '系统与安全',
    level: '入门 → 进阶',
    tags: ['Linux', 'x86-64', 'Binary Security', 'Kernel'],
    tone: 'rose',
    updatedAt: '2026-07-26',
    snapshot: '25334e8',
    repositoryUrl: 'https://github.com/pwncollege/challenges',
    repositoryRef: '25334e88d440fc1a45c1f445c88eda7ea00865f2',
    repositoryRoots: [{
      pathPrefix: 'projects/pwn-college/',
      url: 'https://github.com/sdjasj/os',
      ref: 'e543c397957abed3be810a3a31fc5f321fbdb29a',
    }],
    safetyNote: '双用途安全内容：仅在自有、隔离或明确授权的环境中学习；教程不含挑战答案，也不得用于未授权测试。',
    tracks: [
      {
        id: 'start', eyebrow: 'START HERE', title: '平台与学习边界',
        description: '先建立学习路线、社区协作方式、授权边界与安全实验习惯。',
        copiedDirectory: 'pwn-college/docs/00-start-here/',
        originalDirectory: 'projects/pwn-college/docs/00-start-here/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
      },
      {
        id: 'linux', eyebrow: 'FOUNDATIONS', title: 'Linux Luminarium',
        description: '系统掌握 Shell、路径、管道、变量、权限、进程、脚本与终端。',
        copiedDirectory: 'pwn-college/docs/01-linux-luminarium/',
        originalDirectory: 'projects/pwn-college/docs/01-linux-luminarium/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
      },
      {
        id: 'computing', eyebrow: 'COMPUTING 101', title: '计算机底层基础',
        description: '沿 x86-64、内存、栈、系统调用、调试与 socket 建立机器模型。',
        copiedDirectory: 'pwn-college/docs/02-computing-101/',
        originalDirectory: 'projects/pwn-college/docs/02-computing-101/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
      },
      {
        id: 'programs', eyebrow: 'PROGRAM INTERACTION', title: 'Playing With Programs',
        description: '学习编码、HTTP、程序能力边界和 SQL 数据流。',
        copiedDirectory: 'pwn-college/docs/03-playing-with-programs/',
        originalDirectory: 'projects/pwn-college/docs/03-playing-with-programs/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
      },
      {
        id: 'intro-security', eyebrow: 'SECURITY FOUNDATIONS', title: '网络安全导论',
        description: '把 Web、网络、密码、访问控制、逆向和二进制安全连接起来。',
        copiedDirectory: 'pwn-college/docs/04-intro-to-cybersecurity/',
        originalDirectory: 'projects/pwn-college/docs/04-intro-to-cybersecurity/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
      },
      {
        id: 'program-security', eyebrow: 'AUTHORIZED SECURITY', title: '程序安全',
        description: '用内存不变量、逆向、ROP 与分配器生命周期分析程序风险。',
        copiedDirectory: 'pwn-college/docs/05-program-security/',
        originalDirectory: 'projects/pwn-college/docs/05-program-security/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
      },
      {
        id: 'system-security', eyebrow: 'AUTHORIZED SECURITY', title: '系统安全',
        description: '理解沙箱、竞态、内核、微体系结构与跨层系统防御。',
        copiedDirectory: 'pwn-college/docs/06-system-security/',
        originalDirectory: 'projects/pwn-college/docs/06-system-security/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
      },
      {
        id: 'software-exploitation', eyebrow: 'DEFENSIVE ANALYSIS', title: '软件利用原理',
        description: '从格式串、FILE、利用原语、堆与内核对象理解约束和缓解。',
        copiedDirectory: 'pwn-college/docs/07-software-exploitation/',
        originalDirectory: 'projects/pwn-college/docs/07-software-exploitation/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
      },
      {
        id: 'community', eyebrow: 'FURTHER LEARNING', title: 'Community Material',
        description: '按方向浏览社区 dojo，并在主线之后选择 ARM、密码、Fuzzing 等专题。',
        copiedDirectory: 'pwn-college/docs/90-community/',
        originalDirectory: 'projects/pwn-college/docs/90-community/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
      },
      {
        id: 'reference', eyebrow: 'REFERENCE', title: '参考附录',
        description: '随时查阅 Linux、编码、系统调用、GDB、pwntools、实验环境和术语。',
        copiedDirectory: 'pwn-college/docs/99-appendices/',
        originalDirectory: 'projects/pwn-college/docs/99-appendices/',
        include: (path) => /^\d{2}-.+\.md$/.test(path),
      },
    ],
  },
]

interface SelectedProjectFile {
  copiedPath: string
  relativePath: string
  load: () => Promise<string>
}

function selectedFilesForTrack(track: TrackSeed): SelectedProjectFile[] {
  const copiedPrefix = `../../projects/${track.copiedDirectory}`
  return Object.entries(projectMarkdownFiles)
    .filter(([path]) => path.startsWith(copiedPrefix))
    .map(([path, load]) => ({
      copiedPath: path,
      relativePath: path.slice(copiedPrefix.length),
      load,
    }))
    .filter(({ relativePath }) => track.include(relativePath))
    .sort((a, b) => {
      const orderA = track.order?.(a.relativePath) ?? numericPrefix(a.relativePath)
      const orderB = track.order?.(b.relativePath) ?? numericPrefix(b.relativePath)
      return orderA - orderB || a.relativePath.localeCompare(b.relativePath)
    })
}

function buildCatalog(seed: ProjectSeed): TutorialProjectCatalog {
  const tracks = seed.tracks.map((track) => ({
    id: track.id,
    eyebrow: track.eyebrow,
    title: track.title,
    description: track.description,
    documentCount: selectedFilesForTrack(track).length,
  }))
  return {
    ...seed,
    tracks,
    documentCount: tracks.reduce((sum, track) => sum + track.documentCount, 0),
  }
}

async function buildProject(seed: ProjectSeed): Promise<TutorialProject> {
  let documentIndex = 0
  const preparedTracks = seed.tracks.map((track) => ({
    track,
    files: selectedFilesForTrack(track).map((file) => ({ ...file, index: documentIndex++ })),
  }))
  const tracks = await Promise.all(preparedTracks.map(async ({ track, files }) => {
    const documents = await Promise.all(files.map(async ({ copiedPath, relativePath, load, index }) => {
      const raw = await load()
      return makeDocument(seed, track, copiedPath, relativePath, raw, index)
    }))
    return { id: track.id, eyebrow: track.eyebrow, title: track.title, description: track.description, documents }
  }))

  return {
    ...seed,
    tracks,
    documents: tracks.flatMap((track) => track.documents),
  }
}

export const tutorialProjectCatalog = projectSeeds.map(buildCatalog)

export function hasTutorialProject(slug: string): boolean {
  return projectSeeds.some((project) => project.slug === slug)
}

export function findTutorialProjectCatalog(slug: string): TutorialProjectCatalog | undefined {
  return tutorialProjectCatalog.find((project) => project.slug === slug)
}

const loadedProjects = new Map<string, TutorialProject>()
const projectLoadCache = new Map<string, Promise<TutorialProject>>()

/** Returns a project only after loadTutorialProject() has resolved for its slug. */
export function findTutorialProject(slug: string): TutorialProject | undefined {
  return loadedProjects.get(slug)
}

export function loadTutorialProject(slug: string): Promise<TutorialProject> {
  const loaded = loadedProjects.get(slug)
  if (loaded) return Promise.resolve(loaded)
  const cached = projectLoadCache.get(slug)
  if (cached) return cached
  const seed = projectSeeds.find((project) => project.slug === slug)
  if (!seed) return Promise.reject(new Error(`Unknown tutorial project: ${slug}`))

  const pending = buildProject(seed)
    .then((project) => {
      loadedProjects.set(slug, project)
      return project
    })
    .catch((error: unknown) => {
      projectLoadCache.delete(slug)
      throw error
    })
  projectLoadCache.set(slug, pending)
  return pending
}

export function projectDocumentHref(document: ProjectDocument, section?: string): string {
  const base = `#/doc/${encodeURIComponent(document.routeId)}`
  return section ? `${base}?section=${encodeURIComponent(section)}` : base
}

export function findProjectDocument(projectSlug: string, routeId: string): ProjectDocument | undefined {
  return findTutorialProject(projectSlug)?.documents.find((document) => document.routeId === routeId)
}

export function findProjectDocumentByRepoPath(projectSlug: string, repoPath: string): ProjectDocument | undefined {
  const normalized = repoPath.replace(/^\/+/, '')
  return findTutorialProject(projectSlug)?.documents.find((document) => document.repoPath === normalized)
}

export function projectTrackHrefForReadme(projectSlug: string, repoPath: string): string | undefined {
  if (!/README\.md$/i.test(repoPath)) return undefined
  const directory = repoPath.replace(/README\.md$/i, '')
  const track = findTutorialProject(projectSlug)?.tracks.find(({ documents }) =>
    documents.some((document) => document.repoPath.startsWith(directory)),
  )
  return track ? `#/track/${encodeURIComponent(track.id)}` : undefined
}

export function sourceUrlForRepoPath(projectSlug: string, repoPath: string): string | undefined {
  const project = findTutorialProject(projectSlug) ?? findTutorialProjectCatalog(projectSlug)
  if (!project) return undefined
  const normalized = repoPath.replace(/^\/+/, '')
  if (projectSlug === 'arvo' && /^cybergym-e2e-paper\.(?:pdf|txt)$/i.test(normalized)) {
    return 'https://arxiv.org/abs/2606.04460'
  }
  if (projectSlug === 'arvo' && normalized === 'arvo-meta-v3.0.0.db') {
    return 'https://github.com/n132/ARVO-Meta/releases/tag/v3.0.0'
  }
  const repositoryRoot = project.repositoryRoots?.find(({ pathPrefix }) => normalized.startsWith(pathPrefix))
  if (repositoryRoot) {
    const relative = normalized.slice(repositoryRoot.pathPrefix.length)
    return `${repositoryRoot.url}/blob/${repositoryRoot.ref}/${relative}`
  }
  if (!project.repositoryUrl || !project.repositoryRef) return undefined
  return `${project.repositoryUrl}/blob/${project.repositoryRef}/${normalized}`
}

export function portalUrl(): string {
  return import.meta.env.BASE_URL
}

export function projectUrl(slug: string): string {
  return `${import.meta.env.BASE_URL}projects/${encodeURIComponent(slug)}/`
}

export function projectSlugFromPathname(pathname = window.location.pathname): string | undefined {
  const basePath = new URL(import.meta.env.BASE_URL, window.location.origin).pathname
  const relative = pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname.replace(/^\/+/, '')
  const match = /^projects\/([^/]+)\/?/.exec(relative)
  if (!match) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}
