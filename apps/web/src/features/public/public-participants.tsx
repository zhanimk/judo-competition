'use client';
import { useState } from 'react';
import Link from 'next/link';
import type { PublicTournament } from './public-hub';
import { useLanguage } from '../../shared/i18n/provider';
export function PublicParticipants({ tournament }: { tournament: PublicTournament }) {
  const { text } = useLanguage();
  const [query, setQuery] = useState(''),
    [categoryId, setCategory] = useState(''),
    [page, setPage] = useState(0);
  const entries = tournament.categories.flatMap((c) =>
    c.entries.map((e) => ({ ...e, category: c.name, categoryId: c.id })),
  );
  const filtered = entries.filter(
    (e) =>
      (!categoryId || e.categoryId === categoryId) &&
      `${e.lastName} ${e.firstName} ${e.club}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 20)),
    currentPage = Math.min(page, pages - 1);
  return (
    <section className="spectator-section">
      <h2>{text('Найти участника', 'Қатысушыны табу')}</h2>
      <div className="public-filters">
        <label>
          {text('Фамилия, имя или клуб', 'Тегі, аты немесе клубы')}
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder={text('Введите имя спортсмена', 'Спортшының атын енгізіңіз')}
          />
        </label>
        <label>
          {text('Категория', 'Санат')}
          <select
            value={categoryId}
            onChange={(e) => {
              setCategory(e.target.value);
              setPage(0);
            }}
          >
            <option value="">{text('Все категории', 'Барлық санаттар')}</option>
            {tournament.categories.map((c) => (
              <option value={c.id} key={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p role="status">
        {text('Найдено участников', 'Табылған қатысушылар')}: <strong>{filtered.length}</strong>
      </p>
      <ul className="spectator-participants">
        {filtered.slice(currentPage * 20, (currentPage + 1) * 20).map((e) => (
          <li key={e.id}>
            <h3>
              {e.lastName} {e.firstName}
            </h3>
            <p>{e.club}</p>
            <span className="spectator-category">{e.category}</span>
            <Link href={`/public/tournaments/${tournament.id}?view=draw&category=${e.categoryId}`}>
              {text('Сетка', 'Тор')} <span aria-hidden="true">→</span>
            </Link>
          </li>
        ))}
      </ul>
      {!filtered.length && (
        <div className="spectator-empty">
          <p>
            {text(
              'Участник не найден. Проверьте имя или выберите другую категорию.',
              'Қатысушы табылмады. Атын тексеріңіз немесе басқа санатты таңдаңыз.',
            )}
          </p>
          {(query || categoryId) && (
            <button
              onClick={() => {
                setQuery('');
                setCategory('');
                setPage(0);
              }}
            >
              {text('Сбросить поиск', 'Іздеуді тазалау')}
            </button>
          )}
        </div>
      )}
      {pages > 1 && (
        <nav
          className="spectator-pagination"
          aria-label={text('Страницы участников', 'Қатысушылар беттері')}
        >
          <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
            {text('Назад', 'Артқа')}
          </button>
          <span>
            {currentPage + 1} / {pages}
          </span>
          <button disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>
            {text('Далее', 'Келесі')}
          </button>
        </nav>
      )}
    </section>
  );
}
