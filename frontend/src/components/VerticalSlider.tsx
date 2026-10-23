import { useRef } from 'react'

interface Props {
  value: number
  onChange: (v: number) => void
  label: string
  accent: string
}

export function VerticalSlider({ value, onChange, label, accent }: Props) {
  const trackRef = useRef<HTMLDivElement>(null)

  const fromPointer = (clientY: number) => {
    const r = trackRef.current!.getBoundingClientRect()
    return Math.min(1, Math.max(0, 1 - (clientY - r.top) / r.height))
  }

  return (
    <div
      className="vslider"
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      style={{ '--accent': accent, '--value': value } as React.CSSProperties}
      onPointerDown={(e) => {
        // Stop the browser starting a text selection, which can turn into a native drag-and-drop
        // (the "no entry" cursor) that swallows the rest of the slider drag.
        e.preventDefault()
        e.currentTarget.focus()
        e.currentTarget.setPointerCapture(e.pointerId)
        onChange(fromPointer(e.clientY))
      }}
      onDragStart={(e) => e.preventDefault()}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onChange(fromPointer(e.clientY))
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 0.1 : 0.05
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') onChange(Math.min(1, value + step))
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') onChange(Math.max(0, value - step))
        else if (e.key === 'Home') onChange(0)
        else if (e.key === 'End') onChange(1)
        else return
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div className="vslider__track" ref={trackRef}>
        <div className="vslider__fill" />
        <div className="vslider__thumb" />
      </div>
    </div>
  )
}
