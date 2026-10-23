interface Props {
  progress: number
  size?: number
  indeterminate?: boolean
}

export function ProgressRing({ progress, size = 40, indeterminate }: Props) {
  const stroke = size > 60 ? 5 : 3
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <svg
      className={`ring${indeterminate ? ' ring--spin' : ''}`}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
    >
      <defs>
        <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--sky)" />
          <stop offset="1" stopColor="var(--turq)" />
        </linearGradient>
      </defs>
      <circle cx={size / 2} cy={size / 2} r={r} className="ring__bg" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className="ring__fg"
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={indeterminate ? c * 0.72 : c * (1 - Math.min(1, Math.max(0, progress)))}
      />
    </svg>
  )
}
