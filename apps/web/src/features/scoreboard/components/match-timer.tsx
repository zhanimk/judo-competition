import type { MatchState } from '@judo/engine/match';
import type { MatchAction } from '../model/types';
import { statuses } from '../model/labels';
import { time } from '../lib/format-time';
export function MatchTimer({
  state,
  send,
  operator,
}: {
  state: MatchState;
  send: (action: MatchAction) => void;
  operator: boolean;
}) {
  const t = time(
    state.phase === 'REGULAR' ? state.rules.durationMs - state.elapsedMs : state.goldenMs,
  );
  return (
    <section className="timer-zone" aria-label="Время схватки">
      <div className="timer-caption">
        {state.phase === 'REGULAR' ? 'ОСНОВНОЕ ВРЕМЯ' : 'GOLDEN SCORE'}
      </div>
      <div
        className={`timer ${state.phase === 'GOLDEN' ? 'golden' : ''}`}
        role="timer"
        aria-label={`${t.main}.${t.tenth}`}
      >
        <span>{t.main}</span>
        <small>.{t.tenth}</small>
      </div>
      <p className="match-status">
        <i className={state.status === 'RUNNING' ? 'running' : ''} />
        {statuses[state.status]}
      </p>
      {operator && (
        <div className="timer-controls">
          <button
            className="primary"
            disabled={!['READY', 'PAUSED', 'RUNNING'].includes(state.status) || !!state.hold}
            onClick={() => send({ type: state.status === 'RUNNING' ? 'STOP' : 'START' })}
          >
            {state.status === 'RUNNING'
              ? 'Ⅱ Остановить'
              : state.status === 'READY'
                ? '▶ Начать схватку'
                : '▶ Продолжить'}
          </button>
          {state.hold && (
            <button className="toketa" onClick={() => send({ type: 'TOKETA' })}>
              Токета — завершить удержание
            </button>
          )}
          {state.status === 'DECISION' && (
            <button onClick={() => send({ type: 'GOLDEN' })}>Перейти в Golden Score</button>
          )}
        </div>
      )}
    </section>
  );
}
