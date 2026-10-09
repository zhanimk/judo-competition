'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { ApiError, request } from '../tournaments/api';
import type { Tournament } from '../tournaments/types';
import {
  identityPreviewMatches,
  identitySignature,
  type AthleteCandidate,
  type EntryIdentityPreview,
} from './athlete-model';
import { AthleteDetails, AthletePicker } from './athlete-picker';
import { EntryDetails } from './entry-correction';
import { rosterMessage } from './messages';
import type { PendingRosterCommand } from './roster-command';
import type { SavedEntry } from './roster-model';

type IdentityCommand = Extract<PendingRosterCommand, { kind: 'identity' }>;
export function EntryIdentity({
  tournament,
  entry,
  pending,
  disabled,
  attempt,
  onDeliver,
  onClose,
  onUpdate,
}: {
  tournament: Tournament;
  entry: SavedEntry;
  pending: IdentityCommand | null;
  disabled: boolean;
  attempt: number;
  onDeliver: (command: IdentityCommand) => Promise<void>;
  onClose: () => void;
  onUpdate: () => Promise<void>;
}) {
  const { text, locale } = useLanguage();
  const [selected, setSelected] = useState<{
    id: string;
    display: AthleteCandidate['display'];
  } | null>(pending?.athleteSnapshot ?? null);
  const [searching, setSearching] = useState(!pending);
  const [reason, setReason] = useState(pending?.payload.reason ?? '');
  const [checked, setChecked] = useState<{ data: EntryIdentityPreview; signature: string } | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [showValidation, setShowValidation] = useState(false);
  const mounted = useRef(false),
    generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const blocked = disabled || checking;
  const validReason = reason.trim().length >= 3 && reason.trim().length <= 500;
  const signature = identitySignature(selected?.id ?? '', reason, tournament.rosterRevision);
  const current =
    checked?.signature === signature && checked.data.revision === tournament.rosterRevision;
  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    return () => {
      mounted.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setChecked(null);
  }, [tournament.rosterRevision, attempt]);
  async function preview() {
    if (blocked) return;
    setShowValidation(true);
    setError('');
    if (!validReason || !selected) return;
    const readGeneration = ++generation.current;
    const requestedSignature = signature;
    setChecking(true);
    try {
      const data = await request<EntryIdentityPreview>(
        `/tournaments/${tournament.id}/roster/entries/${entry.id}/identity/preview`,
        { athleteId: selected.id },
      );
      if (!identityPreviewMatches(data, entry.id, selected.id))
        throw new Error('ROSTER_RESPONSE_INVALID');
      if (mounted.current && readGeneration === generation.current) {
        setChecked({ data, signature: requestedSignature });
        if (data.revision !== tournament.rosterRevision) await onUpdate();
      }
    } catch (error) {
      if (mounted.current && readGeneration === generation.current)
        setError(
          rosterMessage(
            error instanceof ApiError && error.status < 500
              ? error.message
              : error instanceof Error && error.message === 'ROSTER_RESPONSE_INVALID'
                ? error.message
                : 'PREVIEW_FAILED',
            locale === 'kk',
          ),
        );
    } finally {
      if (mounted.current) setChecking(false);
    }
  }
  function commit() {
    if (blocked || !validReason || !current || !checked?.data.canSave) return;
    void onDeliver({
      tournamentId: tournament.id,
      kind: 'identity',
      entryId: entry.id,
      entrySnapshot: structuredClone(checked.data.before),
      athleteSnapshot: structuredClone(checked.data.athlete),
      payload: {
        id: crypto.randomUUID(),
        expectedRevision: checked.data.revision,
        athleteId: checked.data.athlete.id,
        reason: reason.trim(),
      },
    });
  }
  return (
    <section
      className="panel roster-card roster-correction"
      aria-labelledby="entry-identity-heading"
    >
      <div className="roster-card-header">
        <div>
          <h2 id="entry-identity-heading" ref={heading} tabIndex={-1}>
            {text('Исправить связь со спортсменом', 'Спортшымен байланысты түзету')}
          </h2>
          <p className="field-note">
            {entry.lastName} {entry.firstName}
          </p>
        </div>
        <button type="button" disabled={checking || !!pending} onClick={onClose}>
          {text('Закрыть', 'Жабу')}
        </button>
      </div>
      <div className="roster-card-body">
        <p className="info-note">
          {text(
            'Меняется только связь со спортсменом. ФИО, год, пол, клуб, категория и ID этой заявки остаются прежними. Один спортсмен — одна активная заявка в турнире. Совпадение имён не означает одного человека.',
            'Тек спортшымен байланыс өзгереді. Осы өтінімнің аты-жөні, жылы, жынысы, клубы, санаты және ID-і өзгермейді. Бір спортшы — турнирдегі бір белсенді өтінім. Есімдердің сәйкестігі бір адамды білдірмейді.',
          )}
        </p>
        {pending && (
          <p className="info-note">
            {text(
              'Показана сохранённая команда. Узнайте её результат кнопкой повтора выше.',
              'Сақталған команда көрсетілген. Жоғарыдағы қайталау батырмасымен нәтижесін тексеріңіз.',
            )}
          </p>
        )}
        <div className="roster-before-after">
          <div>
            <h3>{text('Эта заявка', 'Осы өтінім')}</h3>
            <EntryDetails entry={checked?.data.before ?? entry} tournament={tournament} />
          </div>
          <div>
            <h3>{text('Выбранный спортсмен из истории', 'Тарихтан таңдалған спортшы')}</h3>
            {selected ? (
              <AthleteDetails display={checked?.data.athlete.display ?? selected.display} />
            ) : (
              <p className="field-note">
                {text('Выберите спортсмена явно.', 'Спортшыны нақты таңдаңыз.')}
              </p>
            )}
          </div>
        </div>
        {!searching && !pending && (
          <button type="button" disabled={blocked} onClick={() => setSearching(true)}>
            {text('Выбрать другого спортсмена', 'Басқа спортшыны таңдау')}
          </button>
        )}
        {searching && !pending && (
          <AthletePicker
            tournamentId={tournament.id}
            categories={tournament.categories}
            disabled={blocked}
            selectedId={selected?.id ?? entry.athleteId}
            currentEntryId={entry.id}
            onClose={() => setSearching(false)}
            onSelect={(athlete) => {
              setSelected({ id: athlete.id, display: athlete.display });
              setSearching(false);
              setChecked(null);
              setError('');
            }}
          />
        )}
        <label className="roster-correction-reason">
          {text('Причина изменения связи', 'Байланысты өзгерту себебі')}
          <textarea
            rows={3}
            maxLength={500}
            value={reason}
            disabled={blocked}
            onChange={(event) => setReason(event.target.value)}
            placeholder={text('Причина: 3–500 символов', 'Себебі: 3–500 таңба')}
          />
        </label>
        {showValidation && !validReason && (
          <p className="error-box" role="alert">
            {rosterMessage('REASON_REQUIRED', locale === 'kk')}
          </p>
        )}
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        {checked && (
          <>
            <p className="info-note">
              {text(
                'Предпросмотр: данные этой и прежних заявок не меняются; изменится только связь с выбранным спортсменом.',
                'Алдын ала қарау: осы және бұрынғы өтінімдердің деректері өзгермейді; тек таңдалған спортшымен байланыс өзгереді.',
              )}
            </p>
            {!!checked.data.errors.length && (
              <ul className="roster-errors" role="alert">
                {checked.data.errors.map((code) => (
                  <li key={code}>{rosterMessage(code, locale === 'kk')}</li>
                ))}
              </ul>
            )}
            {!!checked.data.invalidatedCategoryIds.length && (
              <p className="info-note">
                {text(
                  'Предварительные сетки потребуется сформировать заново:',
                  'Алдын ала торларды қайта құру қажет:',
                )}{' '}
                {checked.data.invalidatedCategoryIds
                  .map((id) => tournament.categories.find((value) => value.id === id)?.name ?? id)
                  .join(', ')}
              </p>
            )}
            <p className="field-note" role="status">
              {!current
                ? text(
                    'После изменений нужна повторная проверка.',
                    'Өзгерістен кейін қайта тексеру қажет.',
                  )
                : checked.data.canSave
                  ? text(
                      'Связь проверена. Подтвердите сохранение.',
                      'Байланыс тексерілді. Сақтауды растаңыз.',
                    )
                  : text(
                      'Связь не может быть сохранена. Проверьте ошибки.',
                      'Байланысты сақтау мүмкін емес. Қателерді тексеріңіз.',
                    )}
            </p>
          </>
        )}
        <div className="roster-actions">
          <button type="button" disabled={blocked || !selected} onClick={() => void preview()}>
            {checking
              ? text('Проверяем…', 'Тексерілуде…')
              : text('Предпросмотр связи', 'Байланысты алдын ала қарау')}
          </button>
          <button
            type="button"
            className="solid-button"
            disabled={blocked || !validReason || !current || !checked?.data.canSave}
            onClick={commit}
          >
            {text('Сохранить связь', 'Байланысты сақтау')}
          </button>
        </div>
      </div>
    </section>
  );
}
