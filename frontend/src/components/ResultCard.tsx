import { AlertCircle, Check, Play, Sparkles, Trash2, RefreshCw } from 'lucide-react'
import { formatTime, isBusy, STAGE_LABEL, type JobState, type SearchResult } from '../api'
import { ProgressRing } from './ProgressRing'

interface Props {
  item: Pick<SearchResult, 'id' | 'title' | 'channel' | 'duration' | 'thumbnail'> & { too_long?: boolean }
  job: JobState | null
  isCurrent: boolean
  onMake: () => void
  onPlay: () => void
  onDelete?: () => void
}

export function ResultCard({ item, job, isCurrent, onMake, onPlay, onDelete }: Props) {
  const status = job?.status ?? null
  const busy = isBusy(status)

  let action
  if (status === 'ready') {
    action = (
      <button className={`btn btn--primary${isCurrent ? ' is-current' : ''}`} onClick={onPlay}>
        {isCurrent ? <Check size={16} /> : <Play size={15} fill="currentColor" />}
        {isCurrent ? 'Loaded' : 'Play'}
      </button>
    )
  } else if (busy) {
    action = (
      <div className="job">
        <ProgressRing
          size={34}
          progress={job!.progress}
          indeterminate={status === 'queued' || status === 'encoding'}
        />
        <div className="job__text">
          <span>{STAGE_LABEL[status!]}</span>
          {status !== 'queued' && <span className="job__pct">{Math.round(job!.progress * 100)}%</span>}
        </div>
      </div>
    )
  } else if (item.too_long) {
    action = <span className="hint">Too long</span>
  } else if (status === 'error') {
    action = (
      <button className="btn btn--ghost" onClick={onMake} title={job?.error ?? undefined}>
        <RefreshCw size={15} /> Retry
      </button>
    )
  } else {
    action = (
      <button className="btn btn--outline" onClick={onMake}>
        <Sparkles size={15} /> Make karaoke
      </button>
    )
  }

  return (
    <article className={`result${isCurrent ? ' is-current' : ''}${busy ? ' is-busy' : ''}`}>
      <button
        className="result__thumb"
        onClick={status === 'ready' ? onPlay : undefined}
        disabled={status !== 'ready'}
        tabIndex={-1}
      >
        {item.thumbnail && <img src={item.thumbnail} alt="" loading="lazy" />}
        {item.duration != null && <span className="result__dur">{formatTime(item.duration)}</span>}
        {status === 'ready' && (
          <span className="result__badge">
            <Check size={12} strokeWidth={3} /> In library
          </span>
        )}
      </button>
      <div className="result__body">
        <h3 className="result__title" title={item.title}>
          {item.title}
        </h3>
        <p className="result__channel">{item.channel ?? 'Unknown channel'}</p>
        {status === 'error' && job?.error && (
          <p className="result__error">
            <AlertCircle size={13} /> {job.error}
          </p>
        )}
      </div>
      <div className="result__actions">
        {action}
        {onDelete && !busy && (
          <button className="icon-btn icon-btn--danger" onClick={onDelete} title="Remove from library">
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </article>
  )
}

