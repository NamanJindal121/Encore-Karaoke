import { useCallback, useEffect, useRef, useState } from 'react'
import { formatTime } from '../api'
import type { KaraokeEngine } from '../audio/engine'

interface Props {
  engine: KaraokeEngine
  peaks: number[] | null
  colors: [string, string]
  duration: number
  onSeek: (t: number) => void
  dimmed?: boolean
}

const BAR = 3
const GAP = 2

/** Resample peaks to `count` bars by taking the max of each window. */
function resample(peaks: number[], count: number) {
  const out = new Float32Array(count)
  const step = peaks.length / count
  for (let i = 0; i < count; i++) {
    let m = 0
    const end = Math.min(peaks.length, Math.ceil((i + 1) * step))
    for (let j = Math.floor(i * step); j < end; j++) m = Math.max(m, peaks[j])
    out[i] = m
  }
  return out
}

function renderBars(
  canvas: HTMLCanvasElement,
  bars: Float32Array,
  fill: CanvasGradient | string,
  dpr: number,
) {
  const ctx = canvas.getContext('2d')!
  const h = canvas.height
  ctx.clearRect(0, 0, canvas.width, h)
  ctx.fillStyle = fill
  const mid = h / 2
  const bw = BAR * dpr
  for (let i = 0; i < bars.length; i++) {
    // Gentle floor so silent passages still read as a track.
    const amp = Math.max(0.04, Math.pow(bars[i], 0.8))
    const bh = Math.max(bw, amp * (h - 4 * dpr))
    ctx.beginPath()
    ctx.roundRect(i * (BAR + GAP) * dpr, mid - bh / 2, bw, bh, bw / 2)
    ctx.fill()
  }
}

/** The playhead with its glow, drawn once; blurring every frame was the main idle GPU cost. */
function renderPlayhead(color: string, glow: string, height: number, dpr: number) {
  const c = document.createElement('canvas')
  c.width = Math.round(24 * dpr)
  c.height = height
  const ctx = c.getContext('2d')!
  ctx.fillStyle = color
  ctx.shadowColor = glow
  ctx.shadowBlur = 12 * dpr
  ctx.fillRect(c.width / 2 - dpr, 0, 2 * dpr, height)
  return c
}

export function Waveform({ engine, peaks, colors, duration, onSeek, dimmed }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const layers = useRef<{ base: HTMLCanvasElement; lit: HTMLCanvasElement; head: HTMLCanvasElement } | null>(null)
  const lastX = useRef(-1)
  const [hover, setHover] = useState<number | null>(null)
  const scrubbing = useRef(false)

  // Pre-render the dim and lit layers whenever size or data changes.
  useEffect(() => {
    const wrap = wrapRef.current!
    const build = () => {
      const dpr = window.devicePixelRatio || 1
      const { width, height } = wrap.getBoundingClientRect()
      const canvas = canvasRef.current!
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      const count = Math.max(1, Math.floor(width / (BAR + GAP)))
      const bars = peaks?.length ? resample(peaks, count) : new Float32Array(count)

      const mk = () => {
        const c = document.createElement('canvas')
        c.width = canvas.width
        c.height = canvas.height
        return c
      }
      const base = mk()
      const lit = mk()
      renderBars(base, bars, 'rgba(134, 163, 195, 0.22)', dpr)
      const g = lit.getContext('2d')!.createLinearGradient(0, 0, 0, lit.height)
      g.addColorStop(0, colors[0])
      g.addColorStop(0.5, colors[1])
      g.addColorStop(1, colors[0])
      renderBars(lit, bars, g, dpr)
      layers.current = { base, lit, head: renderPlayhead(colors[0], colors[1], canvas.height, dpr) }
      lastX.current = -1
      draw()
    }
    build()
    const ro = new ResizeObserver(build)
    ro.observe(wrap)
    return () => ro.disconnect()
    // draw is stable for a given duration; rebuilding layers is what matters here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peaks, colors])

  // Composite: dim layer + lit layer clipped to the playhead. Skips frames where the playhead
  // hasn't moved a pixel, and only runs while playing or after a change (engine.onFrame).
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const l = layers.current
    if (!canvas || !l) return
    const w = canvas.width
    const h = canvas.height
    const x = duration > 0 ? Math.round((engine.position / duration) * w) : 0
    if (x === lastX.current) return
    lastX.current = x
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(l.base, 0, 0)
    if (x > 0) ctx.drawImage(l.lit, 0, 0, x, h, 0, 0, x, h)
    if (duration > 0) ctx.drawImage(l.head, x - l.head.width / 2, 0)
  }, [engine, duration])

  useEffect(() => {
    lastX.current = -1
    return engine.onFrame(draw)
  }, [engine, draw])

  const fraction = (e: React.PointerEvent) => {
    const r = wrapRef.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
  }

  return (
    <div
      ref={wrapRef}
      className={`waveform${dimmed ? ' is-dimmed' : ''}${duration ? '' : ' is-empty'}`}
      onPointerDown={(e) => {
        if (!duration) return
        e.preventDefault() // no text selection / native drag while scrubbing
        scrubbing.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        onSeek(fraction(e) * duration)
      }}
      onPointerMove={(e) => {
        if (!duration) return
        const f = fraction(e)
        setHover(f)
        if (scrubbing.current) onSeek(f * duration)
      }}
      onPointerUp={() => (scrubbing.current = false)}
      onDragStart={(e) => e.preventDefault()}
      onPointerLeave={() => setHover(null)}
    >
      <canvas ref={canvasRef} />
      {hover != null && duration > 0 && (
        <div className="waveform__hover" style={{ left: `${hover * 100}%` }}>
          <span>{formatTime(hover * duration)}</span>
        </div>
      )}
    </div>
  )
}
