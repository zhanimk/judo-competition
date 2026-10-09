'use client';

import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { ApiError, request } from '../tournaments/api';
import type { Tournament } from '../tournaments/types';
import { rosterMessage } from './messages';
import {
  clearPendingRoster,
  deliverRosterCommand,
  readPendingRoster,
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
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [paste, setPaste] = useState('');
  const [pasteIssues, setPasteIssues] = useState<{ line: number; code: string }[]>([]);
  const busyRef = useRef(false);
  const mounted = useRef(false);
  const locked = tournament.status !== 'DRAFT';
  const disabled = !ready || busy || !!pending || storageBlocked || locked;
  const selectedClub = tournament.clubs.find((club) => club.id === selectedClubId);
  const previewCurrent = previewMatchesDraft(checked, rows, tournament.rosterRevision);
  const sayError = (code: string) => setError(rosterMessage(code, locale === 'kk'));

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
    if (pending || busy || storageBlocked) return;
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
      setNotice('');
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
      setNotice('');
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
    setNotice('');
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
          setNotice(
            command.kind === 'club'
              ? text('Клуб создан. Теперь внесите состав.', 'Клуб құрылды. Енді құрамын енгізіңіз.')
              : text(
                  `Состав сохранён: ${command.payload.entries.length} спортсменов. Можно добавить следующих.`,
                  `Құрам сақталды: ${command.payload.entries.length} спортшы. Келесілерін қосуға болады.`,
                ),
          );
          await refresh();
        }
      } else {
        clearPendingRoster(sessionStorage, command);
        if (mounted.current) {
          setPending(null);
          onPendingChange(false);
          setChecked(null);
          sayError((result.error as Error).message);
          await refresh();
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
    setNotice('');
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
                disabled={!ready || busy || !!pending || storageBlocked}
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
              {text('Сохранённые составы доступны ниже.', 'Сақталған құрамдар төменде қолжетімді.')}
            </p>
          )}
          {error && (
            <p className="error-box" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="info-note" role="status">
              {notice}
            </p>
          )}
          {pending && (
            <div className="roster-pending" role="status">
              <p>
                {text(
                  'Есть сохранённая команда с неизвестным результатом. Пока она не проверена, новый состав или клуб не отправляется.',
                  'Нәтижесі белгісіз сақталған команда бар. Ол тексерілмейінше жаңа құрам не клуб жіберілмейді.',
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
            </div>
          )}
          {storageBlocked && (
            <button type="button" onClick={() => window.location.reload()}>
              {text('Повторно открыть сохранённые данные', 'Сақталған деректерді қайта ашу')}
            </button>
          )}
        </div>
      </section>
      {selectedClub && (
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
      <SavedRoster
        tournament={tournament}
        selectedClubId={selectedClubId}
        disabled={busy || !!pending || storageBlocked}
        onClub={selectClub}
      />
    </div>
  );
}
