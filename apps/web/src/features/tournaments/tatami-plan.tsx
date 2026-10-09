'use client';
import { useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { request } from './api';
import type { Tournament } from './types';
export function TatamiPlan({
  tournament: t,
  onUpdate,
  disabled = false,
}: {
  tournament: Tournament;
  onUpdate: () => Promise<void>;
  disabled?: boolean;
}) {
  const { text } = useLanguage();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const confirmed = t.categories.filter((c) => c.draw?.status === 'CONFIRMED').length;
  const pinned = t.categories.filter((c) => c.homeTatamiId).length;
  async function distribute() {
    setBusy(true);
    setError('');
    try {
      await request(`/tournaments/${t.id}/schedule`, {});
      await onUpdate();
    } catch {
      setError(
        text(
          'Не удалось распределить. Подтвердите все сетки и повторите.',
          'Бөлу мүмкін болмады. Барлық торларды растап, қайталаңыз.',
        ),
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="tatami-plan" open={pinned < t.categories.length}>
      <summary>
        <span>{text('Распределение по татами', 'Татамиге бөлу')}</span>
        <span>
          {pinned} / {t.categories.length} {text('категорий закреплено', 'санат бекітілді')}
        </span>
      </summary>
      <div className="tatami-plan-body">
        <p className="schedule-order-note">
          {text(
            'Порядок на татами: круг 1 всех категорий → круг 2 → далее. В каждом круге: младшие → старшие; лёгкие веса → тяжёлые. Отдых спортсменов обязателен.',
            'Татамидегі рет: барлық санаттардың 1-айналымы → 2-айналымы → әрі қарай. Әр айналымда: кішілер → үлкендер; жеңіл салмақтар → ауыр салмақтар. Спортшылардың демалысы міндетті.',
          )}
        </p>
        <div className="draw-section-heading">
          <p>
            {text(
              'Категория целиком на одном татами. Новые категории распределяются по числу оставшихся схваток; закреплённые остаются на месте.',
              'Әр санат толықтай бір татамиде. Жаңа санаттар қалған белдесулер саны бойынша бөлінеді; бекітілгендер орнында қалады.',
            )}
          </p>
          <button
            className="solid-button"
            disabled={
              disabled ||
              busy ||
              !t.categories.length ||
              confirmed !== t.categories.length ||
              t.status === 'FINISHED'
            }
            onClick={distribute}
          >
            {busy
              ? text('Распределяем…', 'Бөлінуде…')
              : text('Автораспределение', 'Автоматты бөлу')}
          </button>
        </div>
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        {confirmed < t.categories.length && (
          <p className="field-note">
            {text(
              'Сначала подтвердите все сетки. При запуске турнира распределение выполняется автоматически.',
              'Алдымен барлық торларды растаңыз. Турнир басталғанда бөлу автоматты орындалады.',
            )}
          </p>
        )}
        <div className="tatami-plan-grid">
          {t.tatamis?.map((m) => {
            const categories = t.categories.filter((c) => c.homeTatamiId === m.id);
            const count = categories.reduce((sum, c) => sum + (c.draw?._count.contests ?? 0), 0);
            return (
              <article key={m.id}>
                <header>
                  <strong>Татами {m.number}</strong>
                  <span>
                    {count} {text('схваток всего', 'барлық белдесу')}
                  </span>
                </header>
                <div>
                  {categories.length ? (
                    categories.map((c) => (
                      <span className="category-chip" key={c.id}>
                        {c.name}
                      </span>
                    ))
                  ) : (
                    <p>{text('Пока без категорий', 'Әзірге санаттар жоқ')}</p>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </details>
  );
}
