'use client';
import { useLanguage } from '../../shared/i18n/provider';

export type QueueBout = {
  id: string;
  key: string;
  category: string;
  blockedByRound: boolean;
  white: { firstName: string; lastName: string } | null;
  blue: { firstName: string; lastName: string } | null;
};

export function ControlQueue({
  queue,
  disabled,
  onMove,
  onShowAll,
}: {
  queue: QueueBout[];
  disabled: boolean;
  onMove: (id: string) => void;
  onShowAll: () => void;
}) {
  const { text } = useLanguage();
  return (
    <section className="control-queue">
      <h4>
        {text('Ближайшие пары', 'Алдағы жұптар')} · {queue.length}
      </h4>
      {!queue.length && (
        <p className="field-note">{text('Готовых пар пока нет', 'Дайын жұптар әзірге жоқ')}</p>
      )}
      <ol>
        {queue.slice(0, 3).map((bout) => (
          <li key={bout.id}>
            <small>
              {bout.category} · {bout.key}
            </small>
            <strong>{bout.white ? `${bout.white.lastName} ${bout.white.firstName}` : '—'}</strong>
            <strong>{bout.blue ? `${bout.blue.lastName} ${bout.blue.firstName}` : '—'}</strong>
            {bout.blockedByRound && (
              <span className="field-note">
                {text(
                  'Ожидает завершения предыдущего круга',
                  'Алдыңғы айналымның аяқталуын күтуде',
                )}
              </span>
            )}
            <button disabled={disabled} onClick={() => onMove(bout.id)}>
              {text('Перенести на другое татами', 'Басқа татамиге ауыстыру')} →
            </button>
          </li>
        ))}
      </ol>
      <button onClick={onShowAll}>
        {text('Все схватки этого татами', 'Осы татамидің барлық белдесулері')}
      </button>
    </section>
  );
}
