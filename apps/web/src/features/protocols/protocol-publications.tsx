'use client';
import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { request } from '../tournaments/api';
import { pollSnapshots } from '../../shared/live/snapshot-poller';
import { subscribeTournament } from '../../shared/live/subscribe';
import { exportCategories, exportSelection, type ExportCategory } from '../draws/protocol-scope';
import { ProtocolArtifactCard } from './protocol-artifact-card';
import { protocolError, protocolLabels } from './protocol-labels';
import {
  clearPendingProtocol,
  deliverProtocol,
  pendingProtocolJson,
  readPendingProtocol,
  savePendingProtocol,
  protocolKinds,
  type PendingProtocol,
  type ProtocolArtifact,
  type ProtocolKind,
} from './protocol-model';
import { useProtocolHistory } from './use-protocol-history';
import './protocol-publications.css';

export function ProtocolPublications({ tournamentId }: { tournamentId: string }) {
  const { text, locale } = useLanguage();
  const [beforeVersion, setBeforeVersion] = useState<number | undefined>();
  const {
    history,
    error: readError,
    refresh,
  } = useProtocolHistory(tournamentId, false, beforeVersion);
  const [categories, setCategories] = useState<ExportCategory[]>([]);
  const [categoriesReady, setCategoriesReady] = useState(false);
  const [kind, setKind] = useState<ProtocolKind>('DRAW'),
    [lang, setLang] = useState<'ru' | 'kk'>(locale);
  const [scope, setScope] = useState<'ALL' | 'SELECTED'>('ALL'),
    [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState<PendingProtocol | null>(null),
    [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false),
    [storageBlocked, setStorageBlocked] = useState(false);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [selection, setSelection] = useState<{
    artifact: ProtocolArtifact;
    type: 'PUBLISH' | 'UNPUBLISH';
  } | null>(null);
  const [visibilityReason, setVisibilityReason] = useState(''),
    [approved, setApproved] = useState('');
  const working = useRef(false),
    mounted = useRef(false);
  const eligible = exportCategories(categories, kind),
    chosen = exportSelection(categories, kind, selectedIds);
  const blocked = !ready || busy || !!pending || storageBlocked || !history || !!readError;
  const target = history?.artifacts.find((artifact) => artifact.id === selection?.artifact.id);
  const approval = JSON.stringify([
    target?.id,
    target?.sha256,
    history?.revision,
    visibilityReason,
  ]);
  const validReason = (value: string) => value.trim().length >= 3 && value.trim().length <= 500;

  useEffect(() => {
    mounted.current = true;
    try {
      setPending(readPendingProtocol(sessionStorage, tournamentId));
    } catch {
      setStorageBlocked(true);
      setError(protocolError('PROTOCOL_STORAGE_INVALID', locale === 'kk'));
    }
    setReady(true);
    setCategoriesReady(false);
    const poller = pollSnapshots(
      () => request<{ categories: ExportCategory[] }>(`/tournaments/${tournamentId}`),
      (data) => {
        setCategories(data.categories);
        setCategoriesReady(true);
      },
      () => setCategoriesReady(false),
      5000,
    );
    const stop = subscribeTournament(tournamentId, (notice) => {
      if (notice.kind !== 'state') void poller.refresh();
    });
    void poller.refresh();
    return () => {
      stop();
      poller.stop();
      mounted.current = false;
    };
  }, [tournamentId]);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending]);

  async function execute(command: PendingProtocol) {
    if (working.current || storageBlocked) return;
    try {
      savePendingProtocol(sessionStorage, command);
    } catch {
      setStorageBlocked(true);
      setError(protocolError('PROTOCOL_STORAGE_INVALID', locale === 'kk'));
      return;
    }
    setPending(command);
    working.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await deliverProtocol(command, (path, body) => request(path, body));
      if (result.kind === 'retry') {
        if (mounted.current)
          setError(
            text(
              'Ответ неизвестен. Команда могла выполниться: повторите исходную команду после восстановления доступа.',
              'Жауап белгісіз. Команда орындалған болуы мүмкін: қолжетімділік қалпына келгенде бастапқы команданы қайталаңыз.',
            ),
          );
        return;
      }
      if (result.kind === 'success') {
        // A saved receipt may be older than current publication/name state. Read current history
        // before clearing the original; never show its old visibility as the current status.
        await refresh();
        clearPendingProtocol(sessionStorage, command);
        if (mounted.current) {
          setPending(null);
          setSelection(null);
          setApproved('');
          setReason('');
          setNotice(
            command.action === 'CREATE'
              ? text(
                  'Версия сохранена. Откройте PDF, проверьте его и опубликуйте отдельно.',
                  'Нұсқа сақталды. PDF-ті ашып, тексеріңіз және бөлек жариялаңыз.',
                )
              : text(
                  'Команда проверена. Ниже показана актуальная история.',
                  'Команда тексерілді. Төменде қазіргі тарих көрсетілген.',
                ),
          );
        }
      } else {
        clearPendingProtocol(sessionStorage, command);
        if (mounted.current) {
          setPending(null);
          setApproved('');
          setError(
            protocolError(
              result.error instanceof Error ? result.error.message : 'FAILED',
              locale === 'kk',
            ),
          );
        }
        await refresh();
      }
    } catch {
      if (mounted.current)
        setError(
          text(
            'Не удалось проверить актуальную историю или сохранить подтверждение. Исходная команда оставлена для точного повтора.',
            'Қазіргі тарихты тексеру немесе растауды сақтау мүмкін болмады. Бастапқы команда дәл қайталау үшін сақталған.',
          ),
        );
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  function create() {
    if (
      blocked ||
      !categoriesReady ||
      !validReason(reason) ||
      !eligible.length ||
      (scope === 'SELECTED' && !chosen.length) ||
      !history
    )
      return;
    void execute({
      tournamentId,
      action: 'CREATE',
      body: {
        id: crypto.randomUUID(),
        expectedRevision: history.revision,
        reason: reason.trim(),
        kind,
        lang,
        ...(scope === 'SELECTED' ? { categoryIds: [...chosen].sort() } : {}),
      },
    });
  }
  function confirmVisibility() {
    if (
      blocked ||
      !selection ||
      !target ||
      !history ||
      !validReason(visibilityReason) ||
      approved !== approval ||
      (selection.type === 'PUBLISH' && (!target.sourceCurrent || !history.tournamentPublished))
    )
      return;
    void execute({
      tournamentId,
      action: selection.type,
      artifactId: target.id,
      artifactSnapshot: structuredClone(target),
      body: {
        id: crypto.randomUUID(),
        expectedRevision: history.revision,
        type: selection.type,
        reason: visibilityReason.trim(),
        sha256: target.sha256,
      },
    });
  }
  function exportPending() {
    try {
      const url = URL.createObjectURL(
        new Blob([pendingProtocolJson(sessionStorage, tournamentId)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `protocol-command-${pending?.body.id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setStorageBlocked(true);
      setError(protocolError('PROTOCOL_STORAGE_INVALID', locale === 'kk'));
    }
  }
  return (
    <div className="protocol-publications">
      <section className="panel protocol-publish-card">
        <h2>{text('Версии PDF и публикация', 'PDF нұсқалары және жариялау')}</h2>
        <p>
          {text(
            'Сначала создайте и проверьте файл, затем опубликуйте его для зрителей. Каждая версия сохраняет исходные имена и результаты. Новая версия не снимает старую с публикации автоматически.',
            'Алдымен файлды жасап, тексеріңіз, содан кейін көрермендерге жариялаңыз. Әр нұсқа бастапқы есімдер мен нәтижелерді сақтайды. Жаңа нұсқа ескісін автоматты түрде жариялаудан алмайды.',
          )}
        </p>
        <p className="field-note">
          {text(
            'Публикация PDF отдельна от видимости живой сетки. Для закрытия файла зрителям используйте «Снять публикацию»; скачанные файлы отозвать нельзя.',
            'PDF жариялау тірі тордың көрінуінен бөлек. Файлды көрермендерге жабу үшін «Жариялауды тоқтату» батырмасын қолданыңыз; жүктелген файлдарды қайтарып алу мүмкін емес.',
          )}
        </p>
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        {readError && (
          <p className="error-box" role="alert">
            {text(
              'История недоступна. Действия заблокированы до актуального ответа.',
              'Тарих қолжетімсіз. Қазіргі жауап алынғанша әрекеттер бұғатталған.',
            )}{' '}
            <button type="button" onClick={() => void refresh().catch(() => {})}>
              {text('Повторить', 'Қайталау')}
            </button>
          </p>
        )}
        {notice && (
          <p className="info-note" role="status">
            {notice}
          </p>
        )}
        {pending && (
          <div className="protocol-pending" role="status">
            <p>
              {text(
                'Есть сохранённая команда. Новые действия недоступны до проверки её результата.',
                'Сақталған команда бар. Нәтижесі тексерілгенше жаңа әрекеттер қолжетімсіз.',
              )}
            </p>
            <p>
              {pending.action === 'CREATE'
                ? text(...protocolLabels[pending.body.kind])
                : `${text(...protocolLabels[pending.artifactSnapshot.kind])} · ${text('Версия', 'Нұсқа')} ${pending.artifactSnapshot.version}`}
              {' · '}
              {text('Причина', 'Себебі')}: {pending.body.reason}
            </p>
            <p className="field-note">
              {text('ID команды', 'Команда ID')}: <code>{pending.body.id}</code>
            </p>
            <div className="protocol-artifact-actions">
              <button
                className="solid-button"
                type="button"
                disabled={busy || storageBlocked}
                onClick={() => void execute(pending)}
              >
                {text('Повторить исходную команду', 'Бастапқы команданы қайталау')}
              </button>
              <button type="button" onClick={exportPending}>
                {text('Скачать команду', 'Команданы жүктеу')}
              </button>
            </div>
          </div>
        )}
        {storageBlocked && (
          <button type="button" onClick={() => location.reload()}>
            {text('Повторно открыть сохранённые данные', 'Сақталған деректерді қайта ашу')}
          </button>
        )}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <fieldset disabled={blocked || !!selection}>
            <legend>{text('Создать новую версию', 'Жаңа нұсқа жасау')}</legend>
            <div className="protocol-fields">
              <label>
                {text('Документ', 'Құжат')}
                <select
                  value={kind}
                  onChange={(event) => setKind(event.target.value as ProtocolKind)}
                >
                  {protocolKinds.map((value) => (
                    <option key={value} value={value}>
                      {text(...protocolLabels[value])}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {text('Язык PDF', 'PDF тілі')}
                <select
                  value={lang}
                  onChange={(event) => setLang(event.target.value as 'ru' | 'kk')}
                >
                  <option value="ru">Русский</option>
                  <option value="kk">Қазақша</option>
                </select>
              </label>
              <label>
                {text('Категории', 'Санаттар')}
                <select
                  value={scope}
                  onChange={(event) => setScope(event.target.value as 'ALL' | 'SELECTED')}
                >
                  <option value="ALL">{text('Все категории', 'Барлық санаттар')}</option>
                  <option value="SELECTED">{text('Выбрать категории', 'Санаттарды таңдау')}</option>
                </select>
              </label>
            </div>
            {!categoriesReady && (
              <p role="status">
                {text(
                  'Проверяем актуальные категории. Создание файла доступно после загрузки.',
                  'Қазіргі санаттар тексерілуде. Файл жасау жүктелгеннен кейін қолжетімді.',
                )}
              </p>
            )}
            {scope === 'SELECTED' && (
              <div className="protocol-category-options">
                {eligible.map((category) => (
                  <label key={category.id}>
                    <input
                      type="checkbox"
                      checked={chosen.includes(category.id)}
                      onChange={(event) =>
                        setSelectedIds((current) =>
                          event.target.checked
                            ? [...current, category.id]
                            : current.filter((id) => id !== category.id),
                        )
                      }
                    />
                    {category.name}
                  </label>
                ))}
              </div>
            )}
            {kind === 'TEAMS' && (
              <p className="field-note">
                {text(
                  'Золото, серебро, бронза. Каждая включённая категория должна быть полностью подтверждена; неразрешённое равенство блокирует итог.',
                  'Алтын, күміс, қола. Әр қосылған санат толық расталуы керек; шешілмеген теңдік қорытындыны бұғаттайды.',
                )}
              </p>
            )}
            <label>
              {text('Причина выпуска версии', 'Нұсқаны шығару себебі')}
              <textarea
                rows={2}
                maxLength={500}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={text('3–500 символов', '3–500 таңба')}
              />
            </label>
            <button
              className="solid-button"
              type="submit"
              disabled={
                blocked ||
                !categoriesReady ||
                !eligible.length ||
                !validReason(reason) ||
                (scope === 'SELECTED' && !chosen.length)
              }
            >
              {busy
                ? text('Сохраняем…', 'Сақталуда…')
                : text('Создать PDF для проверки', 'Тексеру үшін PDF жасау')}
            </button>
          </fieldset>
        </form>
      </section>
      {selection && (
        <section className="panel protocol-publish-card">
          <h2>
            {selection.type === 'PUBLISH'
              ? text('Опубликовать проверенную версию', 'Тексерілген нұсқаны жариялау')
              : text('Снять публикацию', 'Жариялауды тоқтату')}
          </h2>
          <p>
            {text('Версия', 'Нұсқа')} {selection.artifact.version} ·{' '}
            {text(...protocolLabels[selection.artifact.kind])} ·{' '}
            {selection.artifact.lang.toUpperCase()}
          </p>
          <label>
            {text('Причина', 'Себебі')}
            <textarea
              value={visibilityReason}
              maxLength={500}
              disabled={blocked}
              onChange={(event) => setVisibilityReason(event.target.value)}
            />
          </label>
          <label className="protocol-approval">
            <input
              type="checkbox"
              disabled={blocked}
              checked={approved === approval}
              onChange={(event) => setApproved(event.target.checked ? approval : '')}
            />
            {selection.type === 'PUBLISH'
              ? text(
                  'Я проверил PDF и подтверждаю публикацию этой версии для зрителей.',
                  'PDF-ті тексеріп, осы нұсқаны көрермендерге жариялауды растаймын.',
                )
              : text(
                  'Подтверждаю закрытие гостевого скачивания этой версии. История и файл сохранятся.',
                  'Осы нұсқаны қонақтарға жүктеуді жабуды растаймын. Тарих пен файл сақталады.',
                )}
          </label>
          {selection.type === 'PUBLISH' &&
            (!target?.sourceCurrent || !history?.tournamentPublished) && (
              <p className="error-box">
                {protocolError(
                  !history?.tournamentPublished
                    ? 'TOURNAMENT_NOT_PUBLISHED'
                    : 'PROTOCOL_SOURCE_CHANGED',
                  locale === 'kk',
                )}
              </p>
            )}
          <div className="protocol-artifact-actions">
            <button
              type="button"
              disabled={
                blocked ||
                !validReason(visibilityReason) ||
                approved !== approval ||
                !target ||
                (selection.type === 'PUBLISH' &&
                  (!target.sourceCurrent || !history?.tournamentPublished))
              }
              className="solid-button"
              onClick={confirmVisibility}
            >
              {text('Подтвердить', 'Растау')}
            </button>
            <button type="button" disabled={busy || !!pending} onClick={() => setSelection(null)}>
              {text('Отмена', 'Бас тарту')}
            </button>
          </div>
        </section>
      )}
      <section className="panel protocol-publish-card">
        <h2>{text('История версий', 'Нұсқалар тарихы')}</h2>
        {!history ? (
          <p role="status">{text('Загрузка…', 'Жүктелуде…')}</p>
        ) : !history.artifacts.length ? (
          <p>{text('Сохранённых версий пока нет.', 'Сақталған нұсқалар әлі жоқ.')}</p>
        ) : (
          <div className="protocol-artifacts">
            {history.artifacts.map((artifact) => (
              <ProtocolArtifactCard key={artifact.id} artifact={artifact}>
                <button
                  type="button"
                  disabled={
                    blocked || !!selection || (!artifact.publishedAt && !artifact.sourceCurrent)
                  }
                  onClick={() => {
                    setSelection({
                      artifact: structuredClone(artifact),
                      type: artifact.publishedAt ? 'UNPUBLISH' : 'PUBLISH',
                    });
                    setVisibilityReason('');
                    setApproved('');
                  }}
                >
                  {artifact.publishedAt
                    ? text('Снять публикацию', 'Жариялауды тоқтату')
                    : text('Опубликовать', 'Жариялау')}
                </button>
              </ProtocolArtifactCard>
            ))}
          </div>
        )}
        <div className="protocol-artifact-actions">
          {beforeVersion && (
            <button
              type="button"
              disabled={busy || !!pending || !!selection}
              onClick={() => setBeforeVersion(undefined)}
            >
              {text('Последние версии', 'Соңғы нұсқалар')}
            </button>
          )}
          {history?.nextBeforeVersion && (
            <button
              type="button"
              disabled={busy || !!pending || !!selection}
              onClick={() => setBeforeVersion(history.nextBeforeVersion!)}
            >
              {text('Более ранние версии', 'Бұрынғы нұсқалар')}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
