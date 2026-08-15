export type RunState = 'running' | 'finished' | 'failed' | 'crashed' | 'imported'

export interface RunRecord {
  id: string
  project: string
  name: string
  state: RunState
  created_at: string
  updated_at: string
  finished_at?: string
  config: Record<string, unknown>
  tags: string[]
  source: Record<string, unknown>
  summary: Record<string, string | number | boolean>
  last_sequence: number
}

export interface Project {
  name: string
  created_at: string
  updated_at: string
  run_count: number
}

export interface HistoryPoint {
  value: number
  step: number | null
  timestamp: string
  rank: number | null
}

export type History = Record<string, HistoryPoint[]>

export interface RunEvent {
  run_id: string
  sequence: number
  kind: string
  step: number | null
  timestamp: string
  payload: Record<string, unknown>
}

export interface Artifact {
  id: string
  run_id: string
  name: string
  artifact_type: string
  mime_type: string
  digest: string
  size: number
  created_at: string
  aliases: string[]
  metadata: Record<string, unknown>
}

export interface Trace {
  id: string
  run_id: string
  parent_id: string | null
  name: string
  status: string
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  attributes: Record<string, unknown>
  input: unknown
  output: unknown
  error: string | null
}

export interface Report {
  id: string
  title: string
  project: string | null
  blocks: Array<Record<string, unknown>>
  created_at: string
  updated_at: string
}

export interface Sweep {
  id: string
  project: string
  name: string
  state: string
  config: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface RegistryEntry {
  id: string
  collection: string
  version: number
  artifact_id: string
  artifact_name: string
  artifact_type: string
  size: number
  digest: string
  aliases: string[]
  notes: string
  created_at: string
}

export interface StorageInfo {
  root: string
  bytes: number
  projects: number
  runs: number
  events: number
  artifacts: number
}

