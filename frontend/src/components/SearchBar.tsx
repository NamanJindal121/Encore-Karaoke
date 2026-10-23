import { useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'

interface Props {
  value: string
  onChange: (v: string) => void
  loading: boolean
  placeholder: string
  autoFocus?: boolean
}

export function SearchBar({ value, onChange, loading, placeholder, autoFocus }: Props) {
  const ref = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (autoFocus) ref.current?.focus()
  }, [autoFocus])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea')
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault()
        ref.current?.focus()
        ref.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <label className="searchbar">
      <Search size={19} className="searchbar__icon" />
      <input
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && (onChange(''), ref.current?.blur())}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
      />
      {loading ? (
        <span className="spinner" />
      ) : value ? (
        <button className="icon-btn" onClick={() => onChange('')} title="Clear">
          <X size={16} />
        </button>
      ) : (
        <kbd>Ctrl K</kbd>
      )}
    </label>
  )
}
