'use client';

import { useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import type { Tournament } from '../tournaments/types';

export function SavedRoster({
  tournament,
  selectedClubId,
  disabled,
  onClub,
}: {
  tournament: Tournament;
  selectedClubId: string;
  disabled: boolean;
  onClub: (id: string) => void;
}) {
  const { text } = useLanguage();
  const [group, setGroup] = useState<'club' | 'category'>('club');
  const [categoryId, setCategoryId] = useState('');
  const entries = tournament.categories.flatMap((category) =>
    (category.entries ?? []).map((entry) => ({ ...entry, category })),
  );
  const visible = entries.filter((entry) =>
    group === 'club'
      ? !selectedClubId || entry.clubId === selectedClubId
      : !categoryId || entry.category.id === categoryId,
  );
  return (
    <section className="panel roster-saved">
      <div className="panel-heading">
        <h2>{text('Сохранённые составы', 'Сақталған құрамдар')}</h2>
        <span>{entries.length}</span>
      </div>
      <div className="roster-browse-controls">
        <label>
          {text('Показать', 'Көрсету')}
          <select
            value={group}
            onChange={(event) => setGroup(event.target.value as 'club' | 'category')}
          >
            <option value="club">{text('По клубам', 'Клубтар бойынша')}</option>
            <option value="category">{text('По категориям', 'Санаттар бойынша')}</option>
          </select>
        </label>
        {group === 'category' && (
          <label>
            {text('Категория', 'Санат')}
            <select value={categoryId} onChange={(event) => setCategoryId(event.target.value)}>
              <option value="">{text('Все категории', 'Барлық санаттар')}</option>
              {tournament.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {group === 'club' && (
        <div className="roster-clubs" aria-label={text('Составы клубов', 'Клуб құрамдары')}>
          <button
            type="button"
            className={!selectedClubId ? 'active' : ''}
            disabled={disabled}
            onClick={() => onClub('')}
          >
            {text('Все', 'Барлығы')} · {entries.length}
          </button>
          {tournament.clubs.map((club) => (
            <button
              type="button"
              key={club.id}
              className={selectedClubId === club.id ? 'active' : ''}
              disabled={disabled}
              onClick={() => onClub(club.id)}
            >
              {club.name} · {club._count.entries}
            </button>
          ))}
        </div>
      )}
      <p className="field-note">
        {text('Сохранено', 'Сақталған')}: {visible.length}.{' '}
        {text(
          'Справочник клубов относится к этому турниру.',
          'Клубтар анықтамалығы осы турнирге арналған.',
        )}
      </p>
      {!visible.length ? (
        <p className="state-box">
          {text('В этом составе пока нет спортсменов.', 'Бұл құрамда әзірге спортшылар жоқ.')}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{text('Спортсмен', 'Спортшы')}</th>
                <th>{text('Год', 'Жыл')}</th>
                <th>{text('Пол', 'Жынысы')}</th>
                <th>{text('Клуб', 'Клуб')}</th>
                <th>{text('Категория', 'Санат')}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <strong>
                      {entry.lastName} {entry.firstName}
                    </strong>
                  </td>
                  <td>{entry.birthYear ?? '—'}</td>
                  <td>
                    {(entry.gender ?? entry.category.gender) === 'MALE'
                      ? text('Мужской', 'Ер')
                      : text('Женский', 'Әйел')}
                  </td>
                  <td>{entry.club}</td>
                  <td>{entry.category.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
