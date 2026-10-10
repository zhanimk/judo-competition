'use client';
import { useEffect, useRef, useState } from 'react';
import { request } from '../tournaments/api';
import type { Entry } from '../tournaments/types';
import { useLanguage } from '../../shared/i18n/provider';
import { pollSnapshots } from '../../shared/live/snapshot-poller';
import {
  clearPendingTiebreak,
  deliverPendingTiebreak,
  readPendingTiebreak,
  savePendingTiebreak,
  type PendingTiebreak,
  type TiebreakReceipt,
} from './pending-tiebreak';
import './tiebreak-review.css';
type Review = {
  parent: string;
  pool?: string;
  members: string[];
  procedure: 'ROUND_ROBIN';
  impactToken: string;
  additionalMatches: unknown[];
  changedRounds: { id: string; key: string; beforeRound: number; afterRound: number }[];
  blocked: boolean;
};
type Impact = { drawId: string; expectedVersion: number; reviews: Review[] };
export function TiebreakReview({
  tournamentId,
  categoryId,
  entries,
  disabled,
  onPendingChange,
  onSelectCategory,
  onUpdated,
}: {
  tournamentId: string;
  categoryId: string;
  entries: Entry[];
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
  onSelectCategory: (categoryId: string) => void;
  onUpdated: () => void;
}) {
  const { text } = useLanguage();
  const [impact, setImpact] = useState<Impact | null>(null),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [pending, setPending] = useState<PendingTiebreak | null>(null),
    [busy, setBusy] = useState(false),
    [storageError, setStorageError] = useState(false),
    [restored, setRestored] = useState(false),
    [refresh, setRefresh] = useState(0);
  const pendingRef = useRef<PendingTiebreak | null>(null),
    lock = useRef(false);
  useEffect(() => {
    try {
      const value = readPendingTiebreak(sessionStorage, tournamentId);
      pendingRef.current = value;
      setPending(value);
      setRestored(true);
      setStorageError(false);
      onPendingChange(!!value);
      if (value) onSelectCategory(value.categoryId);
    } catch {
      setStorageError(true);
      onPendingChange(true);
    }
  }, [tournamentId]);
  useEffect(() => {
    setImpact(null);
    if (!categoryId) return;
    const poller = pollSnapshots(
      () => request<Impact>(`/categories/${categoryId}/draw/tiebreak-impact`),
      setImpact,
      () => {},
      5000,
    );
    void poller.refresh();
    return () => poller.stop();
  }, [categoryId, refresh]);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [!!pending]);
  async function deliver(value: PendingTiebreak) {
    if (lock.current || disabled || pendingRef.current?.payload.id !== value.payload.id) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await deliverPendingTiebreak(value, (id, payload) =>
        request<TiebreakReceipt>(`/categories/${id}/draw/tiebreak`, payload),
      );
      if (result.kind === 'retry')
        setError(
          text(
            'Ответ не получен. Процедура могла сохраниться. Повторите исходную команду ниже.',
            'Жауап алынбады. Рәсім сақталған болуы мүмкін. Төменде бастапқы команданы қайталаңыз.',
          ),
        );
      else {
        clearPendingTiebreak(sessionStorage, value);
        pendingRef.current = null;
        setPending(null);
        onPendingChange(false);
        if (result.kind === 'rejected')
          setError(
            text(
              'Сверка отклонена. Обновите данные, проверьте участников и последствия заново: ',
              'Тексеру қабылданбады. Деректерді жаңартып, қатысушылар мен салдарын қайта тексеріңіз: ',
            ) + (result.error instanceof Error ? result.error.message : ''),
          );
        setRefresh((v) => v + 1);
        onUpdated();
      }
    } catch {
      setError(
        text(
          'Не удалось очистить сохранённую команду. Повторите её для сверки.',
          'Сақталған команданы тазалау мүмкін болмады. Тексеру үшін қайталаңыз.',
        ),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function approve(review: Review) {
    if (
      !impact ||
      disabled ||
      busy ||
      lock.current ||
      pendingRef.current ||
      storageError ||
      !restored ||
      reason.trim().length < 3 ||
      review.blocked
    )
      return;
    const value: PendingTiebreak = {
      tournamentId,
      categoryId,
      drawId: impact.drawId,
      payload: {
        id: crypto.randomUUID(),
        expectedVersion: impact.expectedVersion,
        impactToken: review.impactToken,
        reason: reason.trim(),
        procedure: 'ROUND_ROBIN',
        parent: review.parent,
        ...(review.pool ? { pool: review.pool } : {}),
        members: [...review.members],
      },
    };
    try {
      savePendingTiebreak(sessionStorage, value);
      pendingRef.current = value;
      setPending(value);
      onPendingChange(true);
    } catch {
      setStorageError(true);
      onPendingChange(true);
      return;
    }
    await deliver(value);
  }
  const name = (id: string) => {
    const entry = entries.find((e) => e.id === id);
    return entry ? `${entry.lastName} ${entry.firstName} · ${entry.club}` : id;
  };
  if (!storageError && !pending && !impact?.reviews.length && !error) return null;
  return (
    <section className="tiebreak-review" aria-label={text('Разрешение равенства', 'Теңдікті шешу')}>
      <h3>{text('Равенство: решение администратора', 'Теңдік: әкімшінің шешімі')}</h3>
      {storageError && (
        <p className="error-box" role="alert">
          {text(
            'Хранилище команд недоступно или повреждено. Новые изменения заблокированы; восстановите доступ к хранилищу и перезагрузите страницу.',
            'Команда қоймасы қолжетімсіз немесе бүлінген. Жаңа өзгерістер бұғатталды; қоймаға қолжетімділікті қалпына келтіріп, бетті қайта жүктеңіз.',
          )}
        </p>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {pending ? (
        <div>
          <p role="status">
            {text(
              'Сохранена команда утверждения дополнительного круга. Пока её результат неизвестен, новые изменения заблокированы.',
              'Қосымша айналымды бекіту командасы сақталды. Нәтижесі белгісіз болғанша жаңа өзгерістер бұғатталды.',
            )}
          </p>
          <button disabled={disabled || busy} onClick={() => deliver(pending)}>
            {text('Повторить сохранённую команду', 'Сақталған команданы қайталау')}
          </button>
          <button
            onClick={() => {
              const a = document.createElement('a');
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(pending, null, 2)], { type: 'application/json' }),
              );
              a.href = url;
              a.download = `tiebreak-${pending.payload.id}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            {text('Скачать команду для сверки', 'Тексеру үшін команданы жүктеу')}
          </button>
        </div>
      ) : (
        <>
          <p className="field-note">
            {text(
              'Предлагается дополнительный круг только между участниками с равным числом побед. Он определит порядок внутри этой группы. Если равенство повторится, потребуется новая схватка или новое решение. Ранее проведённые встречи сохраняются.',
              'Жеңістері тең қатысушылар арасында ғана қосымша айналым ұсынылады. Ол осы топ ішіндегі ретті анықтайды. Теңдік қайталанса, жаңа белдесу немесе жаңа шешім қажет болады. Бұрынғы белдесулер сақталады.',
            )}
          </p>
          {impact?.reviews.map((review) => (
            <article key={`${review.parent}:${review.members.join(',')}`}>
              <h4>
                {review.pool
                  ? `${text('Группа', 'Топ')} ${review.pool}`
                  : text('Круговая категория', 'Айналмалы санат')}
              </h4>
              <ul>
                {review.members.map((id) => (
                  <li key={id}>{name(id)}</li>
                ))}
              </ul>
              <p>
                {text('Новых встреч', 'Жаңа белдесулер')}: {review.additionalMatches.length}.{' '}
                {text('Переносов следующих туров', 'Келесі айналымдардың жылжуы')}:{' '}
                {review.changedRounds.length}.
              </p>
              {review.blocked && (
                <p role="alert">
                  {text(
                    'Зависимая встреча уже началась или требует сверки. Эту процедуру нельзя применить.',
                    'Тәуелді белдесу басталған немесе тексеруді қажет етеді. Бұл рәсімді қолдануға болмайды.',
                  )}
                </p>
              )}
              <label>
                {text('Основание решения', 'Шешімнің негізі')}
                <textarea
                  value={reason}
                  maxLength={1000}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={disabled || busy}
                />
              </label>
              <button
                className="solid-button"
                disabled={
                  disabled ||
                  busy ||
                  !restored ||
                  storageError ||
                  review.blocked ||
                  reason.trim().length < 3
                }
                onClick={() => approve(review)}
              >
                {text('Утвердить дополнительный круг', 'Қосымша айналымды бекіту')}
              </button>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
