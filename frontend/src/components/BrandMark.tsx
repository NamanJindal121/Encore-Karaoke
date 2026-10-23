import { useEffect, useRef } from 'react'

const REST = [0.4, 0.8, 1, 0.55]

const TWITCH = 0.12 // how far a bar may stray from its resting height (fraction of full height)
const TICK_MS = 450 // matches the CSS transition, so bars glide continuously

/**
 * Equalizer logo. While playing, each bar twitches to a random height close to its resting one,
 * so the overall shape always reads the same. Bars glide there with a transform transition,
 * which runs on the compositor and costs next to nothing.
 */
export function BrandMark({ active }: { active: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const bars = Array.from(ref.current!.children) as HTMLElement[]
    const set = (heights: number[]) => bars.forEach((b, i) => (b.style.transform = `scaleY(${heights[i].toFixed(3)})`))
    if (!active) {
      set(REST)
      return
    }
    const id = window.setInterval(
      () => set(REST.map((h) => Math.min(1, h + (Math.random() * 2 - 1) * TWITCH))),
      TICK_MS,
    )
    return () => window.clearInterval(id)
  }, [active])

  return (
    <span className="brand__mark" ref={ref}>
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}
