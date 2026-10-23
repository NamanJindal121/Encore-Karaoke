import type { Stem } from '../api'

const STEMS: Stem[] = ['vocals', 'instrumental']

/**
 * Plays the two stems from AudioBuffers on one AudioContext clock, so they stay
 * sample-locked through play/pause/seek (two <audio> elements would drift).
 */
export class KaraokeEngine {
  readonly ctx = new AudioContext()
  private gains: Record<Stem, GainNode>
  private buffers: Partial<Record<Stem, AudioBuffer>> = {}
  private sources: AudioBufferSourceNode[] = []
  private startedAt = 0
  private offset = 0
  private generation = 0
  private loadToken = 0
  private listeners = new Set<() => void>()
  private frameListeners = new Set<() => void>()
  private raf = 0

  playing = false
  duration = 0

  constructor() {
    this.gains = Object.fromEntries(
      STEMS.map((s) => {
        const g = this.ctx.createGain()
        g.connect(this.ctx.destination)
        return [s, g]
      }),
    ) as Record<Stem, GainNode>
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  /**
   * Called every animation frame while playing, and once after any state change (seek, load, pause).
   * Nothing runs while paused, so an idle page costs no GPU.
   */
  onFrame(fn: () => void) {
    this.frameListeners.add(fn)
    fn()
    return () => void this.frameListeners.delete(fn)
  }

  private emit() {
    this.listeners.forEach((fn) => fn())
    this.frameListeners.forEach((fn) => fn())
  }

  private startLoop() {
    if (this.raf) return
    let last = 0
    const loop = (now: number) => {
      if (!this.playing) {
        this.raf = 0
        return
      }
      // Capped at ~30 fps: smooth enough for a playhead and word fill, a fraction of the work on 60–165 Hz screens.
      if (now - last >= 32) {
        last = now
        this.frameListeners.forEach((fn) => fn())
      }
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  get loaded() {
    return STEMS.every((s) => this.buffers[s])
  }

  get position() {
    if (!this.playing) return this.offset
    return Math.min(this.duration, Math.max(this.offset, this.ctx.currentTime - this.startedAt))
  }

  unload() {
    this.loadToken++
    this.stopSources()
    this.playing = false
    this.buffers = {}
    this.offset = 0
    this.duration = 0
    this.emit()
  }

  /** Returns false if a newer load() superseded this one. */
  async load(urls: Record<Stem, string>): Promise<boolean> {
    this.unload()
    const token = this.loadToken

    const decoded = await Promise.all(
      STEMS.map(async (s) => {
        const res = await fetch(urls[s])
        if (!res.ok) throw new Error(`Failed to load ${s} (${res.status})`)
        return this.ctx.decodeAudioData(await res.arrayBuffer())
      }),
    )
    if (token !== this.loadToken) return false
    STEMS.forEach((s, i) => (this.buffers[s] = decoded[i]))
    this.duration = Math.max(...decoded.map((b) => b.duration))
    this.emit()
    return true
  }

  play() {
    if (!this.loaded || this.playing) return
    void this.ctx.resume()
    if (this.offset >= this.duration - 0.05) this.offset = 0

    const gen = ++this.generation
    const when = this.ctx.currentTime + 0.03
    this.sources = STEMS.map((s) => {
      const src = this.ctx.createBufferSource()
      src.buffer = this.buffers[s]!
      src.connect(this.gains[s])
      src.start(when, this.offset)
      return src
    })
    // Natural end of the longer stem; manual stops bump the generation first.
    const longest = this.sources.reduce((a, b) => (a.buffer!.duration >= b.buffer!.duration ? a : b))
    longest.onended = () => {
      if (gen !== this.generation) return
      this.playing = false
      this.offset = this.duration
      this.sources = []
      this.emit()
    }
    this.startedAt = when - this.offset
    this.playing = true
    this.emit()
    this.startLoop()
  }

  pause() {
    if (!this.playing) return
    this.offset = this.position
    this.stopSources()
    this.playing = false
    this.emit()
  }

  toggle() {
    if (this.playing) this.pause()
    else this.play()
  }

  seek(t: number) {
    const target = Math.min(Math.max(0, t), this.duration)
    if (this.playing) {
      this.stopSources()
      this.playing = false
      this.offset = target
      this.play()
    } else {
      this.offset = target
      this.emit()
    }
  }

  setVolume(stem: Stem, linear: number) {
    // Squared curve feels more even to the ear than a linear gain.
    const g = Math.max(0, Math.min(1, linear)) ** 2
    this.gains[stem].gain.setTargetAtTime(g, this.ctx.currentTime, 0.015)
  }

  private stopSources() {
    this.generation++
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {
        /* already stopped */
      }
      s.disconnect()
    }
    this.sources = []
  }
}
