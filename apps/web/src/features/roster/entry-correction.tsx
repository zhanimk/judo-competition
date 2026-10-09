'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { ApiError, request } from '../tournaments/api';
import type { Tournament } from '../tournaments/types';
import {
  correctionRow,
  correctionSignature,
  correctionPreviewMatches,
  savedEntry,
  type CorrectionMode,
} from './entry-correction-model';
import { rosterMessage } from './messages';
import type { PendingRosterCommand } from './roster-command';
import { RosterEditor, type CheckedDraft } from './roster-editor';
import {
  entryInputs,
  rowErrors,
  type DraftRow,
  type EntryCorrectionPreview,
  type SavedEntry,
} from './roster-model';

type CorrectionCommand = Extract<PendingRosterCommand, { entryId: string }>;

function EntryDetails({ entry, tournament }: { entry: SavedEntry; tournament: Tournament }) {
  const { text } = useLanguage();
  const category = tournament.categories.find((value) => value.id === entry.categoryId);
  const gender = entry.gender ?? category?.gender;
  return (
    <dl className="roster-entry-details">
      <div>
        <dt>{text('Спортсмен', 'Спортшы')}</dt>
        <dd>
          {entry.lastName} {entry.firstName}
        </dd>
      </div>
      <div>
        <dt>{text('Год рождения', 'Туған жылы')}</dt>
        <dd>{entry.birthYear ?? '—'}</dd>
      </div>
      <div>
        <dt>{text('Пол', 'Жынысы')}</dt>
        <dd>
          {gender === 'MALE'
            ? text('Мужской', 'Ер')
            : gender === 'FEMALE'
              ? text('Женский', 'Әйел')
              : '—'}
        </dd>
      </div>
      <div>
        <dt>{text('Клуб', 'Клуб')}</dt>
        <dd>{entry.club || '—'}</dd>
      </div>
      <div>
        <dt>{text('Категория', 'Санат')}</dt>
        <dd>{category?.name ?? '—'}</dd>
      </div>
    </dl>
  );
}

