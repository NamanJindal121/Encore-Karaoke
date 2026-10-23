import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Captions, Mic2, Music2, Pause, Play, RotateCcw, RotateCw, Volume2, VolumeX } from 'lucide-react'
import { formatTime, type Song, type Stem } from '../api'
import type { KaraokeEngine } from '../audio/engine'
import { Lyrics } from './Lyrics'
import { VerticalSlider } from './VerticalSlider'
import { Waveform } from './Waveform'

const LANES: { stem: Stem; label: string; icon: typeof Mic2; colors: [string, string] }[] = [
  { stem: 'vocals', label: 'Vocals', icon: Mic2, colors: ['#7DD3FC', '#38BDF8'] },
  { stem: 'instrumental', label: 'Instrumental', icon: Music2, colors: ['#5EEAD4', '#14B8A6'] },
]

const DEFAULT_VOLUME: Record<Stem, number> = { vocals: 0, instrumental: 1 }
const UNMUTE_LEVEL = 0.8

function loadVolumes(id: string | undefined): Record<Stem, number> {
  if (!id) return DEFAULT_VOLUME
  try {
    const saved = localStorage.getItem(`vol:${id}`)
    if (saved) return { ...DEFAULT_VOLUME, ...JSON.parse(saved) }
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_VOLUME
}

interface Props {
  engine: KaraokeEngine
  song: Song | null
  /** Full-screen mode: lyrics fill the space below the waveforms. */
  stage: boolean
  loading: boolean
  error: string | null
  lyricsProgress: number
  onRetryLyrics: () => void
  onEditLyric: (index: number, text: string) => Promise<void>
}

function loadShowLyrics() {
  try {
    return localStorage.getItem('show-lyrics') !== '0'
  } catch {
    return true
  }
}

export function Player({ engine, song, stage, loading, error, lyricsProgress, onRetryLyrics, onEditLyric }: Props) {
  const playing = useSyncExternalStore(
    useCallback((cb) => engine.subscribe(cb), [engine]),
    () => engine.playing,
  )
  const duration = useSyncExternalStore(
    useCallback((cb) => engine.subscribe(cb), [engine]),
    () => engine.duration,
  )
  const [volumes, setVolumes] = useState<Record<Stem, number>>(DEFAULT_VOLUME)
  const lastAudible = useRef<Record<Stem, number>>({ vocals: UNMUTE_LEVEL, instrumental: UNMUTE_LEVEL })
  const timeRef = useRef<HTMLSpanElement>(null)
  const [showLyrics, setShowLyrics] = useState(loadShowLyrics)

  const toggleLyrics = () =>
    setShowLyrics((v) => {
      try {
        localStorage.setItem('show-lyrics', v ? '0' : '1')
      } catch {
        /* storage unavailable */
      }
      return !v
    })

  useEffect(() => {
    setVolumes(loadVolumes(song?.id))
  }, [song?.id])

  useEffect(() => {
    for (const { stem } of LANES) {
      engine.setVolume(stem, volumes[stem])
      if (volumes[stem] > 0.02) lastAudible.current[stem] = volumes[stem]
    }
    if (song) {
      try {
        localStorage.setItem(`vol:${song.id}`, JSON.stringify(volumes))
      } catch {
        /* storage unavailable */
      }
    }
  }, [engine, volumes, song])

  const setVolume = useCallback((stem: Stem, v: number) => setVolumes((p) => ({ ...p, [stem]: v })), [])
  const toggleMute = useCallback(
    (stem: Stem) =>
      setVolumes((p) => ({ ...p, [stem]: p[stem] > 0.02 ? 0 : lastAudible.current[stem] })),
    [],
  )

  // Clock text updates outside React, and only while playing or after a seek.
  useEffect(
    () =>
      engine.onFrame(() => {
        const text = formatTime(engine.position)
        if (timeRef.current && timeRef.current.textContent !== text) timeRef.current.textContent = text
      }),
    [engine],
  )

  // Keyboard: Space play/pause, ←/→ seek, V toggle vocals.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, textarea, [role="slider"]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (!engine.loaded) return
      if (e.code === 'Space') {
        e.preventDefault()
        engine.toggle()
      } else if (e.key === 'ArrowLeft') engine.seek(engine.position - (e.shiftKey ? 30 : 5))
      else if (e.key === 'ArrowRight') engine.seek(engine.position + (e.shiftKey ? 30 : 5))
      else if (e.key.toLowerCase() === 'v') toggleMute('vocals')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, toggleMute])

  const seek = useCallback((t: number) => engine.seek(t), [engine])
  const ready = !!song && duration > 0 && !loading

  return (
    <section className="player card">
      <div className="player__lanes">
        {LANES.map(({ stem, label, icon: Icon, colors }) => {
          const v = volumes[stem]
          const muted = v <= 0.02
          return (
            <div key={stem} className={`lane lane--${stem}${muted ? ' is-muted' : ''}`}>
              <div className="lane__meta">
                <div className="lane__name">
                  <Icon size={15} strokeWidth={2.2} />
                  <span>{label}</span>
                </div>
                <div className="lane__level">{muted ? 'Muted' : `${Math.round(v * 100)}%`}</div>
                <button
                  className="icon-btn lane__mute"
                  onClick={() => toggleMute(stem)}
                  title={muted ? `Unmute ${label.toLowerCase()}` : `Mute ${label.toLowerCase()}`}
                >
                  {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                </button>
              </div>
              <VerticalSlider
                value={v}
                onChange={(x) => setVolume(stem, x)}
                label={`${label} volume`}
                accent={colors[0]}
              />
              <Waveform
                peaks={song?.peaks?.[stem] ?? null}
                colors={colors}
                duration={ready ? duration : 0}
                engine={engine}
                onSeek={seek}
                dimmed={muted}
              />
            </div>
          )
        })}
        {(loading || error || !song) && (
          <div className="player__overlay">
            {error ? (
              <span className="text-danger">{error}</span>
            ) : loading ? (
              <>
                <span className="spinner" /> Loading stems…
              </>
            ) : (
              <span>Search for a song and turn it into karaoke</span>
            )}
          </div>
        )}
      </div>

      {stage && showLyrics && song && (
        <Lyrics
          engine={engine}
          songId={song.id}
          lyrics={song.lyrics}
          status={song.lyrics_status}
          progress={lyricsProgress}
          onRetry={onRetryLyrics}
          onEditLine={onEditLyric}
        />
      )}

      <div className="transport">
        <div className="transport__song">
          {song?.thumbnail ? (
            <img className="transport__art" src={song.thumbnail} alt="" />
          ) : (
            <div className="transport__art transport__art--empty">
              <Mic2 size={18} />
            </div>
          )}
          <div className="transport__text">
            <div className="transport__title" title={song?.title}>
              {song?.title ?? 'Nothing playing'}
            </div>
            <div className="transport__channel">{song?.channel ?? 'Pick a track below'}</div>
          </div>
        </div>

        <div className="transport__controls">
          <button className="icon-btn" disabled={!ready} onClick={() => engine.seek(engine.position - 10)} title="Back 10s">
            <RotateCcw size={18} />
          </button>
          <button className="play-btn" disabled={!ready} onClick={() => engine.toggle()} title={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" className="nudge" />}
          </button>
          <button className="icon-btn" disabled={!ready} onClick={() => engine.seek(engine.position + 10)} title="Forward 10s">
            <RotateCw size={18} />
          </button>
        </div>

        <div className="transport__time">
          {stage && song && (
            <button
              className={`icon-btn transport__lyrics${showLyrics ? ' is-on' : ''}`}
              onClick={toggleLyrics}
              title={showLyrics ? 'Hide lyrics' : 'Show lyrics'}
            >
              <Captions size={18} />
            </button>
          )}
          <span ref={timeRef}>0:00</span>
          <span className="transport__sep">/</span>
          <span className="transport__total">{formatTime(ready ? duration : song?.duration)}</span>
        </div>
      </div>
    </section>
  )
}
