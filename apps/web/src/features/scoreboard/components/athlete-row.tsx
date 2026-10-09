import { useLanguage } from '../../../shared/i18n/provider';
import { scoreboardScores, type Side, type Score, type MatchState } from '@judo/engine/match';
import { labels, russian } from '../model/labels';
import { time } from '../lib/format-time';
export function AthleteRow({
  side,
  athlete,
  state,
  onAward,
  onHold,
  operator,
  controlsDisabled = false,
  onRevoke,
}: {
  side: Side;
  athlete: { surname: string; name: string; club: string; color: string; number: string };
  state: MatchState;
  onAward: (kind: Score | 'SHIDO') => void;
  onHold: () => void;
  operator: boolean;
  controlsDisabled?: boolean;
  onRevoke?: (awardId: string) => void;
}) {
  const { text } = useLanguage();
  const values = scoreboardScores(state, side),
    hold = state.hold?.side === side;
  const enabled = ['RUNNING', 'PAUSED', 'DECISION'].includes(state.status);
  const holdAward = hold
    ? state.awards.find((a) => a.id === state.hold?.awardId && a.active)
    : undefined;
  const holdLimit = state.rules.holdThresholds.at(-1)?.ms ?? 1;
  return (
    <section
      className={`athlete ${side.toLowerCase()}`}
      aria-label={`${athlete.color}: ${athlete.surname} ${athlete.name}`}
    >
      <div className="athlete-main">
        <div className="country-mark">
          <img
            className="country-flag"
            src="/flags/kz.svg"
            width={80}
            height={40}
            alt={text('Флаг Казахстана', 'Қазақстан туы')}
          />
          <strong>KAZ</strong>
          <span className="country-side">{athlete.color}</span>
        </div>
        <div className="identity">
          <div className="competitor-no">
            {text('УЧАСТНИК', 'ҚАТЫСУШЫ')} {athlete.number}
          </div>
          <h2>
            {athlete.surname} <span>{athlete.name}</span>
          </h2>
          <p>{athlete.club}</p>
        </div>
        <div className="scores">
          {(['IPPON', 'WAZA_ARI', 'YUKO', 'SHIDO'] as const).map((kind) => {
            const last = [...state.awards]
              .reverse()
              .find((a) => a.active && a.side === side && a.kind === kind);
            const label = (
              <>
                <span>{labels[kind]}</span>
                <strong aria-label={`${russian[kind]}: ${values[kind]}`}>{values[kind]}</strong>
                <small>{russian[kind]}</small>
              </>
            );
            return (
              <div
                key={kind}
                className={`score ${kind.toLowerCase()} ${operator ? 'interactive-score' : ''}`}
              >
                {operator ? (
                  <>
                    <button
                      className="score-add"
                      disabled={
                        controlsDisabled ||
                        !enabled ||
                        (kind !== 'SHIDO' && !state.rules.enabledScores.includes(kind))
                      }
                      onClick={() => onAward(kind)}
                      aria-label={`${text('Добавить', 'Қосу')} ${labels[kind]} · ${athlete.color}`}
                    >
                      {label}
                      <em>＋</em>
                    </button>
                    {onRevoke && (
                      <button
                        className="score-remove"
                        disabled={
                          controlsDisabled ||
                          !last ||
                          !!state.hold ||
                          state.status === 'CONFIRMED' ||
                          (state.phase === 'GOLDEN' && last.phase !== 'GOLDEN')
                        }
                        onClick={() => last && onRevoke(last.id)}
                        aria-label={`${text('Отменить', 'Жою')} ${labels[kind]} · ${athlete.color}`}
                      >
                        − <span>{text('Убрать', 'Алу')}</span>
                      </button>
                    )}
                  </>
                ) : (
                  label
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className={`osaekomi ${hold ? 'active' : ''}`}>
        <span>{hold ? text('● УДЕРЖАНИЕ / OSAEKOMI', '● ҰСТАП ТҰРУ / OSAEKOMI') : 'OSAEKOMI'}</span>
        {hold && (
          <strong>
            {time(state.hold!.elapsedMs).main}.{time(state.hold!.elapsedMs).tenth}
          </strong>
        )}
        <div
          className="hold-progress"
          style={{
            width: hold ? `${Math.min(100, (state.hold!.elapsedMs / holdLimit) * 100)}%` : '0%',
          }}
        />
      </div>
      {(operator || hold) && state.rules.holdThresholds.length > 0 && (
        <div className="hold-thresholds">
          <span>{text('Автооценка', 'Автоматты баға')}</span>
          {state.rules.holdThresholds.map((threshold) => (
            <span
              key={threshold.score}
              className={holdAward?.kind === threshold.score ? 'reached' : ''}
            >
              {threshold.ms / 1000} {text('с', 'с')} · {labels[threshold.score]}
            </span>
          ))}
        </div>
      )}
      {operator && (
        <div className="athlete-controls">
          <button
            disabled={controlsDisabled || state.status !== 'RUNNING' || !!state.hold}
            onClick={onHold}
          >
            {text('Удержание', 'Ұстап тұру')} · {athlete.color}
          </button>
        </div>
      )}
    </section>
  );
}
