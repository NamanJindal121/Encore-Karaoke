export type Stem = 'vocals' | 'instrumental'
export type Status = 'queued' | 'downloading' | 'separating' | 'encoding' | 'lyrics' | 'ready' | 'error'

export interface JobState {
  status: Status
  progress: number
  error: string | null
}

export interface SearchResult {
  id: string
  title: string
  channel: string | null
  duration: number | null
  thumbnail: string | null
  status: Status | null
  progress: number
  too_long: boolean
}

export interface Peaks {
  vocals: number[]
  instrumental: number[]
  duration: number
}

export interface LyricWord {
  start: number
  end: number
  text: string
}

export interface LyricLine {
  start: number
  end: number
  text: string
  words: LyricWord[]
  /** Corrected by the user */
  edited?: boolean
}

export interface Lyrics {
  /** lrclib-aligned: word timing from Whisper; lrclib: line timing only; whisper: auto-transcribed */
  source: 'lrclib-aligned' | 'lrclib' | 'whisper' | 'none'
  language?: string | null
  artist?: string | null
  track?: string | null
  lines: LyricLine[]
}

export type LyricsStatus = 'ready' | 'pending' | 'missing'

export interface Song {
  id: string
  title: string
  channel: string | null
  duration: number | null
  thumbnail: string | null
  status: Status
  progress: number
  error: string | null
  updated_at: number
  stems?: Record<Stem, string>
  peaks?: Peaks
  lyrics?: Lyrics | null
  lyrics_status?: LyricsStatus
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    let detail = res.statusText
    try {
      detail = (await res.json()).detail ?? detail
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail)
  }
  return res.json()
}

export const api = {
  search: (q: string, signal?: AbortSignal) =>
    request<SearchResult[]>(`/api/search?q=${encodeURIComponent(q)}`, { signal }),
  library: () => request<Song[]>('/api/songs'),
  song: (id: string) => request<Song>(`/api/songs/${id}`),
  create: (r: Pick<SearchResult, 'id' | 'title' | 'channel' | 'duration' | 'thumbnail'>) =>
    request<Song>('/api/songs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(r),
    }),
  editLyric: (id: string, index: number, text: string) =>
    request<LyricLine>(`/api/songs/${id}/lyrics/lines/${index}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }),
  requestLyrics: (id: string) => request<JobState>(`/api/songs/${id}/lyrics`, { method: 'POST' }),
  remove: (id: string) => request<{ ok: boolean }>(`/api/songs/${id}`, { method: 'DELETE' }),
  events: (id: string, onState: (s: JobState) => void) => {
    const es = new EventSource(`/api/songs/${id}/events`)
    es.onmessage = (e) => {
      const state = JSON.parse(e.data) as JobState | null
      if (!state) return es.close()
      onState(state)
      if (state.status === 'ready' || state.status === 'error') es.close()
    }
    return () => es.close()
  },
}

export const STAGE_LABEL: Record<Status, string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  separating: 'Separating vocals',
  encoding: 'Finalizing',
  lyrics: 'Syncing lyrics',
  ready: 'Ready',
  error: 'Failed',
}

export const isBusy = (s: Status | null | undefined) =>
  s === 'queued' || s === 'downloading' || s === 'separating' || s === 'encoding' || s === 'lyrics'

export function formatTime(sec: number | null | undefined) {
  if (sec == null || !isFinite(sec)) return '–:––'
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
