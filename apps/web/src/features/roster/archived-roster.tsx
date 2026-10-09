'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { pollSnapshots } from '../../shared/live/snapshot-poller';
import { request } from '../tournaments/api';
import type { Tournament } from '../tournaments/types';
import { rosterMessage } from './messages';
import { validSavedEntry, type SavedEntry } from './roster-model';

type ArchivedRosterSnapshot = { revision: number; entries: SavedEntry[] };

export function ArchivedRoster({
  tournament,
  disabled,
  onRestore,
  onUpdate,
}: {
  tournament: Tournament;
  disabled: boolean;
  onRestore: (entry: SavedEntry) => void;
  onUpdate: () => Promise<void>;
}) {
  const { text, locale } = useLanguage();
  const [snapshot, setSnapshot] = useState<ArchivedRosterSnapshot | null>(null);
  const [error, setError] = useState(false);
  const current = useRef({ revision: tournament.rosterRevision, onUpdate });
  current.current = { revision: tournament.rosterRevision, onUpdate };
  const latestRevision = useRef(-1);
  const refresh = useRef<(() => Promise<void>) | null>(null);
  const ready = !!snapshot && snapshot.revision === tournament.rosterRevision;

  useEffect(() => {
    let active = true;
    latestRevision.current = -1;
    setSnapshot(null);
    const poller = pollSnapshots(
      () => request<ArchivedRosterSnapshot>(`/tournaments/${tournament.id}/roster/archived`),
      (value) => {
        if (
          !Number.isSafeInteger(value?.revision) ||
          value.revision < 0 ||
          !Array.isArray(value.entries) ||
          value.entries.some((entry) => !validSavedEntry(entry) || !entry.archivedAt) ||
          new Set(value.entries.map((entry) => entry.id)).size !== value.entries.length
        ) {
          setError(true);
          return;
        }
        if (value.revision < current.current.revision || value.revision < latestRevision.current)
          return;
        latestRevision.current = value.revision;
        setSnapshot(value);
        setError(false);
        if (value.revision > current.current.revision)
          void current.current.onUpdate().catch(() => {
            if (active) setError(true);
          });
      },
      () => setError(true),
      5000,
    );
    refresh.current = poller.refresh;
    void poller.refresh();
    return () => {
      active = false;
      poller.stop();
      refresh.current = null;
    };
  }, [tournament.id]);

  useEffect(() => {
    void refresh.current?.();
  }, [tournament.rosterRevision]);

  return (
    <details className="roster-archive">
      <summary>
        {text('Архив исключённых заявок', 'Шығарылған өтінімдер мұрағаты')}
        {ready ? ` · ${snapshot.entries.length}` : ''}
      </summary>
      <p className="field-note">
        {text(
          'Исключённые участники не входят в активные составы. Восстановление сохраняет исходную заявку и требует проверки.',
          'Шығарылған қатысушылар белсенді құрамға кірмейді. Қалпына келтіру бастапқы өтінімді сақтайды және тексеруді қажет етеді.',
        )}
      </p>
      {error && (
        <p className="error-box" role="alert">
          {rosterMessage('ARCHIVE_LOAD_FAILED', locale === 'kk')}{' '}
          <button type="button" onClick={() => void refresh.current?.()}>
            {text('Обновить архив', 'Мұрағатты жаңарту')}
          </button>
        </p>
      )}
      {!ready ? (
        <p className="field-note" role="status">
          {text('Обновляем архив…', 'Мұрағат жаңартылуда…')}
        </p>
      ) : !snapshot.entries.length ? (
        <p className="field-note">
          {text('Исключённых заявок пока нет.', 'Шығарылған өтінімдер әзірге жоқ.')}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{text('Спортсмен', 'Спортшы')}</th>
                <th>{text('Год', 'Жыл')}</th>
                <th>{text('Клуб', 'Клуб')}</th>
                <th>{text('Категория', 'Санат')}</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <strong>
                      {entry.lastName} {entry.firstName}
                    </strong>
                    <div className="roster-entry-actions">
                      <button
                        type="button"
                        disabled={disabled || error || tournament.status !== 'DRAFT'}
                        onClick={() => onRestore(entry)}
                        aria-label={`${text('Восстановить заявку', 'Өтінімді қалпына келтіру')}: ${entry.lastName} ${entry.firstName}`}
                      >
                        {text('Восстановить', 'Қалпына келтіру')}
                      </button>
                    </div>
                  </td>
                  <td>{entry.birthYear ?? '—'}</td>
                  <td>{entry.club}</td>
                  <td>
                    {tournament.categories.find((category) => category.id === entry.categoryId)
                      ?.name ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </details>
  );
}
