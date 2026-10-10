'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import type { Tournament } from '../tournaments/types';
import {
  canCorrectEntryName,
  nameCorrectionErrors,
  nameReviewMatches,
  normalizeEntryName,
  reviewEntryName,
  savedNameEntry,
  type NameReview,
} from './entry-name-model';
import { rosterMessage } from './messages';
import type { PendingRosterCommand } from './roster-command';
import type { SavedEntry } from './roster-model';

type NameCommand = Extract<PendingRosterCommand, { kind: 'name' }>;
export function EntryName({
  tournament,
  entry,
  pending,
  disabled,
  attempt,
  onDeliver,
  onClose,
}: {
  tournament: Tournament;
  entry: SavedEntry;
  pending: NameCommand | null;
  disabled: boolean;
  attempt: number;
  onDeliver: (command: NameCommand) => Promise<void>;
  onClose: () => void;
}) {
  const { text, locale } = useLanguage();
  const [firstName, setFirstName] = useState(pending?.payload.firstName ?? entry.firstName);
  const [lastName, setLastName] = useState(pending?.payload.lastName ?? entry.lastName);
  const [reason, setReason] = useState(pending?.payload.reason ?? '');
  const [review, setReview] = useState<NameReview | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const category = tournament.categories.find((value) => value.id === entry.categoryId);
  const latest = category?.entries?.find((value) => value.id === entry.id);
  const currentEntry = latest && category ? savedNameEntry(latest, category) : null;
  const before = pending?.entrySnapshot ?? currentEntry ?? entry;
  const available = !!currentEntry && canCorrectEntryName(tournament, currentEntry);
  const blocked = disabled || !!pending || !available;
  const errors = nameCorrectionErrors(before, firstName, lastName, reason);
  const reviewed = nameReviewMatches(
    review,
    before,
    firstName,
    lastName,
    reason,
    tournament.rosterRevision,
  );
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    setReview(null);
  }, [attempt]);

  function check() {
    if (blocked) return;
    setShowErrors(true);
    setReview(reviewEntryName(before, firstName, lastName, reason, tournament.rosterRevision));
  }
  function commit() {
    if (blocked || !reviewed || !review || errors.length) return;
    void onDeliver({
      kind: 'name',
      tournamentId: tournament.id,
      entryId: review.before.id,
      entrySnapshot: structuredClone(review.before),
      payload: {
        id: crypto.randomUUID(),
        expectedRevision: review.revision,
        firstName: review.firstName,
        lastName: review.lastName,
        reason: review.reason,
      },
    });
  }

  return (
    <section className="panel roster-card roster-name" aria-labelledby="entry-name-heading">
      <div className="roster-card-header">
        <div>
          <h2 id="entry-name-heading" ref={heading} tabIndex={-1}>
            {text('Исправить ФИО', 'Аты-жөнін түзету')}
          </h2>
          <p className="field-note">
            {category?.name ?? entry.categoryId} · {before.club}
          </p>
        </div>
        <button type="button" disabled={disabled || !!pending} onClick={onClose}>
          {text('Закрыть', 'Жабу')}
        </button>
      </div>
      <div className="roster-card-body">
        <p className="info-note">
          {text(
            'Исправление относится только к этому турниру. Связь со спортсменом, категория, клуб, встречи и результаты сохраняются. Исправленные имена появятся в табло, сетках, публичных списках и новых PDF.',
            'Түзету тек осы турнирге қатысты. Спортшымен байланыс, санат, клуб, кездесулер және нәтижелер сақталады. Түзетілген есімдер таблода, торларда, ашық тізімдерде және жаңа PDF-терде көрсетіледі.',
          )}
        </p>
        {pending && (
          <p className="info-note">
            {text(
              'Показано сохранённое исправление. Проверьте его результат кнопкой повтора выше; исходную команду можно скачать.',
              'Сақталған түзету көрсетілген. Жоғарыдағы қайталау батырмасымен нәтижесін тексеріңіз; бастапқы команданы жүктеп алуға болады.',
            )}
          </p>
        )}
        {!available && !pending && (
          <p className="error-box" role="alert">
            {rosterMessage('NAME_CORRECTION_NOT_ALLOWED', locale === 'kk')}
          </p>
        )}
        <div className="roster-name-fields">
          <label>
            {text('Фамилия', 'Тегі')}
            <input
              value={lastName}
              maxLength={80}
              autoComplete="off"
              disabled={blocked}
              onChange={(event) => setLastName(event.target.value)}
            />
          </label>
          <label>
            {text('Имя', 'Аты')}
            <input
              value={firstName}
              maxLength={80}
              autoComplete="off"
              disabled={blocked}
              onChange={(event) => setFirstName(event.target.value)}
            />
          </label>
        </div>
        <div className="roster-before-after roster-name-review">
          <div>
            <h3>{text('Сейчас', 'Қазір')}</h3>
            <p>
              {before.lastName} {before.firstName}
            </p>
          </div>
          <div>
            <h3>{text('После исправления', 'Түзетілгеннен кейін')}</h3>
            <p>
              {normalizeEntryName(lastName) || '—'} {normalizeEntryName(firstName) || '—'}
            </p>
          </div>
        </div>
        <label className="roster-correction-reason">
          {text('Причина исправления ФИО', 'Аты-жөнін түзету себебі')}
          <textarea
            value={reason}
            rows={3}
            maxLength={500}
            disabled={blocked}
            onChange={(event) => setReason(event.target.value)}
            placeholder={text(
              'Например, опечатка в фамилии. 3–500 символов.',
              'Мысалы, тегіндегі қате. 3–500 таңба.',
            )}
          />
        </label>
        {showErrors && !!errors.length && (
          <ul className="roster-errors" role="alert">
            {errors.map((code) => (
              <li key={code}>{rosterMessage(code, locale === 'kk')}</li>
            ))}
          </ul>
        )}
        {review && !pending && (
          <p className="field-note" role="status">
            {reviewed
              ? text(
                  'Сверьте имя до и после, затем сохраните исправление.',
                  'Бастапқы және түзетілген аты-жөнін салыстырып, түзетуді сақтаңыз.',
                )
              : text(
                  'Данные изменились. Повторно проверьте исправление перед сохранением.',
                  'Деректер өзгерді. Сақтау алдында түзетуді қайта тексеріңіз.',
                )}
          </p>
        )}
        <div className="roster-actions">
          <button type="button" disabled={blocked} onClick={check}>
            {text('Проверить исправление', 'Түзетуді тексеру')}
          </button>
          <button
            type="button"
            className="solid-button"
            disabled={blocked || !reviewed || !!errors.length}
            onClick={commit}
          >
            {text('Сохранить ФИО', 'Аты-жөнін сақтау')}
          </button>
        </div>
      </div>
    </section>
  );
}
