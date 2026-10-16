'use client';
import type { Entry } from '../tournaments/types';
import { useLanguage } from '../../shared/i18n/provider';
import './match-list.css';
export function ResultPlaces({
  places,
  entries,
  bronzeSlots,
}: {
  places: { place: number; entryId: string }[] | null;
  bronzeSlots?: number;
  entries: Entry[];
}) {
  const { text } = useLanguage();
  const resolved = places ?? [];
  const bronzeCount = bronzeSlots ?? resolved.filter((p) => p.place === 3).length;
  const slots = [1, 2, ...Array.from({ length: bronzeCount }, () => 3)];
  const bronze = resolved.filter((p) => p.place === 3);
  return (
    <section className="result-places">
      <div className="round-section-heading">
        <h3>{text('Итоговые места', 'Қорытынды орындар')}</h3>
        <span className={`match-badge ${places ? 'done' : ''}`}>
          {places ? text('Определены', 'Анықталды') : text('Ещё не определены', 'Әлі анықталмаған')}
        </span>
      </div>
      <div className="medal-grid">
        {slots.map((place, index) => {
          const p = place === 3 ? bronze[index - 2] : resolved.find((p) => p.place === place);
          const e = p ? entries.find((e) => e.id === p.entryId) : undefined;
          return (
            <article
              className={`medal-card place-${place} ${p ? '' : 'medal-pending'}`}
              key={`${place}-${index}`}
            >
              <span className="medal-number">{place}</span>
              <div>
                <small>{text('МЕСТО', 'ОРЫН')}</small>
                <strong>{e ? `${e.lastName} ${e.firstName}` : '—'}</strong>
                {e?.club && <p>{e.club}</p>}
              </div>
            </article>
          );
        })}
      </div>
      {resolved.some((p) => p.place > 3) && (
        <details className="other-places">
          <summary>{text('Все места', 'Барлық орындар')}</summary>
          <ol start={4}>
            {resolved
              .filter((p) => p.place > 3)
              .map((p) => {
                const e = entries.find((e) => e.id === p.entryId);
                return (
                  <li key={p.entryId} value={p.place}>
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
