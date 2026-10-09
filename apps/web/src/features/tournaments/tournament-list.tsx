'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { request } from './api';
import { useLanguage } from '../../shared/i18n/provider';
import type { Tournament } from './types';
import './tournament-list.css';

export function TournamentList() {
  const { text } = useLanguage();
  const [items, setItems] = useState<Tournament[]>([]),
    [error, setError] = useState(false),
    [loading, setLoading] = useState(true),
    [search, setSearch] = useState('');
  async function load() {
    setLoading(true);
    setError(false);
    try {
      setItems(await request<Tournament[]>('/tournaments'));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  const current = items
    .filter((t) => t.status !== 'FINISHED')
    .sort(
      (a, b) =>
        Number(b.status === 'RUNNING') - Number(a.status === 'RUNNING') ||
        a.startDate.localeCompare(b.startDate) ||
        a.id.localeCompare(b.id),
    );
  const history = items
    .filter((t) => t.status === 'FINISHED')
    .sort((a, b) => b.endDate.localeCompare(a.endDate) || a.id.localeCompare(b.id));
  const matches = (t: Tournament) =>
    (t.name + ' ' + t.city).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const visibleCurrent = current.filter(matches),
    visibleHistory = history.filter(matches);
  function card(t: Tournament) {
    return (
      <Link className="tournament-card" key={t.id} href={`/tournaments/${t.id}`}>
        <div className="card-top">
          <span className="draft">
            {t.status === 'RUNNING'
              ? text('Турнир идёт', 'Турнир өтуде')
              : t.status === 'FINISHED'
                ? text('Завершён', 'Аяқталды')
                : text('Подготовка', 'Дайындық')}
          </span>
        </div>
        <h3>{t.name}</h3>
        <p>
          {t.city} · {t.venue}
        </p>
        <div className="card-date">
          {t.startDate} — {t.endDate}
        </div>
        <footer>
          <span>
            {t.categories.length} {text('категорий', 'санат')}
          </span>
          <span>
            {t.categories.reduce((n, c) => n + (c._count?.entries ?? 0), 0)}{' '}
            {text('участников', 'қатысушы')}
          </span>
          <span>
            {t.tatamiCount} {text('татами', 'татами')}
          </span>
        </footer>
        <div className="tournament-open">
          {t.status === 'FINISHED'
            ? text('Открыть завершённый турнир', 'Аяқталған турнирді ашу')
            : text('Открыть управление турниром', 'Турнирді басқаруды ашу')}{' '}
          <span aria-hidden="true">→</span>
        </div>
      </Link>
    );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="kicker">JUDO CHILD LEAGUE</p>
          <h1>{text('Соревнования', 'Жарыстар')}</h1>
          <p>
            {text(
              'Откройте турнир: вся подготовка, управление татами и результаты находятся внутри.',
              'Турнирді ашыңыз: дайындық, татамиді басқару және нәтижелер бір жерде.',
            )}
          </p>
        </div>
        {!loading && !error && items.length > 0 && (
          <Link href="/tournaments/new" className={current.length ? 'outline-link' : 'solid-link'}>
            {text('＋ Создать турнир', '＋ Турнир құру')}
          </Link>
        )}
      </div>
      {loading ? (
        <section className="panel state-box" role="status">
          {text('Загружаем соревнования…', 'Жарыстар жүктелуде…')}
        </section>
      ) : error ? (
        <section className="panel state-box error-box" role="alert">
          {text('Не удалось загрузить соревнования.', 'Жарыстарды жүктеу мүмкін болмады.')}{' '}
          <button onClick={load}>{text('Повторить', 'Қайталау')}</button>
        </section>
      ) : !items.length ? (
        <section className="panel empty-state">
          <h2>{text('Создайте первое соревнование', 'Алғашқы жарысты құрыңыз')}</h2>
          <p>
            {text(
              'Укажите даты и татами, затем добавьте категории и участников.',
              'Күндер мен татамиді көрсетіп, санаттар мен қатысушыларды қосыңыз.',
            )}
          </p>
          <Link className="solid-link" href="/tournaments/new">
            {text('Создать турнир →', 'Турнир құру →')}
          </Link>
        </section>
      ) : (
        <>
          {items.length > 1 && (
            <div className="tournament-search">
              <label htmlFor="tournament-search">
                {text('Найти соревнование', 'Жарысты табу')}
              </label>
              <input
                id="tournament-search"
                placeholder={text('Название или город', 'Атауы немесе қаласы')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          )}
          {visibleCurrent.length > 0 && (
            <section className="panel">
              <div className="panel-heading">
                <h2>
                  {current.length === 1
                    ? text('Текущее соревнование', 'Ағымдағы жарыс')
                    : text('Текущие соревнования', 'Ағымдағы жарыстар')}
                </h2>
              </div>
              <div
                className={`tournament-grid${visibleCurrent.length === 1 ? ' single-tournament' : ''}`}
              >
                {visibleCurrent.map(card)}
              </div>
            </section>
          )}
          {!current.length && !search.trim() && (
            <section className="panel state-box">
              <h2>{text('Все соревнования завершены', 'Барлық жарыстар аяқталды')}</h2>
              <p>
                {text(
                  'Результаты сохранены в истории. Для следующего соревнования создайте новый турнир.',
                  'Нәтижелер тарихта сақталды. Келесі жарыс үшін жаңа турнир құрыңыз.',
                )}
              </p>
            </section>
          )}
          {visibleHistory.length > 0 && (
            <details
              className="panel tournament-history"
              key={search.trim() ? 'search' : 'history'}
              open={search.trim() ? true : undefined}
            >
              <summary>
                {text('Завершённые соревнования', 'Аяқталған жарыстар')}{' '}
                <span>{visibleHistory.length}</span>
              </summary>
              <div className="tournament-grid">{visibleHistory.map(card)}</div>
            </details>
          )}
          {!visibleCurrent.length && !visibleHistory.length && (
            <section className="panel empty-state">
              <h2>{text('Ничего не найдено', 'Ештеңе табылмады')}</h2>
              <button onClick={() => setSearch('')}>
                {text('Сбросить поиск', 'Іздеуді тазалау')}
              </button>
            </section>
          )}
        </>
      )}
    </>
  );
}
