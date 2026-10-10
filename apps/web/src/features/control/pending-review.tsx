'use client';
import { useEffect, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { adminPendingKey, type AdminAction, type PendingAdminCommand } from './pending-command';

export function PendingControlReview({
  tournamentId,
  pending,
  corrupt,
  connected,
  busy,
  current,
  reviewVersion,
  actionLabel,
  onRetry,
  onRefresh,
  onArchive,
}: {
  tournamentId: string;
  pending: PendingAdminCommand | null;
  corrupt: boolean;
  connected: boolean;
  busy: boolean;
  current: string;
  reviewVersion: string;
  actionLabel: (action: AdminAction) => string;
  onRetry: () => void;
  onRefresh: () => void;
  onArchive: (reason: string, checked: boolean) => void;
}) {
  const { text } = useLanguage();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const [exportError, setExportError] = useState(false);
  useEffect(() => {
    setChecked(false);
  }, [reviewVersion, connected]);
  if (!pending && !corrupt) return null;
  function download() {
    try {
      const raw = sessionStorage.getItem(adminPendingKey(tournamentId));
      if (raw === null) throw new Error('missing');
      const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `admin-command-${pending?.payload.id ?? tournamentId}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setExportError(false);
    } catch {
      setExportError(true);
    }
  }
  return (
    <section
      className="panel form-panel control-pending"
      aria-label={text('Незавершённая команда', 'Аяқталмаған команда')}
    >
      <h3>{text('Исход команды требует проверки', 'Команданың нәтижесін тексеру қажет')}</h3>
      <p>
        {text(
          'Новые изменения заблокированы. Ответ мог потеряться после выполнения действия на сервере. Повтор отправит ту же команду с тем же номером и исходными данными.',
          'Жаңа өзгерістер бұғатталған. Сервер әрекетті орындағаннан кейін жауап жоғалуы мүмкін. Қайталау сол нөмірі мен бастапқы деректері бар команданы жібереді.',
        )}
      </p>
      {pending ? (
        <div className="control-pending-details">
          <strong>{actionLabel(pending.payload.type)}</strong>
          <span>
            {pending.review.category} · {pending.review.key}
          </span>
          <span>
            {pending.review.white} / {pending.review.blue}
          </span>
          {pending.review.targetNumber && <span>→ Татами {pending.review.targetNumber}</span>}
          {pending.payload.type === 'EDIT_TIME' && (
            <span>
              {pending.payload.phase}: {pending.payload.elapsedMs / 1000}{' '}
              {text('с прошло', 'с өткен')}
            </span>
          )}
          <span>
            {text('Причина', 'Себеп')}: {pending.payload.reason}
          </span>
          {!!pending.review.dependent?.length && (
            <span>
              {text('Зависимые встречи до команды', 'Команда алдындағы тәуелді белдесулер')}:{' '}
              {pending.review.dependent.map((row) => `${row.key} (${row.status})`).join(', ')}
            </span>
          )}
          <small>
            {text('Команда', 'Команда')}: {pending.payload.id} ·{' '}
            {text('Исходная версия', 'Бастапқы нұсқа')}: {pending.payload.expectedRevision}
          </small>
        </div>
      ) : (
        <p className="error-box">
          {text(
            'Сохранённая команда повреждена или недоступна. Не создавайте замену без проверки. Выгрузите исходную запись и сверьте встречу.',
            'Сақталған команда бүлінген немесе қолжетімсіз. Тексермей жаңа команда жасамаңыз. Бастапқы жазбаны жүктеп, белдесуді салыстырыңыз.',
          )}
        </p>
      )}
      <div className="form-actions">
        {pending && (
          <button className="solid-button" disabled={busy || !connected} onClick={onRetry}>
            {text('Повторить исходную команду', 'Бастапқы команданы қайталау')}
          </button>
        )}
        <button disabled={busy} onClick={download}>
          {text('Скачать исходную запись', 'Бастапқы жазбаны жүктеу')}
        </button>
        <button disabled={busy} onClick={onRefresh}>
          {text('Обновить данные для сверки', 'Салыстыру үшін деректерді жаңарту')}
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setArchiveOpen(!archiveOpen);
            setChecked(false);
          }}
        >
          {text('Разобрать вручную', 'Қолмен тексеру')}
        </button>
      </div>
      {exportError && (
        <p className="error-box" role="alert">
          {text(
            'Не удалось прочитать исходную запись. Команда сохранена без изменений.',
            'Бастапқы жазбаны оқу мүмкін болмады. Команда өзгеріссіз сақталған.',
          )}
        </p>
      )}
      {archiveOpen && (
        <fieldset className="control-archive" disabled={busy}>
          <legend>
            {text(
              'Проверка перед локальным архивированием',
              'Жергілікті мұрағаттау алдындағы тексеру',
            )}
          </legend>
          <p>
            {text('Актуальные данные', 'Өзекті деректер')}:{' '}
            {connected
              ? current
              : text('Нет связи — сверка недоступна', 'Байланыс жоқ — салыстыру қолжетімсіз')}
          </p>
          <p>
            {text(
              'Архивирование сохранит исходную запись в этой вкладке и разрешит новые изменения. Оно не отменяет действие на сервере. Сначала проверьте результат и последствия команды.',
              'Мұрағаттау бастапқы жазбаны осы қойындыда сақтап, жаңа өзгерістерге рұқсат береді. Ол сервердегі әрекетті қайтармайды. Алдымен команданың нәтижесі мен салдарын тексеріңіз.',
            )}
          </p>
          <label>
            {text('Что проверено и принятое решение', 'Не тексерілді және қабылданған шешім')}
            <input
              value={reason}
              maxLength={300}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <label className="control-check">
            <input
              type="checkbox"
              checked={checked}
              disabled={!connected}
              onChange={(event) => setChecked(event.target.checked)}
            />
            {text(
              'Я сверил актуальную встречу и последствия. Архивирование не отменяет серверную команду.',
              'Өзекті белдесу мен салдарын салыстырдым. Мұрағаттау сервер командасын қайтармайды.',
            )}
          </label>
          <button
            disabled={!connected || !checked || reason.trim().length < 3}
            onClick={() => onArchive(reason, checked)}
          >
            {text('Сохранить разбор в локальном архиве', 'Тексеруді жергілікті мұрағатта сақтау')}
          </button>
        </fieldset>
      )}
    </section>
  );
}
