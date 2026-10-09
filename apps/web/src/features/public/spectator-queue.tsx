'use client';
import { useState } from 'react';
import type { QueueItem } from '../tatamis/queue-view';
import { useLanguage } from '../../shared/i18n/provider';

export function SpectatorQueue({ items }: { items: QueueItem[] }) {
  const { text } = useLanguage();
  const [limit, setLimit] = useState(3);
  return (
    <section className="spectator-section">
      <div className="spectator-section-heading">
        <h2>{text('Следующие схватки', 'Келесі белдесулер')}</h2>
        <span>
          {items.length} {text('в очереди', 'кезекте')}
        </span>
      </div>
      {!items.length ? (
        <p className="spectator-empty">
          {text(
            'Следующие пары ещё не назначены. Они появятся здесь автоматически.',
            'Келесі жұптар әлі тағайындалмаған. Олар мұнда автоматты түрде пайда болады.',
          )}
        </p>
      ) : (
        <>
          <ol className="spectator-queue">
            {items.slice(0, limit).map((m, index) => (
              <li key={m.id}>
                <header>
                  <strong>
                    {text('В очереди', 'Кезекте')} № {index + 1}
                  </strong>
                  <span>
                    {text('Круг', 'Айналым')} {m.round ?? '—'}
                  </span>
                </header>
                <h3>{m.category}</h3>
                {(['white', 'blue'] as const).map((side) => (
                  <div className={`spectator-pair ${side}`} key={side}>
                    <span className="spectator-side">
                      {side === 'white' ? text('Белый', 'Ақ') : text('Синий', 'Көк')}
                    </span>
                    <div>
                      <strong>
                        {m[side]
                          ? `${m[side]!.lastName} ${m[side]!.firstName}`
                          : text('Ожидаем участника', 'Қатысушыны күтеміз')}
                      </strong>
                      <span>{m[side]?.club}</span>
                    </div>
                  </div>
                ))}
                {m.blockedByRound && (
                  <p className="spectator-note">
                    {text(
                      'После завершения предыдущего круга',
                      'Алдыңғы айналым аяқталғаннан кейін',
                    )}
                  </p>
                )}
              </li>
            ))}
          </ol>
          {items.length > 3 && (
            <div className="spectator-more">
              {limit < items.length && (
                <button onClick={() => setLimit((n) => n + 10)}>
                  {text('Показать ещё', 'Тағы көрсету')} · {items.length - limit}
                </button>
              )}
              {limit > 3 && (
                <button onClick={() => setLimit(3)}>
                  {text('Свернуть очередь', 'Кезекті жинау')}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
