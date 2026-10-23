import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AudioLines, Library as LibraryIcon, Search as SearchIcon } from 'lucide-react'
import { api, isBusy, type JobState, type SearchResult, type Song } from './api'
import { KaraokeEngine } from './audio/engine'
import { BrandMark } from './components/BrandMark'
import { Player } from './components/Player'
import { ProcessingCard } from './components/ProcessingCard'
import { ResultCard } from './components/ResultCard'
import { SearchBar } from './components/SearchBar'

type Tab = 'search' | 'library'
type SongMeta = Pick<SearchResult, 'id' | 'title' | 'channel' | 'duration' | 'thumbnail'>

export default function App() {
  const engine = useMemo(() => new KaraokeEngine(), [])
  const [tab, setTab] = useState<Tab>('search')
  // 'stage': a loaded song gets the whole screen. 'browse': search or library under a compact player.
  const [view, setView] = useState<'stage' | 'browse'>('browse')
  const [focusSearch, setFocusSearch] = useState(false)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [libFilter, setLibFilter] = useState('')

  const [library, setLibrary] = useState<Song[]>([])
  const [jobs, setJobs] = useState<Record<string, JobState>>({})
  const watching = useRef(new Map<string, () => void>())

  const [current, setCurrent] = useState<Song | null>(null)
  const [loadingSong, setLoadingSong] = useState(false)
  const [playerError, setPlayerError] = useState<string | null>(null)
  const currentRef = useRef<Song | null>(null)
  currentRef.current = current

  // The song you just asked to process: shown alone, centred, until it's ready.
  const [focus, setFocus] = useState<SongMeta | null>(null)
  const focusRef = useRef<SongMeta | null>(null)
  focusRef.current = focus
  // Songs you asked for that are still processing; each loads when ready unless something is playing.
  const requested = useRef(new Set<string>())

  const playing = useSyncExternalStore(
    useCallback((cb) => engine.subscribe(cb), [engine]),
    () => engine.playing,
  )

  const refreshLibrary = useCallback(async () => {
    const songs = await api.library()
    setLibrary(songs)
    return songs
  }, [])

  const refreshLyrics = useCallback(async (id: string) => {
    const s = await api.song(id)
    setCurrent((c) => (c?.id === id ? { ...c, lyrics: s.lyrics, lyrics_status: s.lyrics_status } : c))
  }, [])

  // loadSong and watch reference each other; the ref breaks the cycle.
  const watchRef = useRef<(id: string) => void>(() => {})

  const requestLyrics = useCallback((id: string) => {
    setCurrent((c) => (c?.id === id ? { ...c, lyrics: null, lyrics_status: 'pending' } : c))
    api
      .requestLyrics(id)
      .then(() => watchRef.current(id))
      .catch(() => setCurrent((c) => (c?.id === id ? { ...c, lyrics_status: 'missing' } : c)))
  }, [])

  const loadSong = useCallback(
    async (id: string, autoplay = false) => {
      setPlayerError(null)
      setLoadingSong(true)
      try {
        const song = await api.song(id)
        if (!song.stems) throw new Error('Song is not ready yet')
        engine.pause()
        setCurrent(song)
        if (song.lyrics_status === 'missing') requestLyrics(song.id)
        else if (song.lyrics_status === 'pending') watchRef.current(song.id)
        setView('stage')
        const ok = await engine.load(song.stems)
        if (ok && autoplay) engine.play()
      } catch (e) {
        setPlayerError((e as Error).message)
      } finally {
        setLoadingSong(false)
      }
    },
    [engine, requestLyrics],
  )

  const watch = useCallback(
    (id: string) => {
      if (watching.current.has(id)) return
      const stop = api.events(id, (state) => {
        setJobs((j) => ({ ...j, [id]: state }))
        if (state.status === 'ready' || state.status === 'error') {
          watching.current.delete(id)
          void refreshLibrary()
          const wanted = requested.current.delete(id)
          if (state.status === 'ready' && focusRef.current?.id === id) {
            // The song you were waiting on: load it paused and bring search back.
            setFocus(null)
            setQuery('')
            void loadSong(id)
          } else if (state.status === 'ready' && wanted && !engine.playing) {
            void loadSong(id) // you went back to search meanwhile; don't interrupt another song
          } else if (state.status === 'ready' && !currentRef.current) {
            void loadSong(id) // first finished song goes straight into an empty player
          } else if (currentRef.current?.id === id) {
            void refreshLyrics(id)
          }
        }
      })
      watching.current.set(id, stop)
    },
    [engine, loadSong, refreshLibrary, refreshLyrics],
  )
  watchRef.current = watch

  const browse = (t: Tab) => {
    setTab(t)
    setView('browse')
  }

  // Ctrl+K or "/" from the stage jumps straight into search.
  useEffect(() => {
    if (view !== 'stage') return
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea')
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault()
        setFocusSearch(true)
        browse('search')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view])

  // Initial library load; resume progress tracking for anything mid-flight.
  useEffect(() => {
    refreshLibrary().then((songs) => songs.filter((s) => isBusy(s.status)).forEach((s) => watch(s.id)))
    const active = watching.current
    return () => {
      active.forEach((stop) => stop())
      active.clear()
    }
  }, [refreshLibrary, watch])

  // Debounced live search.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setResults([])
      setSearchError(null)
      setSearching(false)
      return
    }
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      setSearching(true)
      setSearchError(null)
      try {
        setResults(await api.search(q, ctl.signal))
      } catch (e) {
        if (!ctl.signal.aborted) setSearchError((e as Error).message)
      } finally {
        if (!ctl.signal.aborted) setSearching(false)
      }
    }, 350)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
  }, [query])

  const jobFor = (id: string, fallback?: { status: SearchResult['status']; progress: number; error?: string | null }) => {
    const lib = library.find((s) => s.id === id)
    // A lyrics-only job runs on a song that is already playable.
    if (jobs[id] && !(jobs[id].status === 'lyrics' && lib?.status === 'ready')) return jobs[id]
    if (lib) return { status: lib.status, progress: lib.progress, error: lib.error }
    return fallback?.status ? { status: fallback.status, progress: fallback.progress, error: fallback.error ?? null } : null
  }

  const make = async (item: SongMeta) => {
    try {
      const song = await api.create(item)
      setJobs((j) => ({ ...j, [song.id]: { status: song.status, progress: song.progress, error: song.error } }))
      if (song.status === 'ready') void loadSong(song.id, true)
      else {
        requested.current.add(song.id)
        setFocus(item)
        watch(song.id)
      }
      void refreshLibrary()
    } catch (e) {
      setFocus(item)
      setJobs((j) => ({ ...j, [item.id]: { status: 'error', progress: 0, error: (e as Error).message } }))
    }
  }

  const editLyric = async (index: number, text: string) => {
    if (!current) return
    const id = current.id
    const line = await api.editLyric(id, index, text)
    setCurrent((c) =>
      c?.id === id && c.lyrics
        ? { ...c, lyrics: { ...c.lyrics, lines: c.lyrics.lines.map((l, i) => (i === index ? line : l)) } }
        : c,
    )
  }

  const remove = async (id: string) => {
    await api.remove(id)
    setJobs((j) => {
      const next = { ...j }
      delete next[id]
      return next
    })
    if (current?.id === id) {
      engine.unload()
      setCurrent(null)
    }
    void refreshLibrary()
  }

  const shownLibrary = library.filter((s) => {
    const f = libFilter.trim().toLowerCase()
    return !f || s.title.toLowerCase().includes(f) || (s.channel ?? '').toLowerCase().includes(f)
  })
  const readyCount = library.filter((s) => s.status === 'ready').length
  const stage = view === 'stage' && !!current && !focus

  return (
    <div className={`app${playing ? ' is-playing' : ''}${stage ? ' is-stage' : ''}`}>
      <header className="topbar">
        <div className="brand">
          <BrandMark active={playing} />
          <span className="brand__name">Encore</span>
          <span className="brand__tag">Karaoke Studio</span>
        </div>
        <nav className="tabs" role="tablist" hidden={!!focus}>
          {current && (
            <button role="tab" aria-selected={stage} className="tab" onClick={() => setView('stage')}>
              <AudioLines size={15} /> Now playing
            </button>
          )}
          <button role="tab" aria-selected={!stage && tab === 'search'} className="tab" onClick={() => browse('search')}>
            <SearchIcon size={15} /> Search
          </button>
          <button role="tab" aria-selected={!stage && tab === 'library'} className="tab" onClick={() => browse('library')}>
            <LibraryIcon size={15} /> Library
            {readyCount > 0 && <span className="tab__count">{readyCount}</span>}
          </button>
        </nav>
      </header>

      {(!focus || current) && (
        <Player
          engine={engine}
          song={current}
          stage={stage}
          loading={loadingSong}
          error={playerError}
          lyricsProgress={current && jobs[current.id]?.status === 'lyrics' ? jobs[current.id].progress : 0}
          onRetryLyrics={() => current && requestLyrics(current.id)}
          onEditLyric={editLyric}
        />
      )}

      <main className="content">
        {focus ? (
          <ProcessingCard
            item={focus}
            job={jobFor(focus.id)}
            onBack={() => setFocus(null)}
            onRetry={() => make(focus)}
          />
        ) : stage ? null : tab === 'search' ? (
          <>
            <SearchBar
              value={query}
              onChange={setQuery}
              autoFocus={focusSearch}
              loading={searching}
              placeholder="Search songs, artists, or paste a title…"
            />
            {searchError && <div className="notice notice--error">{searchError}</div>}
            {!query.trim() ? (
              <div className="empty">
                <h2>What are we singing tonight?</h2>
                <p>
                  Search any song. The first time you pick one, vocals are separated on your GPU, then the tracks
                  are kept in your library for instant replay.
                </p>
              </div>
            ) : (
              <div className={`results${searching && results.length ? ' is-stale' : ''}`}>
                {searching && !results.length
                  ? Array.from({ length: 6 }, (_, i) => <div key={i} className="result result--skeleton" />)
                  : results.map((r) => (
                      <ResultCard
                        key={r.id}
                        item={r}
                        job={jobFor(r.id, r)}
                        isCurrent={current?.id === r.id}
                        onMake={() => make(r)}
                        onPlay={() => loadSong(r.id, true)}
                      />
                    ))}
                {!searching && !results.length && !searchError && <div className="empty">No results found.</div>}
              </div>
            )}
          </>
        ) : (
          <>
            <SearchBar value={libFilter} onChange={setLibFilter} loading={false} placeholder="Filter your library…" />
            {library.length === 0 ? (
              <div className="empty">
                <h2>Your library is empty</h2>
                <p>Songs you turn into karaoke land here, ready to play instantly.</p>
              </div>
            ) : (
              <div className="results">
                {shownLibrary.map((s) => (
                  <ResultCard
                    key={s.id}
                    item={s}
                    job={jobFor(s.id)}
                    isCurrent={current?.id === s.id}
                    onMake={() => make(s)}
                    onPlay={() => loadSong(s.id, true)}
                    onDelete={() => remove(s.id)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}
