import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Minus, Plus, RefreshCw } from 'lucide-react'
import type { LyricLine, Lyrics as LyricsData, LyricsStatus } from '../api'
import type { KaraokeEngine } from '../audio/engine'

interface Props {
  engine: KaraokeEngine
  songId: string
  lyrics: LyricsData | null | undefined
  status: LyricsStatus | undefined
  progress: number
  onRetry: () => void
  onEditLine: (index: number, text: string) => Promise<void>
}

const NO_LINES: LyricLine[] = []

/** Gap before a line long enough to show the "♪" countdown instead of a lyric. */
const GAP_SEC = 4

const SOURCE_LABEL: Record<LyricsData['source'], string | null> = {
  'lrclib-aligned': null,
  lrclib: 'Line timing',
  whisper: 'Auto-transcribed',
  none: null,
}

/** Index of the last line that has started at time t (-1 before the first line). */
function lineAt(lines: LyricLine[], t: number) {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].start <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

function loadOffset(id: string | null) {
  if (!id) return 0
  try {
    return Number(localStorage.getItem(`lyr-off:${id}`)) || 0
  } catch {
    return 0
  }
}

export function Lyrics({ engine, songId, lyrics, status, progress, onRetry, onEditLine }: Props) {
  const lines = lyrics?.lines ?? NO_LINES
  const [offset, setOffset] = useState(0)
  const [current, setCurrent] = useState(-1)
  // During an intro or break, the index of the line the "♪" countdown row sits above.
  const [gapBefore, setGapBefore] = useState<number | null>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<(HTMLDivElement | null)[]>([])
  const gapRef = useRef<HTMLDivElement>(null)
  const countdownRef = useRef<HTMLSpanElement>(null)

  useEffect(() => setOffset(loadOffset(songId)), [songId])

  const changeOffset = (delta: number) => {
    setOffset((o) => {
      const next = Math.round((o + delta) * 10) / 10
      try {
        localStorage.setItem(`lyr-off:${songId}`, String(next))
      } catch {
        /* storage unavailable */
      }
      return next
    })
  }

  // Pick the current line and fill its words straight into the DOM. Runs per frame only while
  // playing (engine.onFrame), and once after a seek or offset change.
  useEffect(() => {
    if (!lines.length) return
    let lastIdx = -2
    let lastGap: number | null = -2
    return engine.onFrame(() => {
      const t = engine.position - offset
      const idx = lineAt(lines, t)
      const next = lines[idx + 1]
      // Intro or instrumental break: the whole gap between two lines decides, not the time left in it,
      // so the countdown stays up until the next line starts instead of vanishing with 4 s to go
      // (which snapped the view back to the finished line, then forward again).
      const prevEnd = idx >= 0 ? lines[idx].end : 0
      const gap = next && next.start - prevEnd > GAP_SEC && t >= prevEnd ? idx + 1 : null
      if (idx !== lastIdx) setCurrent((lastIdx = idx))
      if (gap !== lastGap) setGapBefore((lastGap = gap))
      if (gap != null && countdownRef.current) {
        countdownRef.current.textContent = String(Math.ceil(next.start - t))
      }

      const el = idx >= 0 ? lineRefs.current[idx] : null
      if (el) {
        const line = lines[idx]
        const spans = el.children as HTMLCollectionOf<HTMLElement>
        const words = line.words.length ? line.words : [{ start: line.start, end: line.end }]
        for (let i = 0; i < spans.length && i < words.length; i++) {
          const w = words[i]
          // Quantized to 2% steps and skipped when unchanged, so finished and upcoming words cost nothing.
          const p = (Math.round(Math.min(1, Math.max(0, (t - w.start) / Math.max(0.05, w.end - w.start))) * 50) / 50).toFixed(2)
          if (spans[i].dataset.p !== p) {
            spans[i].dataset.p = p
            spans[i].style.setProperty('--p', p)
          }
        }
      }
    })
  }, [engine, lines, offset])

  // The panel scrolls freely; it follows the current line unless you've scrolled it yourself
  // in the last few seconds.
  const [detached, setDetached] = useState(false)
  const detachedRef = useRef(false)
  const reattachTimer = useRef(0)

  // Double-click a line to correct it. While editing, the panel holds still.
  const [editing, setEditing] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const editingRef = useRef<number | null>(null)
  editingRef.current = editing

  const startEdit = (i: number) => {
    setEditError(null)
    setDraft(lines[i].text)
    setEditing(i)
  }

  const finishEdit = async (save: boolean) => {
    const i = editingRef.current
    if (i == null) return
    editingRef.current = null // Enter then blur must not save twice
    const text = draft.trim().replace(/\s+/g, ' ')
    if (save && text && text !== lines[i].text) {
      try {
        await onEditLine(i, text)
      } catch (e) {
        setEditError(`Couldn't save: ${(e as Error).message}`)
      }
    }
    setEditing(null)
  }

  const center = useCallback(
    (smooth: boolean) => {
      const vp = viewportRef.current
      const list = listRef.current
      if (!vp || !list || detachedRef.current || editingRef.current != null) return
      const el = gapBefore != null ? gapRef.current : lineRefs.current[Math.max(0, current)]
      if (!el) return
      const top = el.offsetTop + el.offsetHeight / 2 - vp.clientHeight / 2
      vp.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
    },
    [current, gapBefore],
  )

  const reattach = useCallback(() => {
    window.clearTimeout(reattachTimer.current)
    detachedRef.current = false
    setDetached(false)
  }, [])

  // Manual scrolling (wheel, touch) pauses following; it resumes 4 s after you stop.
  const detach = () => {
    detachedRef.current = true
    setDetached(true)
    window.clearTimeout(reattachTimer.current)
    reattachTimer.current = window.setTimeout(reattach, 4000)
  }

  useEffect(() => () => window.clearTimeout(reattachTimer.current), [])

  useLayoutEffect(() => center(true), [center, lines, detached, editing])

  // Half a viewport of padding above and below lets the first and last lines reach the centre.
  useEffect(() => {
    const vp = viewportRef.current
    const list = listRef.current
    if (!vp || !list) return
    const ro = new ResizeObserver(() => {
      list.style.paddingBlock = `${Math.round(vp.clientHeight / 2)}px`
      center(false)
    })
    ro.observe(vp)
    return () => ro.disconnect()
  }, [center, lines])

  let body
  if (status === 'pending' || (status === undefined && !lyrics)) {
    body = (
      <div className="lyrics__msg">
        <span className="spinner" />
        Syncing lyrics{progress > 0 ? ` · ${Math.round(progress * 100)}%` : '…'}
      </div>
    )
  } else if (!lines.length) {
    body = (
      <div className="lyrics__msg">
        No lyrics found for this song
        <button className="btn btn--ghost" onClick={onRetry}>
          <RefreshCw size={14} /> Try again
        </button>
      </div>
    )
  } else {
    body = (
      <div className="lyrics__viewport" ref={viewportRef} onWheel={detach} onTouchMove={detach}>
        <div className="lyrics__list" ref={listRef}>
          {lines.map((line, i) => (
            <Fragment key={i}>
              {gapBefore === i && (
                <div className="lyrics__gap" ref={gapRef}>
                  <span className="lyrics__notes">♪ ♪ ♪</span>
                  <span ref={countdownRef} className="lyrics__count" />
                </div>
              )}
              <div
                ref={(el) => {
                  lineRefs.current[i] = el
                }}
                className={`lyric${i === current && gapBefore == null ? ' is-current' : ''}${i <= current && (i < current || gapBefore != null) ? ' is-past' : ''}`}
                title="Click to jump here · double-click to edit"
                onClick={() => {
                  if (editing === i) return
                  reattach()
                  // Exactly the line's start: seeking earlier would briefly make the previous line current.
                  engine.seek(line.start + offset)
                }}
                onDoubleClick={() => startEdit(i)}
              >
                {editing === i ? (
                  <input
                    className="lyric__input"
                    value={draft}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void finishEdit(true)
                      else if (e.key === 'Escape') void finishEdit(false)
                    }}
                    onBlur={() => void finishEdit(true)}
                  />
                ) : (
                  (line.words.length ? line.words : [{ text: line.text }]).map((w, j) => (
                    <span key={j} className="lyric__word">
                      {w.text}{' '}
                    </span>
                  ))
                )}
              </div>
            </Fragment>
          ))}
        </div>
      </div>
    )
  }

  const tag = lyrics ? SOURCE_LABEL[lyrics.source] : null
  return (
    <div className="lyrics">
      {lines.length > 0 && (
        <>
          <div className="lyrics__fade lyrics__fade--top" />
          <div className="lyrics__fade lyrics__fade--bottom" />
        </>
      )}
      {detached && lines.length > 0 && (
        <button className="lyrics__follow btn btn--ghost" onClick={reattach}>
          Back to current line
        </button>
      )}
      <div className="lyrics__head">
        <div className="lyrics__title">
          Lyrics
          {lyrics?.track && (
            <span className="lyrics__match">
              {lyrics.artist} – {lyrics.track}
            </span>
          )}
          {tag && <span className="lyrics__tag">{tag}</span>}
          {editError && <span className="lyrics__tag lyrics__tag--error">{editError}</span>}
        </div>
        {lines.length > 0 && (
          <div className="lyrics__offset" title="Shift lyrics if they run early or late">
            <button className="icon-btn" onClick={() => changeOffset(-0.1)} aria-label="Lyrics earlier">
              <Minus size={14} />
            </button>
            <button className="lyrics__offset-val" onClick={() => changeOffset(-offset)} title="Reset">
              {offset > 0 ? '+' : ''}
              {offset.toFixed(1)}s
            </button>
            <button className="icon-btn" onClick={() => changeOffset(0.1)} aria-label="Lyrics later">
              <Plus size={14} />
            </button>
          </div>
        )}
      </div>
      {body}
    </div>
  )
}
