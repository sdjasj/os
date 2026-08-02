const pdfAssetUrls = import.meta.glob('../../pdf/*.pdf', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>

export type PdfTone = 'teal' | 'blue' | 'violet' | 'amber' | 'rose' | 'slate'

export interface PdfBook {
  id: string
  filename: string
  url: string
  mark: string
  title: string
  subtitle: string
  description: string
  category: string
  tags: string[]
  pages: number
  bytes: number
  tone: PdfTone
  safetyNote?: string
}

type PdfBookSeed = Omit<PdfBook, 'url'>

const bookSeeds: PdfBookSeed[] = [
  {
    id: 'agent-architecture',
    filename: 'Agent_Architecture_Design_Tutorial_2026_Expanded.pdf',
    mark: 'AG',
    title: 'Agent 架构设计教程',
    subtitle: '从单 Agent 到多智能体系统',
    description: '围绕规划、记忆、工具调用、协作、评测与工程治理，建立可落地的 Agent 系统设计框架。',
    category: '智能体系统',
    tags: ['Agent', '架构', 'Memory', 'Tool Use'],
    pages: 102,
    bytes: 777_644,
    tone: 'teal',
  },
  {
    id: 'ctf-binary-security',
    filename: 'CTF二进制与网络安全进阶教程_LaTeX精排版.pdf',
    mark: 'CTF',
    title: 'CTF 二进制利用与网络安全进阶教程',
    subtitle: '原理、实验与防御视角',
    description: '从二进制基础、内存破坏与利用链走向网络攻防分析，强调隔离实验、漏洞机理和防御验证。',
    category: '网络安全',
    tags: ['CTF', 'Binary', 'ROP', '防御'],
    pages: 86,
    bytes: 710_684,
    tone: 'rose',
    safetyNote: '仅限自有、隔离或明确授权的环境；不得用于未授权测试。',
  },
  {
    id: 'llm-jailbreak-defense',
    filename: 'LLM_Jailbreak_Zero_to_Defense_CN.pdf',
    mark: 'SAFE',
    title: '大模型越狱：从零基础到安全评测与防御',
    subtitle: '攻击面、评测方法与纵深防御',
    description: '系统理解越狱威胁模型、评测设计、检测与缓解策略，并把安全边界落到可审计流程。',
    category: 'AI 安全',
    tags: ['Jailbreak', 'Red Team', '评测', '防御'],
    pages: 137,
    bytes: 1_176_554,
    tone: 'rose',
    safetyNote: '仅用于安全研究、模型评测与防御；请遵守服务条款和测试授权。',
  },
  {
    id: 'llm-foundations',
    filename: 'LLM基础知识概念大全_教科书增强版.pdf',
    mark: 'LLM',
    title: 'LLM 基础知识概念大全',
    subtitle: '教科书增强版',
    description: '从表示学习与 Transformer 出发，串联预训练、对齐、推理、评测、部署和常见工程概念。',
    category: '大模型基础',
    tags: ['Transformer', '训练', '推理', '评测'],
    pages: 181,
    bytes: 1_302_197,
    tone: 'violet',
  },
  {
    id: 'pmpp-cuda',
    filename: 'PMPP_CUDA_Tutorial_CN_Revised.pdf',
    mark: 'GPU',
    title: '大规模并行处理器编程',
    subtitle: 'PMPP / CUDA 中文精讲与实战',
    description: '循序理解 GPU 执行模型、存储层次、并行模式、性能分析与 CUDA 程序优化。',
    category: '并行计算',
    tags: ['CUDA', 'GPU', 'PMPP', '性能优化'],
    pages: 191,
    bytes: 1_300_469,
    tone: 'blue',
  },
  {
    id: 'ppo-grpo-dpo',
    filename: 'PPO_GRPO_DPO_From_Scratch_CN.pdf',
    mark: 'RL',
    title: 'PPO、GRPO 与 DPO：从零开始',
    subtitle: '逐步公式推导与算法直觉',
    description: '从策略梯度和重要性采样出发，推导 PPO、GRPO、DPO 的目标、约束、差异与训练实践。',
    category: '强化学习',
    tags: ['PPO', 'GRPO', 'DPO', 'RLHF'],
    pages: 81,
    bytes: 538_458,
    tone: 'amber',
  },
  {
    id: 'cyber-benchmark-data',
    filename: 'cyber_benchmark_data_construction_report_zh.pdf',
    mark: 'DATA',
    title: '网络安全智能体 Benchmark 数据构造调研',
    subtitle: '任务、环境、验证与质量控制',
    description: '梳理网络安全智能体评测数据的任务来源、环境构建、验证机制、污染控制与风险边界。',
    category: 'AI 安全',
    tags: ['Benchmark', 'Agent', '数据构造', 'Cyber'],
    pages: 31,
    bytes: 1_205_063,
    tone: 'slate',
    safetyNote: '仅用于获授权的安全研究与评测；不要发布真实目标、凭据、漏洞样本或利用产物。',
  },
  {
    id: 'ai-security-interview',
    filename: '大模型安全与智能体安全面试题库_小红书牛客归纳版.pdf',
    mark: 'Q&A',
    title: '大模型安全与智能体安全面试题库',
    subtitle: '核心概念与面试问答归纳',
    description: '覆盖提示注入、越狱、数据与模型风险、Agent 工具安全、评测治理和防御体系。',
    category: '面试复习',
    tags: ['LLM Security', 'Agent Safety', '面试', '治理'],
    pages: 49,
    bytes: 521_200,
    tone: 'rose',
    safetyNote: '安全案例仅用于原理学习、风险识别和防御讨论。',
  },
  {
    id: 'llm-interview',
    filename: '大模型面经八股详解_小红书牛客汇总_公式修复版.pdf',
    mark: 'LLM',
    title: '大模型面经八股详解',
    subtitle: '核心公式、概念与工程问答',
    description: '以面试问题组织 Transformer、训练优化、对齐、推理加速、RAG 与评测等高频主题。',
    category: '面试复习',
    tags: ['LLM', '面试', '公式', 'RAG'],
    pages: 22,
    bytes: 570_141,
    tone: 'violet',
  },
  {
    id: 'cyber-security-interview',
    filename: '网络安全面经八股详解_小红书与牛客整理.pdf',
    mark: 'SEC',
    title: '网络安全面经八股详解',
    subtitle: '基础原理、攻防思路与面试问答',
    description: '整理网络协议、Web 安全、系统安全、密码学、应急响应与安全工程的常见问题。',
    category: '面试复习',
    tags: ['网络安全', 'Web', '系统安全', '面试'],
    pages: 68,
    bytes: 561_403,
    tone: 'slate',
    safetyNote: '仅限合法学习、面试复习和获授权测试。',
  },
]

function assetUrl(filename: string): string {
  const entry = Object.entries(pdfAssetUrls).find(([path]) => path.endsWith(`/${filename}`))
  if (!entry) throw new Error(`Missing PDF asset: ${filename}`)
  return entry[1]
}

export const pdfBooks: PdfBook[] = bookSeeds.map((book) => ({
  ...book,
  url: assetUrl(book.filename),
}))

if (Object.keys(pdfAssetUrls).length !== pdfBooks.length) {
  throw new Error(`PDF catalog mismatch: discovered ${Object.keys(pdfAssetUrls).length}, registered ${pdfBooks.length}`)
}

export const pdfLibrarySummary = {
  slug: 'pdf-library',
  bookCount: pdfBooks.length,
  pageCount: pdfBooks.reduce((sum, book) => sum + book.pages, 0),
  categoryCount: new Set(pdfBooks.map((book) => book.category)).size,
}

export function pdfBookHref(bookId: string, page = 1): string {
  return `#/read/${encodeURIComponent(bookId)}?page=${Math.max(1, Math.round(page))}`
}

export function formatPdfSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
