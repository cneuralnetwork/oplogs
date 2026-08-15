import type {
  Artifact,
  History,
  Project,
  RegistryEntry,
  Report,
  RunEvent,
  RunRecord,
  StorageInfo,
  Sweep,
  Trace,
} from './types'

let writeToken = ''

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (writeToken) headers.set('X-OPLOGS-Token', writeToken)
  if (init?.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { ...init, headers })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(body || `${response.status} ${response.statusText}`)
  }
  return response.json() as Promise<T>
}

export async function initializeSession(): Promise<StorageInfo> {
  const info = await request<{ storage: StorageInfo; write_token?: string }>('/api/info')
  writeToken = info.write_token ?? ''
  return info.storage
}

export const api = {
  projects: () => request<Project[]>('/api/projects'),
  runs: (project?: string) => request<RunRecord[]>(`/api/runs${project ? `?project=${encodeURIComponent(project)}` : ''}`),
  run: (id: string) => request<RunRecord>(`/api/runs/${id}`),
  history: (id: string, limit = 2500) => request<History>(`/api/runs/${id}/history?limit=${limit}`),
  events: (id: string, kind?: string, limit = 1000, compact = false) => request<RunEvent[]>(`/api/runs/${id}/events?limit=${limit}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}${compact ? '&compact=true' : ''}`),
  runArtifacts: (id: string) => request<Artifact[]>(`/api/runs/${id}/artifacts`),
  artifacts: () => request<Artifact[]>('/api/artifacts'),
  traces: (runId?: string) => request<Trace[]>(`/api/traces${runId ? `?run_id=${encodeURIComponent(runId)}` : ''}`),
  reports: () => request<Report[]>('/api/reports'),
  createReport: (payload: { title: string; project?: string; blocks: Array<Record<string, unknown>> }) =>
    request<Report>('/api/reports', { method: 'POST', body: JSON.stringify(payload) }),
  updateReport: (id: string, payload: { title: string; blocks: Array<Record<string, unknown>> }) =>
    request<Report>(`/api/reports/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  sweeps: () => request<Sweep[]>('/api/sweeps'),
  registry: () => request<RegistryEntry[]>('/api/registry'),
  register: (payload: { artifact_id: string; collection: string; aliases: string[]; notes?: string }) =>
    request<RegistryEntry>('/api/registry', { method: 'POST', body: JSON.stringify(payload) }),
  storage: () => request<StorageInfo>('/api/storage'),
}