export function EntryCorrection({
  tournament,
  entry,
  mode,
  pending,
  disabled,
  attempt,
  onDeliver,
  onClose,
  onUpdate,
}: {
  tournament: Tournament;
  entry: SavedEntry;
  mode: CorrectionMode;
  pending: CorrectionCommand | null;
  disabled: boolean;
  attempt: number;
  onDeliver: (command: CorrectionCommand) => Promise<void>;
  onClose: () => void;
  onUpdate: () => Promise<void>;
}) {
  const { text, locale } = useLanguage();
  const category = tournament.categories.find((value) => value.id === entry.categoryId);
  const initialRow = correctionRow(entry);
  if (!initialRow.gender && (category?.gender === 'MALE' || category?.gender === 'FEMALE'))
    initialRow.gender = category.gender;
  const [row, setRow] = useState<DraftRow>(() =>
    pending?.kind === 'update'
      ? {
          ...initialRow,
          firstName: pending.payload.firstName,
          lastName: pending.payload.lastName,
          categoryId: pending.payload.categoryId,
          gender: pending.payload.gender,
          duplicateConfirmed: pending.payload.duplicateConfirmed,
          birthYear: String(pending.payload.birthYear),
        }
      : { ...initialRow, duplicateConfirmed: pending?.payload.duplicateConfirmed ?? false },
  );
  const [clubId, setClubId] = useState(
    pending?.kind === 'update' ? pending.payload.clubId : (entry.clubId ?? ''),
  );
  const [reason, setReason] = useState(pending?.payload.reason ?? '');
  const [checked, setChecked] = useState<(CheckedDraft & { data: EntryCorrectionPreview }) | null>(
    null,
  );
  const [checking, setChecking] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [archiveConfirmed, setArchiveConfirmed] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const blocked = disabled || checking;
  const validReason = reason.trim().length >= 3 && reason.trim().length <= 500;
  const signature = correctionSignature(clubId, row, reason, tournament.rosterRevision);
  const previewCurrent =
    checked?.signature === signature && checked.data.revision === tournament.rosterRevision;
  const currentCategory = tournament.categories.find((value) =>
    value.entries?.some((value) => value.id === entry.id),
  );
  const currentEntry = currentCategory?.entries?.find((value) => value.id === entry.id);
  const currentSnapshot =
    currentCategory && currentEntry ? savedEntry(currentEntry, currentCategory) : null;

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
    setArchiveConfirmed(false);
  }, [tournament.rosterRevision, attempt]);

  function changeRow(next: DraftRow[]) {
    if (blocked || !next[0]) return;
    setRow(next[0]);
    setError('');
  }
  async function preview() {
    if (blocked) return;
    setShowValidation(true);
    setError('');
    if (!validReason || !clubId || rowErrors(row, tournament.categories).length) return;
    const requestGeneration = ++generation.current;
    const draft = structuredClone(row);
    const requestedSignature = signature;
    setChecking(true);
    try {
      const data = await request<EntryCorrectionPreview>(
        `/tournaments/${tournament.id}/roster/entries/${entry.id}/preview`,
        {
          clubId,
          ...entryInputs([draft])[0],
        },
      );
      if (
        !correctionPreviewMatches(
          data,
          entry,
          clubId,
          draft,
          mode === 'restore' ? 'restore' : 'update',
          category?.gender,
        )
      )
        throw new Error('ROSTER_RESPONSE_INVALID');
      if (mounted.current && requestGeneration === generation.current) {
        setChecked({ data, rows: [draft], signature: requestedSignature });
        if (data.revision !== tournament.rosterRevision) await onUpdate();
      }
    } catch (error) {
      if (mounted.current && requestGeneration === generation.current)
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
    if (blocked || !validReason) return;
    if (mode === 'archive') {
      if (!archiveConfirmed || !currentSnapshot) return;
      void onDeliver({
        tournamentId: tournament.id,
        kind: 'archive',
        entryId: entry.id,
        entrySnapshot: structuredClone(currentSnapshot),
        payload: {
          id: crypto.randomUUID(),
          expectedRevision: tournament.rosterRevision,
          reason: reason.trim(),
        },
      });
    } else {
      if (!checked?.data.canSave || !previewCurrent) return;
      if (mode === 'update')
        void onDeliver({
          tournamentId: tournament.id,
          kind: 'update',
          entryId: entry.id,
          entrySnapshot: structuredClone(checked.data.before),
          payload: {
            id: crypto.randomUUID(),
            expectedRevision: checked.data.revision,
            reason: reason.trim(),
            clubId,
            ...entryInputs([row])[0],
          },
        });
      else
        void onDeliver({
          tournamentId: tournament.id,
          kind: 'restore',
          entryId: entry.id,
          entrySnapshot: structuredClone(checked.data.before),
          payload: {
            id: crypto.randomUUID(),
            expectedRevision: checked.data.revision,
            reason: reason.trim(),
            duplicateConfirmed: !!row.duplicateConfirmed,
          },
        });
    }
  }

  return (
    <section
      className="panel roster-card roster-correction"
      aria-labelledby="entry-correction-heading"
    >
      <div className="roster-card-header">
        <div>
          <h2 id="entry-correction-heading" ref={heading} tabIndex={-1}>
            {mode === 'update'
              ? text('Исправить заявку', 'Өтінімді түзету')
              : mode === 'archive'
                ? text('Исключить из состава', 'Құрамнан шығару')
                : text('Восстановить заявку', 'Өтінімді қалпына келтіру')}
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
        {pending && (
          <p className="info-note">
            {text(
              'Ниже показана сохранённая команда. Повторите её кнопкой выше, чтобы узнать результат.',
              'Төменде сақталған команда көрсетілген. Нәтижесін білу үшін жоғарыдағы батырмамен қайталаңыз.',
            )}
          </p>
        )}
        {mode === 'archive' ? (
          <>
            <EntryDetails entry={currentSnapshot ?? entry} tournament={tournament} />
            <p className="info-note">
              {text(
                'Участник будет исключён из активного состава. Запись сохранится в архиве и её можно восстановить. Если предварительная сетка категории уже сформирована, её нужно будет сформировать заново.',
                'Қатысушы белсенді құрамнан шығарылады. Жазба мұрағатта сақталып, оны қалпына келтіруге болады. Санаттың алдын ала торы құрылған болса, оны қайта құру қажет болады.',
              )}
            </p>
            {!currentSnapshot && !pending && (
              <p className="error-box" role="alert">
                {rosterMessage('ENTRY_ARCHIVED', locale === 'kk')}
              </p>
            )}
          </>
        ) : (
          <>
            {mode === 'restore' && (
              <p className="info-note">
                {text(
                  'Восстанавливаются исходные данные и та же заявка. После восстановления их можно исправить отдельно.',
                  'Бастапқы деректер мен сол өтінім қалпына келтіріледі. Қалпына келтірген соң оларды бөлек түзетуге болады.',
                )}
              </p>
            )}
            <label className="roster-correction-club">
              {text('Клуб турнира', 'Турнир клубы')}
              <select
                disabled={blocked || mode === 'restore'}
                value={clubId}
                onChange={(event) => {
                  setClubId(event.target.value);
                  setRow({ ...row, duplicateConfirmed: false });
                  setChecked(null);
                }}
              >
                <option value="">{text('Выберите клуб', 'Клубты таңдаңыз')}</option>
                {tournament.clubs.map((club) => (
                  <option key={club.id} value={club.id}>
                    {club.name}
                  </option>
                ))}
              </select>
            </label>
            {!clubId && (showValidation || mode === 'restore') && (
              <p className="error-box" role="alert">
                {rosterMessage(
                  mode === 'restore' ? 'ENTRY_CLUB_UNRESOLVED' : 'CLUB_NOT_FOUND',
                  locale === 'kk',
                )}
              </p>
            )}
            <RosterEditor
              rows={[row]}
              categories={tournament.categories}
              checked={checked}
              disabled={blocked}
              readonlyFields={mode === 'restore'}
              allowRemove={false}
              showValidation={showValidation}
              onChange={changeRow}
            />
          </>
        )}
        <label className="roster-correction-reason">
          {text('Причина изменения', 'Өзгерту себебі')}
          <textarea
            rows={3}
            maxLength={500}
            disabled={blocked}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setArchiveConfirmed(false);
            }}
            placeholder={text(
              'Укажите причину: от 3 до 500 символов',
              'Себебін көрсетіңіз: 3–500 таңба',
            )}
          />
          <span className="field-note">
            {text(
              'Причина сохранится в истории изменения состава.',
              'Себеп құрам өзгерістері тарихында сақталады.',
            )}
          </span>
        </label>
        {showValidation && !validReason && (
          <p className="error-box" role="alert">
            {rosterMessage('REASON_REQUIRED', locale === 'kk')}
          </p>
        )}
        {mode === 'archive' && (
          <label className="roster-checkbox roster-archive-confirm">
            <input
              type="checkbox"
              disabled={blocked || !currentSnapshot}
              checked={archiveConfirmed}
              onChange={(event) => setArchiveConfirmed(event.target.checked)}
            />
            {text(
              'Подтверждаю исключение этого участника из активного состава.',
              'Осы қатысушыны белсенді құрамнан шығаруды растаймын.',
            )}
          </label>
        )}
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        {checked && (
          <div className="roster-correction-preview">
            <div className="roster-before-after">
              <div>
                <h3>{text('Было', 'Бұрын')}</h3>
                <EntryDetails entry={checked.data.before} tournament={tournament} />
              </div>
              <div>
                <h3>
                  {mode === 'restore'
                    ? text('После восстановления', 'Қалпына келгеннен кейін')
                    : text('Будет', 'Кейін')}{' '}
                </h3>
                <EntryDetails entry={checked.data.proposed} tournament={tournament} />
              </div>
            </div>
            {!!checked.data.invalidatedCategoryIds.length && (
              <p className="info-note">
                {text(
                  'Нужно заново сформировать предварительные сетки:',
                  'Алдын ала торларды қайта құру қажет:',
                )}{' '}
                {checked.data.invalidatedCategoryIds
                  .map(
                    (id) =>
                      tournament.categories.find((category) => category.id === id)?.name ?? id,
                  )
                  .join(', ')}
              </p>
            )}
            <p className="field-note" role="status">
              {!previewCurrent
                ? text(
                    'Данные или причина изменились. Повторите проверку.',
                    'Деректер не себеп өзгерді. Қайта тексеріңіз.',
                  )
                : checked.data.canSave
                  ? text(
                      'Изменение проверено. Подтвердите его сохранение.',
                      'Өзгеріс тексерілді. Сақтауды растаңыз.',
                    )
                  : text(
                      'Исправьте ошибки или подтвердите совпадения, затем повторите проверку.',
                      'Қателерді түзетіңіз не сәйкестіктерді растаңыз, содан кейін қайта тексеріңіз.',
                    )}
            </p>
          </div>
        )}
        <div className="roster-actions">
          {mode !== 'archive' && (
            <button type="button" disabled={blocked} onClick={() => void preview()}>
              {checking
                ? text('Проверяем…', 'Тексерілуде…')
                : text('Предпросмотр изменения', 'Өзгерісті алдын ала қарау')}
            </button>
          )}
          <button
            type="button"
            className="solid-button"
            disabled={
              blocked ||
              !validReason ||
              (mode === 'archive'
                ? !archiveConfirmed || !currentSnapshot
                : !checked?.data.canSave || !previewCurrent)
            }
            onClick={commit}
          >
            {mode === 'update'
              ? text('Сохранить исправление', 'Түзетуді сақтау')
              : mode === 'archive'
                ? text('Исключить участника', 'Қатысушыны шығару')
                : text('Восстановить участника', 'Қатысушыны қалпына келтіру')}
          </button>
        </div>
      </div>
    </section>
  );
}
