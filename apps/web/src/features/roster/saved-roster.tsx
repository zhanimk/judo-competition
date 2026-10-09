'use client';

import { useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import type { Tournament } from '../tournaments/types';
import { ArchivedRoster } from './archived-roster';
import { savedEntry, type CorrectionMode } from './entry-correction-model';
import type { SavedEntry } from './roster-model';

export function SavedRoster({
  tournament,
  selectedClubId,
  disabled,
  onClub,
  onCorrect,
  onUpdate,
}: {
  tournament: Tournament;
  selectedClubId: string;
  disabled: boolean;
  onClub: (id: string) => void;
  onCorrect: (entry: SavedEntry, mode: CorrectionMode | 'identity') => void;
  onUpdate: () => Promise<void>;
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
    <section className="panel roster-card roster-saved">
      <div className="roster-card-header">
        <h2>{text('Сохранённые составы', 'Сақталған құрамдар')}</h2>
        <span className="roster-count">
          {text('Всего', 'Барлығы')}: {entries.length}
        </span>
      </div>
      <div className="roster-card-body">
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
              aria-pressed={!selectedClubId}
              disabled={disabled}
              onClick={() => onClub('')}
            >
              <span>{text('Все', 'Барлығы')}</span>
              <span className="roster-club-count">{entries.length}</span>
            </button>
            {tournament.clubs.map((club) => (
              <button
                type="button"
                key={club.id}
                className={selectedClubId === club.id ? 'active' : ''}
                aria-pressed={selectedClubId === club.id}
                disabled={disabled}
                onClick={() => onClub(club.id)}
              >
                <span>{club.name}</span>
                <span className="roster-club-count">{club._count.entries}</span>
              </button>
            ))}
          </div>
        )}
        <p className="field-note roster-browse-note">
          <strong>
            {text('Сохранено', 'Сақталған')}: {visible.length}
          </strong>
          <span>
            {text(
              'Справочник клубов относится к этому турниру.',
              'Клубтар анықтамалығы осы турнирге арналған.',
            )}
          </span>
        </p>
        {!visible.length ? (
          <div className="roster-empty">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <circle cx="11" cy="10" r="4" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M3 26v-3a8 8 0 0 1 16 0v3M22 9h7M22 16h7M23 23h6"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <p>
              {text('В этом составе пока нет спортсменов.', 'Бұл құрамда әзірге спортшылар жоқ.')}
            </p>
          </div>
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
                {visible.map((entry) => {
                  const record = savedEntry(entry, entry.category);
                  const correctionDisabled = disabled || tournament.status !== 'DRAFT' || !record;
                  return (
                    <tr key={entry.id}>
                      <td>
                        <strong>
                          {entry.lastName} {entry.firstName}
                        </strong>
                        <div className="roster-entry-actions">
                          <button
                            type="button"
                            disabled={correctionDisabled || !record?.athleteId}
                            onClick={() => record && onCorrect(record, 'identity')}
                            aria-label={`${text('Исправить связь со спортсменом', 'Спортшымен байланысты түзету')}: ${entry.lastName} ${entry.firstName}`}
                          >
                            {text('Связь спортсмена', 'Спортшы байланысы')}
                          </button>
                          <button
                            type="button"
                            disabled={correctionDisabled}
                            onClick={() => record && onCorrect(record, 'update')}
                            aria-label={`${text('Исправить заявку', 'Өтінімді түзету')}: ${entry.lastName} ${entry.firstName}`}
                          >
                            {text('Изменить', 'Өзгерту')}
                          </button>
                          <button
                            type="button"
                            disabled={correctionDisabled}
                            onClick={() => record && onCorrect(record, 'archive')}
                            aria-label={`${text('Исключить из состава', 'Құрамнан шығару')}: ${entry.lastName} ${entry.firstName}`}
                          >
                            {text('Исключить', 'Шығару')}
                          </button>
                        </div>
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <ArchivedRoster
          tournament={tournament}
          disabled={disabled}
          onRestore={(entry) => onCorrect(entry, 'restore')}
          onUpdate={onUpdate}
        />
      </div>
    </section>
  );
}
