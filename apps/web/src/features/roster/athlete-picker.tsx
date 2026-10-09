'use client';

import { useEffect, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { ApiError, request } from '../tournaments/api';
import type { Category } from '../tournaments/types';
import { validAthleteCandidates, type AthleteCandidate } from './athlete-model';
import { rosterMessage } from './messages';
import type { AthleteDisplay } from './roster-model';

export function AthleteDetails({ display }: { display: AthleteDisplay }) {
  const { text } = useLanguage();
  return (
    <div className="roster-athlete-details">
      <strong>
        {display.lastName} {display.firstName}
      </strong>
      <span>
        {display.birthYear ?? '—'} ·{' '}
        {display.gender === 'MALE' ? text('Мужской', 'Ер') : text('Женский', 'Әйел')} ·{' '}
        {display.club || '—'}
      </span>
    </div>
  );
}

export function AthletePicker({
  tournamentId,
  categories,
  disabled,
  selectedId,
  currentEntryId,
  unavailableIds = [],
  onSelect,
  onClose,
}: {
  tournamentId: string;
  categories: Category[];
  disabled: boolean;
  selectedId?: string;
  currentEntryId?: string;
  unavailableIds?: string[];
  onSelect: (athlete: AthleteCandidate) => void;
  onClose: () => void;
}) {
  const { text, locale } = useLanguage();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AthleteCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (disabled) return;
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setResults([]);
    setError('');
    const timer = setTimeout(() => {
      void request<unknown>(
        `/tournaments/${tournamentId}/athletes?query=${encodeURIComponent(query.trim())}&limit=20`,
        undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      )
        .then((value) => {
          if (!validAthleteCandidates(value)) throw new Error('ROSTER_RESPONSE_INVALID');
          if (active) setResults(value.athletes);
        })
        .catch((error) => {
          if (active)
            setError(
              rosterMessage(
                error instanceof ApiError && error.status < 500
                  ? error.message
                  : 'ATHLETE_SEARCH_FAILED',
                locale === 'kk',
              ),
            );
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [tournamentId, query, retry, disabled, locale]);
  return (
    <div className="roster-athlete-picker">
      <div className="roster-athlete-picker-heading">
        <strong>{text('Выбрать спортсмена из истории', 'Тарихтан спортшыны таңдау')}</strong>
        <button type="button" disabled={disabled} onClick={onClose}>
          {text('Закрыть поиск', 'Іздеуді жабу')}
        </button>
      </div>
      <label>
        {text('Поиск по имени, фамилии или клубу', 'Аты, тегі немесе клубы бойынша іздеу')}
        <input
          autoFocus
          type="search"
          maxLength={120}
          disabled={disabled}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <p className="field-note">
        {text(
          'Показаны последние данные заявок из ваших турниров. Выбор явный: одинаковые ФИО не объединяются. Один спортсмен может иметь только одну активную заявку в этом турнире.',
          'Өз турнирлеріңіздегі өтінімдердің соңғы деректері көрсетілген. Таңдау нақты жасалады: бірдей есімдер біріктірілмейді. Бір спортшы осы турнирде тек бір белсенді өтінімге ие бола алады.',
        )}
      </p>
      {loading && (
        <p className="field-note" role="status">
          {text('Ищем…', 'Ізделуде…')}
        </p>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}{' '}
          <button type="button" disabled={disabled} onClick={() => setRetry((value) => value + 1)}>
            {text('Повторить поиск', 'Қайта іздеу')}
          </button>
        </p>
      )}
      {!loading && !error && !results.length && (
        <p className="field-note">
          {text(
            'Совпадений в истории нет. Для нового спортсмена оставьте новую запись.',
            'Тарихта сәйкестік жоқ. Жаңа спортшы үшін жаңа жазбаны қалдырыңыз.',
          )}
        </p>
      )}
      <ul className="roster-athlete-results">
        {results.map((athlete) => {
          const registered = athlete.activeEntry && athlete.activeEntry.entryId !== currentEntryId;
          const inDraft = unavailableIds.includes(athlete.id);
          const selected = athlete.id === selectedId;
          return (
            <li key={athlete.id}>
              <AthleteDetails display={athlete.display} />
              {(registered || inDraft || selected) && (
                <span className="field-note">
                  {registered
                    ? `${text('Уже заявлен', 'Өтінімі бар')}: ${categories.find((value) => value.id === athlete.activeEntry?.categoryId)?.name ?? '—'}`
                    : inDraft
                      ? text('Уже выбран в другой строке', 'Басқа жолда таңдалған')
                      : text('Текущая привязка', 'Ағымдағы байланыс')}
                </span>
              )}
              <button
                type="button"
                disabled={disabled || !!registered || inDraft || selected}
                onClick={() => onSelect(athlete)}
                aria-label={`${text('Выбрать спортсмена', 'Спортшыны таңдау')}: ${athlete.display.lastName} ${athlete.display.firstName}`}
              >
                {text('Выбрать', 'Таңдау')}
              </button>
            </li>
          );
        })}
      </ul>
      {results.length === 20 && (
        <p className="field-note">
          {text(
            'Показаны первые 20 результатов. Уточните поиск.',
            'Алғашқы 20 нәтиже көрсетілген. Іздеуді нақтылаңыз.',
          )}
        </p>
      )}
    </div>
  );
}
