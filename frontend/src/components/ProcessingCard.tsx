import { RefreshCw } from 'lucide-react'
import { STAGE_LABEL, type JobState, type SearchResult } from '../api'
import { ProgressRing } from './ProgressRing'

interface Props {
  item: Pick<SearchResult, 'id' | 'title' | 'channel' | 'thumbnail'>
  job: JobState | null
  onBack: () => void
  onRetry: () => void
}

/** The one song being turned into karaoke, centred while everything else steps aside. */
export function ProcessingCard({ item, job, onBack, onRetry }: Props) {
  const status = job?.status ?? 'queued'
  const failed = status === 'error'
  const indeterminate = status === 'queued'

  return (
    <section className="processing card">
      {item.thumbnail ? (
        <img className="processing__art" src={item.thumbnail} alt="" />
      ) : (
        <div className="processing__art" />
      )}
      <h2 className="processing__title">{item.title}</h2>
      <p className="processing__channel">{item.channel ?? 'Unknown channel'}</p>

      {failed ? (
        <>
          <p className="processing__error">{job?.error ?? 'Something went wrong'}</p>
          <div className="processing__actions">
            <button className="btn btn--outline" onClick={onRetry}>
              <RefreshCw size={15} /> Retry
            </button>
            <button className="btn btn--ghost" onClick={onBack}>
              Back to search
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="processing__status">
            <ProgressRing size={96} progress={job?.progress ?? 0} indeterminate={indeterminate} />
            {!indeterminate && <span className="processing__pct">{Math.round((job?.progress ?? 0) * 100)}%</span>}
          </div>
          <div className="processing__stage">{STAGE_LABEL[status]}</div>
          <button className="link-btn" onClick={onBack}>
            Back to search
          </button>
        </>
      )}
    </section>
  )
}
