'use client';
import type { Entry } from '../tournaments/types';
import { useLanguage } from '../../shared/i18n/provider';
import './match-list.css';
export function ResultPlaces({
  places,
  entries,
}: {
  places: { place: number; entryId: string }[];
  entries: Entry[];
}) {
  const { text } = useLanguage();
  return (
    <section className="result-places">
      <div className="round-section-heading">
        <h3>{text('Итоговые места', 'Қорытынды орындар')}</h3>
        <span className="match-badge done">{text('Подтверждено', 'Расталды')}</span>
      </div>
      <div className="medal-grid">
        {places
          .filter((p) => p.place <= 3)
          .map((p) => {
            const e = entries.find((e) => e.id === p.entryId);
            return (
              <article className={`medal-card place-${p.place}`} key={p.entryId}>
                <span className="medal-number">{p.place}</span>
                <div>
                  <small>{text('МЕСТО', 'ОРЫН')}</small>
                  <strong>{e ? `${e.lastName} ${e.firstName}` : '—'}</strong>
                  <p>{e?.club}</p>
                </div>
              </article>
            );
          })}
      </div>
      {places.some((p) => p.place > 3) && (
        <details className="other-places">
          <summary>{text('Все места', 'Барлық орындар')}</summary>
          <ol start={4}>
            {places
              .filter((p) => p.place > 3)
              .map((p) => {
                const e = entries.find((e) => e.id === p.entryId);
                return (
                  <li key={p.entryId}>
                    {e?.lastName} {e?.firstName} <span>· {e?.club}</span>
                  </li>
                );
              })}
          </ol>
        </details>
      )}
    </section>
  );
}
