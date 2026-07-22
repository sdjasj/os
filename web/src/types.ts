export type ContentKind = 'lecture' | 'topic' | 'lab'

export interface HeadingItem {
  depth: number
  text: string
  id: string
  parentId?: string
}

export interface ContentDocument {
  id: string
  kind: ContentKind
  number: number
  title: string
  shortTitle: string
  filename: string
  repoPath: string
  raw: string
  description: string
  headings: HeadingItem[]
  readingMinutes: number
  experimentCount: number
  phase: string
  phaseKey: string
  searchText: string
}

export interface CodeExample {
  id: string
  filename: string
  language: string
  raw: string
  description: string
}

export interface ReadingRecord {
  percent: number
  lastSection?: string
  completed: boolean
  updatedAt: number
}

export interface ReadingState {
  records: Record<string, ReadingRecord>
  lastVisited?: string
}
