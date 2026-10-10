'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { ApiError, request } from '../tournaments/api';
import type { Tournament } from '../tournaments/types';
import { EntryCorrection } from './entry-correction';
import { EntryIdentity } from './entry-identity';
import { EntryName } from './entry-name';
import { canCorrectEntryName } from './entry-name-model';
import type { CorrectionMode } from './entry-correction-model';
import { rosterMessage } from './messages';
import {
  clearPendingRoster,
  deliverRosterCommand,
  readPendingRoster,
  pendingRosterJson,
  savePendingRoster,
  type PendingRosterCommand,
} from './roster-command';
import { RosterEditor, type CheckedDraft } from './roster-editor';
import {
  blankRow,
  entryInputs,
  previewMatchesDraft,
  removeSubmittedDraft,
  rowErrors,
  rowsSignature,
  validRosterPreview,
  type DraftRow,
  type Receipt,
  type RosterPreview,
  type SavedEntry,
} from './roster-model';
import { parseRosterText } from './roster-parser';
import {
  readRosterDraft,
  readRosterPaste,
  saveRosterDraft,
  saveRosterPaste,
  selectionKey,
} from './roster-storage';
import { SavedRoster } from './saved-roster';
import './roster.css';

export function ClubRoster({
  tournament,
  onUpdate,
  onCommitted,
  onPendingChange,
}: {
  tournament: Tournament;
  onUpdate: () => Promise<void>;
  onCommitted: (receipt: Receipt) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const { text, locale } = useLanguage();
  const [selectedClubId, setSelectedClubId] = useState('');
  const [clubName, setClubName] = useState('');
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [checked, setChecked] = useState<CheckedDraft | null>(null);
  const [pending, setPending] = useState<PendingRosterCommand | null>(null);
  const [correction, setCorrection] = useState<{
    entry: SavedEntry;
    mode: CorrectionMode | 'identity' | 'name';
  } | null>(null);
  const [correctionAttempt, setCorrectionAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<{
    kind: PendingRosterCommand['kind'];
    count: number;
    invalidated: boolean;
  } | null>(null);
  const [paste, setPaste] = useState('');
  const [pasteIssues, setPasteIssues] = useState<{ line: number; code: string }[]>([]);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const locked = tournament.status !== 'DRAFT';
  const mutationDisabled = !ready || busy || !!pending || storageBlocked;
  const deliveryDisabled = mutationDisabled || locked;
  const disabled = deliveryDisabled || !!correction;
  const selectedClub = tournament.clubs.find((club) => club.id === selectedClubId);
  const previewCurrent = previewMatchesDraft(checked, rows, tournament.rosterRevision);
  const sayError = (code: string) => setError(rosterMessage(code, locale === 'kk'));
  const noticeText = notice
    ? {
        club: text('Клуб создан. Теперь внесите состав.', 'Клуб құрылды. Енді құрамын енгізіңіз.'),
        roster: text(
          `Состав сохранён: ${notice.count} спортсменов. Можно добавить следующих.`,
          `Құрам сақталды: ${notice.count} спортшы. Келесілерін қосуға болады.`,
        ),
        update: text('Исправление заявки сохранено.', 'Өтінім түзетуі сақталды.'),
        name: text('ФИО исправлено в этом турнире.', 'Осы турнирде аты-жөні түзетілді.'),
        identity: text(
          'Связь заявки со спортсменом исправлена; данные заявки сохранены.',
          'Өтінімнің спортшымен байланысы түзетілді; өтінім деректері сақталды.',
        ),
        archive: text(
          'Участник исключён из состава. Заявка доступна в архиве для восстановления.',
          'Қатысушы құрамнан шығарылды. Өтінімді мұрағаттан қалпына келтіруге болады.',
        ),
        restore: text(
          'Исходная заявка восстановлена в составе.',
          'Бастапқы өтінім құрамда қалпына келтірілді.',
        ),
      }[notice.kind] +
      (notice.invalidated
        ? text(
            ' Предварительные сетки затронутых категорий нужно сформировать заново.',
            ' Тиісті санаттардың алдын ала торларын қайта құру қажет.',
          )
        : '')
    : '';

  useEffect(() => {
    mounted.current = true;
    try {
      const command = readPendingRoster(sessionStorage, tournament.id);
      const selection =
        command?.kind === 'roster'
          ? command.payload.clubId
          : (sessionStorage.getItem(selectionKey(tournament.id)) ?? '');
      setSelectedClubId(selection);
      setPaste(selection ? readRosterPaste(sessionStorage, tournament.id, selection) : '');
      setRows(
        command?.kind === 'roster'
          ? command.draftRows
          : selection
            ? readRosterDraft(sessionStorage, tournament.id, selection)
            : [],
      );
      if (command?.kind === 'club') setClubName(command.payload.name);
      if (command && 'entryId' in command)
        setCorrection({ entry: command.entrySnapshot, mode: command.kind });
      setPending(command);
      onPendingChange(!!command);
    } catch (error) {
      setStorageBlocked(true);
      setError(
        rosterMessage(
          (error as Error).message === 'ROSTER_STORAGE_INVALID'
            ? 'ROSTER_STORAGE_INVALID'
            : 'STORAGE_FAILED',
          locale === 'kk',
        ),
      );
      onPendingChange(true);
    }
    setReady(true);
    return () => {
      mounted.current = false;
    };
  }, [tournament.id, onPendingChange]);

  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);

  function storageFailure(error: unknown) {
    setStorageBlocked(true);
    onPendingChange(true);
    sayError(
      (error as Error).message === 'ROSTER_STORAGE_INVALID'
        ? 'ROSTER_STORAGE_INVALID'
        : 'STORAGE_FAILED',
    );
  }
  function selectClub(id: string) {
    if (pending || busy || storageBlocked || correction) return;
    try {
      const restored = id ? readRosterDraft(sessionStorage, tournament.id, id) : [];
      sessionStorage.setItem(selectionKey(tournament.id), id);
      setSelectedClubId(id);
      setRows(restored);
      setChecked(null);
      setShowValidation(false);
      setPaste(id ? readRosterPaste(sessionStorage, tournament.id, id) : '');
      setPasteIssues([]);
      setError('');
      setNotice(null);
    } catch (error) {
      storageFailure(error);
    }
  }
  function editRows(next: DraftRow[]) {
    if (disabled) return false;
    try {
      saveRosterDraft(sessionStorage, tournament.id, selectedClubId, next);
      setRows(next);
      setError('');
      setNotice(null);
      return true;
    } catch (error) {
      storageFailure(error);
      return false;
    }
  }
  function editPaste(value: string, keepIssues = false) {
    if (disabled) return;
    try {
      saveRosterPaste(sessionStorage, tournament.id, selectedClubId, value);
      setPaste(value);
      if (!keepIssues) setPasteIssues([]);
    } catch (error) {
      storageFailure(error);
    }
  }
  async function refresh() {
    await onUpdate();
  }
  async function refreshAfterDelivery() {
    try {
      await refresh();
    } catch {
      if (mounted.current) sayError('REFRESH_FAILED');
    }
  }
  function openCorrection(entry: SavedEntry, mode: CorrectionMode | 'identity' | 'name') {
    if (
      mutationDisabled ||
      correction ||
      (mode === 'name' ? !canCorrectEntryName(tournament, entry) : locked)
    )
      return;
    setCorrection({ entry: structuredClone(entry), mode });
    setError('');
    setNotice(null);
  }
  function downloadPending() {
    try {
      const raw = pendingRosterJson(sessionStorage, tournament.id);
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `roster-command-${pending?.payload.id ?? tournament.id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      storageFailure(error);
    }
  }

  async function deliver(command: PendingRosterCommand) {
    if (busyRef.current || storageBlocked) return;
    try {
      savePendingRoster(sessionStorage, command);
    } catch (error) {
      storageFailure(error);
      return;
    }
    setPending(command);
    onPendingChange(true);
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice(null);
    try {
      const result = await deliverRosterCommand(command, (path, payload) =>
        request<Receipt>(path, payload),
      );
      if (result.kind === 'retry') {
        if (mounted.current) sayError('NETWORK_RETRY');
        return;
      }
      if (result.kind === 'success') {
        // Clear the submitted draft before the command. A failed cleanup keeps its receipt retryable.
        if (command.kind === 'roster') {
          const draft = readRosterDraft(sessionStorage, tournament.id, command.payload.clubId);
          const remaining = removeSubmittedDraft(draft, command.draftRows);
          saveRosterDraft(sessionStorage, tournament.id, command.payload.clubId, remaining);
          if (mounted.current) setRows(remaining.length ? remaining : [blankRow()]);
        }
        clearPendingRoster(sessionStorage, command);
        if (mounted.current) {
          onCommitted(result.receipt);
          if (command.kind === 'club' && 'club' in result.receipt) {
            sessionStorage.setItem(selectionKey(tournament.id), result.receipt.club.id);
            setSelectedClubId(result.receipt.club.id);
            setRows(readRosterDraft(sessionStorage, tournament.id, result.receipt.club.id));
            setClubName('');
          }
          setPending(null);
          onPendingChange(false);
          setChecked(null);
          setPasteIssues([]);
          setShowValidation(false);
          if ('entryId' in command) setCorrection(null);
          setNotice({
            kind: command.kind,
            count: command.kind === 'roster' ? command.payload.entries.length : 0,
            invalidated:
              'invalidatedCategoryIds' in result.receipt &&
              !!result.receipt.invalidatedCategoryIds?.length,
          });
          await refreshAfterDelivery();
        }
      } else {
        clearPendingRoster(sessionStorage, command);
        if (mounted.current) {
          setPending(null);
          onPendingChange(false);
          setChecked(null);
          setCorrectionAttempt((value) => value + 1);
          sayError((result.error as Error).message);
          await refreshAfterDelivery();
        }
      }
    } catch (error) {
      if (mounted.current) storageFailure(error);
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function createClub(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || clubName.trim().length < 2 || clubName.trim().length > 120) return;
    void deliver({
      tournamentId: tournament.id,
      kind: 'club',
      payload: {
        id: crypto.randomUUID(),
        expectedRevision: tournament.rosterRevision,
        name: clubName.trim(),
      },
    });
  }
  async function checkRoster() {
    if (disabled || busyRef.current || !selectedClub || !rows.length) return;
    setShowValidation(true);
    setChecked(null);
    setNotice(null);
    setError('');
    if (rows.some((row) => rowErrors(row, tournament.categories).length)) return;
    busyRef.current = true;
    setBusy(true);
    const draft = structuredClone(rows);
    try {
      const data = await request<RosterPreview>(`/tournaments/${tournament.id}/roster/preview`, {
        clubId: selectedClubId,
        entries: entryInputs(draft),
      });
      if (!validRosterPreview(data, draft.length)) throw new Error('ROSTER_RESPONSE_INVALID');
      if (mounted.current) {
        setChecked({ data, rows: draft, signature: rowsSignature(draft) });
        if (data.revision !== tournament.rosterRevision) await refresh();
      }
    } catch (error) {
      if (mounted.current)
        sayError(
          error instanceof ApiError && error.status < 500 ? error.message : 'PREVIEW_FAILED',
        );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function saveRoster() {
    if (disabled || !selectedClub || !checked?.data.canSave || !previewCurrent) return;
    void deliver({
      tournamentId: tournament.id,
      kind: 'roster',
      draftRows: structuredClone(rows),
      payload: {
        id: crypto.randomUUID(),
        expectedRevision: checked.data.revision,
        clubId: selectedClubId,
        entries: entryInputs(rows),
      },
    });
  }
  function appendText() {
    if (disabled || !selectedClub) return;
    const parsed = parseRosterText(paste, tournament.categories);
    setPasteIssues(parsed.issues);
    if (parsed.fatal || !parsed.rows.length) return;
    const existing = rows.filter(
      (row) => row.firstName || row.lastName || row.birthYear || row.gender || row.categoryId,
    );
    if (existing.length + parsed.rows.length > 500) {
      setPasteIssues([{ line: 0, code: 'BATCH_LIMIT' }]);
      return;
    }
    if (!editRows([...existing, ...parsed.rows])) return;
    setShowValidation(true);
    editPaste('', true);
  }

  return (
    <div className="club-roster">
      <section className="panel roster-card roster-setup">
        <div className="roster-card-header">
          <div>
            <h2>{text('Участники по клубам', 'Клубтар бойынша қатысушылар')}</h2>
            <p className="field-note">
              {text(
                'Выберите клуб один раз и внесите всю команду. Категорию каждого спортсмена укажите явно. Вносите уже прошедших взвешивание участников.',
                'Клубты бір рет таңдап, бүкіл команданы енгізіңіз. Әр спортшының санатын нақты көрсетіңіз. Өлшеуден өткен қатысушыларды енгізіңіз.',
              )}
            </p>
          </div>
        </div>
        <div className="roster-card-body">
          {!tournament.categories.length && !locked && (
            <p className="info-note">
              {text(
                'Сначала добавьте категории в разделе «Категории», затем выберите их для спортсменов.',
                'Алдымен «Санаттар» бөлімінде санаттарды қосыңыз, содан кейін спортшылар үшін таңдаңыз.',
              )}
            </p>
          )}
          <div className="roster-setup-fields">
            <label>
              {text('Клуб турнира', 'Турнир клубы')}
              <select
                value={selectedClubId}
                disabled={!ready || busy || !!pending || storageBlocked || !!correction}
                onChange={(event) => selectClub(event.target.value)}
              >
                <option value="">{text('Выберите клуб', 'Клубты таңдаңыз')}</option>
                {selectedClubId && !selectedClub && (
                  <option value={selectedClubId} disabled>
                    {text('Клуб недоступен', 'Клуб қолжетімсіз')}
                  </option>
                )}
                {tournament.clubs.map((club) => (
                  <option key={club.id} value={club.id}>
                    {club.name} · {club._count.entries}
                  </option>
                ))}
              </select>
            </label>
            <form className="roster-new-club" onSubmit={createClub}>
              <label>
                {text('Новый клуб', 'Жаңа клуб')}
                <input
                  value={clubName}
                  required
                  minLength={2}
                  maxLength={120}
                  disabled={disabled}
                  placeholder={text('Точное название клуба', 'Клубтың нақты атауы')}
                  onChange={(event) => setClubName(event.target.value)}
                />
              </label>
              <button type="submit" disabled={disabled || clubName.trim().length < 2}>
                {text('Создать клуб', 'Клуб құру')}
              </button>
            </form>
          </div>
          {locked && (
            <p className="info-note">
              {rosterMessage('ROSTER_LOCKED', locale === 'kk')}{' '}
              {text(
                'ФИО можно исправить в сохранённых заявках ниже.',
                'Төмендегі сақталған өтінімдерде аты-жөнін түзетуге болады.',
              )}
            </p>
          )}
          {error && (
            <p className="error-box" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="info-note" role="status">
              {noticeText}
            </p>
          )}
          {pending && (
            <div className="roster-pending" role="status">
              <p>
                {text(
                  'Есть сохранённая команда с неизвестным результатом. Пока она не проверена, новые изменения состава не отправляются.',
                  'Нәтижесі белгісіз сақталған команда бар. Ол тексерілмейінше құрамның жаңа өзгерістері жіберілмейді.',
                )}
              </p>
              <button
                className="solid-button"
                type="button"
                disabled={busy || storageBlocked}
                onClick={() => void deliver(pending)}
              >
                {busy
                  ? text('Проверяем…', 'Тексерілуде…')
                  : text('Повторить сохранённую команду', 'Сақталған команданы қайталау')}
              </button>
              {pending.kind === 'name' && (
                <button type="button" onClick={downloadPending}>
                  {text('Скачать исходную команду', 'Бастапқы команданы жүктеу')}
                </button>
              )}
            </div>
          )}
          {storageBlocked && (
            <button type="button" onClick={() => window.location.reload()}>
              {text('Повторно открыть сохранённые данные', 'Сақталған деректерді қайта ашу')}
            </button>
          )}
        </div>
      </section>
      {selectedClub && !correction && (
        <section className="panel roster-card roster-draft">
          <div className="roster-card-header">
            <h2>
              {text('Добавить в состав', 'Құрамға қосу')}: {selectedClub.name}
            </h2>
            <span className="roster-count">
              {text('Строк', 'Жол')}: {rows.length}
            </span>
          </div>
          <div className="roster-card-body">
            <p className="field-note">
              {text(
                'Черновик хранится в этой вкладке браузера и восстанавливается после перезагрузки. Сохранённые участники остаются в списке ниже.',
                'Жоба браузердің осы қойындысында сақталып, қайта жүктегенде қалпына келеді. Сақталған қатысушылар төмендегі тізімде қалады.',
              )}
            </p>
            <RosterEditor
              tournamentId={tournament.id}
              rows={rows}
              categories={tournament.categories}
              checked={checked}
              disabled={disabled}
              showValidation={showValidation}
              onChange={editRows}
            />
            <div className="roster-actions">
              <button
                type="button"
                disabled={disabled || rows.length >= 500}
                onClick={() => editRows([...rows, blankRow()])}
              >
                + {text('Добавить строку', 'Жол қосу')}
              </button>
              <button
                type="button"
                disabled={disabled || !rows.length}
                onClick={() => void checkRoster()}
              >
                {busy
                  ? text('Проверяем…', 'Тексерілуде…')
                  : text('Проверить заявку', 'Өтінімді тексеру')}
              </button>
              <button
                className="solid-button"
                type="button"
                disabled={disabled || !checked?.data.canSave || !previewCurrent}
                onClick={saveRoster}
              >
                {text('Сохранить проверенный состав', 'Тексерілген құрамды сақтау')}
              </button>
            </div>
            {checked && (
              <p
                className={checked.data.canSave && previewCurrent ? 'info-note' : 'field-note'}
                role="status"
              >
                {!previewCurrent
                  ? text(
                      'После изменения строк или состава турнира нужна повторная проверка.',
                      'Жолдар не турнир құрамы өзгергеннен кейін қайта тексеру қажет.',
                    )
                  : checked.data.canSave
                    ? text(
                        'Все строки проверены. Подтвердите сохранение состава кнопкой выше.',
                        'Барлық жол тексерілді. Жоғарыдағы батырмамен құрамды сақтауды растаңыз.',
                      )
                    : text(
                        'Исправьте ошибки или подтвердите отдельного спортсмена при совпадении, затем повторите проверку.',
                        'Қателерді түзетіңіз не сәйкестік болғанда бөлек спортшы екенін растаңыз, содан кейін қайта тексеріңіз.',
                      )}
              </p>
            )}
            <details className="roster-paste">
              <summary>
                {text(
                  'Вставить текстовый список (необязательно)',
                  'Мәтіндік тізімді енгізу (міндетті емес)',
                )}
              </summary>
              <p className="field-note">
                {text(
                  'Одна строка — один спортсмен. Формат: фамилия;имя;год рождения;пол;точное название категории. Пол: М / Ж или MALE / FEMALE. Вместо ; можно использовать табуляцию. Заголовок необязателен. Без кавычек.',
                  'Бір жол — бір спортшы. Пішімі: тегі;аты;туған жылы;жынысы;санаттың нақты атауы. Жынысы: ЕР / ӘЙЕЛ немесе MALE / FEMALE. ; орнына табуляция қолдануға болады. Тақырып міндетті емес. Тырнақшасыз.',
                )}
              </p>
              <label>
                {text('Текст заявки', 'Өтінім мәтіні')}
                <textarea
                  rows={6}
                  disabled={disabled}
                  value={paste}
                  onChange={(event) => editPaste(event.target.value)}
                />
              </label>
              <button type="button" disabled={disabled || !paste.trim()} onClick={appendText}>
                {text('Добавить в редактируемый черновик', 'Өңделетін жобаға қосу')}
              </button>
              {!!pasteIssues.length && (
                <ul className="roster-errors" role="alert">
                  {pasteIssues.map((issue, index) => (
                    <li key={index}>
                      {issue.line ? `${text('Строка', 'Жол')} ${issue.line}: ` : ''}
                      {rosterMessage(issue.code, locale === 'kk')}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          </div>
        </section>
      )}
      {correction?.mode === 'identity' && (
        <EntryIdentity
          key={`${correction.entry.id}:identity`}
          tournament={tournament}
          entry={correction.entry}
          pending={pending?.kind === 'identity' ? pending : null}
          disabled={deliveryDisabled}
          attempt={correctionAttempt}
          onDeliver={deliver}
          onClose={() => {
            if (!busy && !pending) setCorrection(null);
          }}
          onUpdate={onUpdate}
        />
      )}
      {correction?.mode === 'name' && (
        <EntryName
          key={`${correction.entry.id}:name`}
          tournament={tournament}
          entry={correction.entry}
          pending={pending?.kind === 'name' ? pending : null}
          disabled={mutationDisabled}
          attempt={correctionAttempt}
          onDeliver={deliver}
          onClose={() => {
            if (!busy && !pending) setCorrection(null);
          }}
        />
      )}
      {correction && correction.mode !== 'identity' && correction.mode !== 'name' && (
        <EntryCorrection
          key={`${correction.entry.id}:${correction.mode}`}
          tournament={tournament}
          entry={correction.entry}
          mode={correction.mode}
          pending={
            pending &&
            'entryId' in pending &&
            pending.kind !== 'identity' &&
            pending.kind !== 'name'
              ? pending
              : null
          }
          disabled={deliveryDisabled}
          attempt={correctionAttempt}
          onDeliver={deliver}
          onClose={() => {
            if (!busy && !pending) setCorrection(null);
          }}
          onUpdate={onUpdate}
        />
      )}
      <SavedRoster
        tournament={tournament}
        selectedClubId={selectedClubId}
        disabled={!ready || busy || !!pending || storageBlocked || !!correction}
        onClub={selectClub}
        onCorrect={openCorrection}
        onUpdate={onUpdate}
      />
    </div>
  );
}
