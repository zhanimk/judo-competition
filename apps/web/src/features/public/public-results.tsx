'use client';
import { useState } from 'react';
import type { PublicTournament } from './public-hub';
import { categoryProgress, finalCategoryPlaces } from './results-model';
import { ResultPlaces } from '../draws/result-places';
import { ResultsTable } from '../live/results-table';
import { useLanguage } from '../../shared/i18n/provider';
export function PublicResults({ tournament }: { tournament: PublicTournament }) {
  const { text } = useLanguage();
  const [query, setQuery] = useState('');
  const [onlyFinished, setOnlyFinished] = useState(false);
  const categories = tournament.categories.map((c) => ({
    ...c,
    places: c.draw ? finalCategoryPlaces(c.draw.snapshot, c.draw.contests) : null,
    progress: c.draw ? categoryProgress(c.draw.snapshot, c.draw.contests) : null,
  }));
  categories.sort((a, b) => Number(b.places !== null) - Number(a.places !== null));
  const completed = categories.filter((c) => c.places !== null).length;
  const allFinished = categories.length > 0 && completed === categories.length;
  const search = query.trim().toLocaleLowerCase();
  const shown = categories.filter(
    (c) =>
      (!onlyFinished || c.places !== null) &&
      `${c.name} ${c.entries.map((e) => `${e.lastName} ${e.firstName} ${e.club}`).join(' ')}`
        .toLocaleLowerCase()
        .includes(search),
  );
  return (
    <section className="public-results">
      <div className="results-banner">
        <div>
          <p className="kicker">{text('РЕЗУЛЬТАТЫ ТУРНИРА', 'ТУРНИР НӘТИЖЕЛЕРІ')}</p>
          <h2>
            {allFinished
              ? text('Итоги всех категорий', 'Барлық санаттардың қорытындысы')
              : text('Призёры завершённых категорий', 'Аяқталған санаттардың жүлдегерлері')}
          </h2>
          <p>
            {text(
              'Здесь появляются итоговые места после подтверждения всех схваток категории и публикации её сетки.',
              'Мұнда санаттың барлық белдесулері расталып, торы жарияланғаннан кейін қорытынды орындар көрсетіледі.',
            )}
          </p>
        </div>
        <div className="results-counter">
          <strong>
            {completed}
            <span> / {categories.length}</span>
          </strong>
          <small>{text('категорий с итогами', 'санат қорытындыланды')}</small>
        </div>
      </div>
      <div className="public-filters results-filters">
        <label>
          {text('Найти категорию, спортсмена или клуб', 'Санат, спортшы немесе клубты іздеу')}
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={text('Название или имя', 'Атауы немесе аты')}
          />
        </label>
        <label>
          {text('Показать', 'Көрсету')}
          <select
            value={onlyFinished ? 'finished' : 'all'}
            onChange={(e) => setOnlyFinished(e.target.value === 'finished')}
          >
            <option value="all">{text('Все категории', 'Барлық санаттар')}</option>
            <option value="finished">{text('Только с итогами', 'Тек қорытындыланған')}</option>
          </select>
        </label>
      </div>
      {!completed && (
        <p className="info-note">
          {text(
            'Итогов пока нет. Они появятся здесь автоматически — без регистрации.',
            'Қорытынды әзірге жоқ. Нәтижелер мұнда автоматты түрде, тіркелусіз пайда болады.',
          )}
        </p>
      )}
      {!shown.length && (
        <p className="state-box">{text('Категории не найдены.', 'Санаттар табылмады.')}</p>
      )}
      <div className="results-categories">
        {shown.map((c) => {
          const finished = c.draw?.contests.filter((m) => m.status === 'CONFIRMED').length ?? 0;
          const total = c.draw?.contests.length ?? 0;
          return (
            <article className="panel category-result" key={c.id}>
              <header className="round-section-heading">
                <div>
                  <h2>{c.name}</h2>
                  <p className="field-note">
                    {c.entries.length} {text('участников', 'қатысушы')}
                  </p>
                </div>
                <span className={`match-badge ${c.places ? 'done' : ''}`}>
                  {c.places
                    ? text('Итоги подтверждены', 'Қорытынды расталды')
                    : c.draw
                      ? c.progress?.phase === 'ADMIN_REVIEW'
                        ? text('Ожидается решение администратора', 'Әкімшінің шешімі күтілуде')
                        : c.progress?.phase === 'TIEBREAK'
                          ? text('Дополнительные схватки', 'Қосымша белдесулер')
                          : text('Ещё идут встречи', 'Белдесулер жалғасуда')
                      : text('Результаты не опубликованы', 'Нәтижелер жарияланбаған')}
                </span>
              </header>
              {c.places ? (
                <>
                  <ResultPlaces places={c.places} entries={c.entries} />
                  <details className="results-details">
                    <summary>
                      {text('Результаты всех схваток', 'Барлық белдесулердің нәтижелері')}
                    </summary>
                    <ResultsTable entries={c.entries} contests={c.draw!.contests} />
                  </details>
                </>
              ) : c.draw ? (
                <div className="category-progress">
                  {c.progress?.phase === 'ADMIN_REVIEW' && (
                    <p className="field-note">
                      {text(
                        'Равное число побед у трёх или более участников. Итоговые места появятся после решения администратора и завершения дополнительных встреч.',
                        'Үш немесе одан көп қатысушының жеңіс саны тең. Қорытынды орындар әкімші шешімі мен қосымша белдесулер аяқталғаннан кейін көрсетіледі.',
                      )}
                    </p>
                  )}
                  <progress
                    max={Math.max(1, total)}
                    value={finished}
                    aria-label={text('Подтверждённые схватки', 'Расталған белдесулер')}
                  />
                  <span>
                    {finished} / {total} {text('схваток подтверждено', 'белдесу расталды')}
                  </span>
                </div>
              ) : (
                <p className="field-note">
                  {text('Ожидаем публикацию администратором.', 'Әкімшінің жариялауын күтеміз.')}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
