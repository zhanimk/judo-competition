'use client';
import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../shared/i18n/provider';
import { request } from '../tournaments/api';
import type { Entry } from '../tournaments/types';
import {
  readPendingWithdrawal,
  savePendingWithdrawal,
  clearPendingWithdrawal,
  deliverPendingWithdrawal,
  type PendingWithdrawal,
  type WithdrawalReceipt,
} from './pending-withdrawal';
type Impact = {
  drawId: string;
  expectedVersion: number;
  entryId: string;
  impactToken: string;
  blocked: boolean;
  walkovers: { key: string; winnerEntryId: string | null }[];
};
export function WithdrawEntry({
  tournamentId,
  categoryId,
  entries,
  withdrawnIds,
  available,
  disabled,
  onPendingChange,
  onSelectCategory,
  onUpdated,
}: {
  tournamentId: string;
  categoryId: string;
  entries: Entry[];
  withdrawnIds: readonly string[];
  available: boolean;
  disabled: boolean;
  onPendingChange: (value: boolean) => void;
  onSelectCategory: (id: string) => void;
  onUpdated: () => void;
}) {
  const { text } = useLanguage();
  const [entryId, setEntryId] = useState(''),
    [reason, setReason] = useState(''),
    [impact, setImpact] = useState<Impact | null>(null);
  const [pending, setPending] = useState<PendingWithdrawal | null>(null),
    [storageError, setStorageError] = useState(false),
    [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false),
    pendingRef = useRef<PendingWithdrawal | null>(null);
  useEffect(() => {
    try {
      const value = readPendingWithdrawal(sessionStorage, tournamentId);
      pendingRef.current = value;
      setPending(value);
      setRestored(true);
      onPendingChange(!!value);
      if (value) onSelectCategory(value.categoryId);
    } catch {
      setStorageError(true);
      onPendingChange(true);
    }
  }, [tournamentId]);
  useEffect(() => {
    setImpact(null);
    setEntryId('');
    setReason('');
  }, [categoryId]);
  useEffect(() => {
    if (!pending) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [!!pending]);
  async function deliver(value: PendingWithdrawal) {
    if (lock.current || disabled || pendingRef.current?.payload.id !== value.payload.id) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await deliverPendingWithdrawal(value, (id, payload) =>
        request<WithdrawalReceipt>(`/categories/${id}/draw/withdrawal`, payload),
      );
      if (result.kind === 'retry')
        setError(
          text(
            'Ответ неизвестен. Повторите сохранённую команду.',
            'Жауап белгісіз. Сақталған команданы қайталаңыз.',
          ),
        );
      else {
        clearPendingWithdrawal(sessionStorage, value);
        pendingRef.current = null;
        setPending(null);
        onPendingChange(false);
        setImpact(null);
        setEntryId('');
        if (result.kind === 'rejected')
          setError(
            text(
              'Данные изменились или действие запрещено. Повторите сверку.',
              'Деректер өзгерген немесе әрекетке тыйым салынған. Тексеруді қайталаңыз.',
            ),
          );
        onUpdated();
      }
    } catch {
      setStorageError(true);
      onPendingChange(true);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function preview() {
    if (lock.current || disabled || !entryId) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setImpact(null);
    try {
      setImpact(
        await request<Impact>(`/categories/${categoryId}/draw/withdrawal-impact`, { entryId }),
      );
    } catch {
      setError(
        text(
          'Не удалось проверить последствия. Обновите сетку. Проведённые зависимые встречи могут блокировать изменение.',
          'Салдарды тексеру мүмкін болмады. Торды жаңартыңыз. Өткен тәуелді белдесулер өзгерісті бұғаттауы мүмкін.',
        ),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function approve() {
    if (
      !impact ||
      impact.blocked ||
      disabled ||
      lock.current ||
      pendingRef.current ||
      reason.trim().length < 3 ||
      !restored ||
      storageError
    )
      return;
    const value: PendingWithdrawal = {
      tournamentId,
      categoryId,
      drawId: impact.drawId,
      payload: {
        id: crypto.randomUUID(),
        entryId: impact.entryId,
        expectedVersion: impact.expectedVersion,
        impactToken: impact.impactToken,
        reason: reason.trim(),
      },
    };
    try {
      savePendingWithdrawal(sessionStorage, value);
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
    const e = entries.find((e) => e.id === id);
    return e ? `${e.lastName} ${e.firstName} · ${e.club}` : id;
  };
  if (!available && !pending && !storageError) return null;
  return (
    <section className="tiebreak-review">
      <h3>
        {text('Удалить участника из дальнейших встреч', 'Қатысушыны келесі белдесулерден шығару')}
      </h3>
      <p>
        {text(
          'Соперники проходят без борьбы. Если убраны оба, следующая ветвь проходит автоматически. Сыгранные результаты и история сохраняются; удалённый участник больше не получает места.',
          'Қарсыластар күрессіз өтеді. Екеуі де шығарылса, келесі тармақ автоматты өтеді. Өткен нәтижелер мен тарих сақталады; шығарылған қатысушыға орын берілмейді.',
        )}
      </p>
      {error && <p role="alert">{error}</p>}
      {storageError && (
        <p role="alert">
          {text(
            'Хранилище недоступно или повреждено. Новые команды заблокированы.',
            'Қойма қолжетімсіз немесе бүлінген. Жаңа командалар бұғатталды.',
          )}
        </p>
      )}
      {pending ? (
        <div>
          <p role="status">
            {text(
              'Результат сохранённой команды требует сверки.',
              'Сақталған команданың нәтижесін тексеру қажет.',
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
              a.download = `withdrawal-${pending.payload.id}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
          >
            {text('Скачать команду для сверки', 'Тексеру үшін команданы жүктеу')}
          </button>
        </div>
      ) : (
        <div>
          {withdrawnIds.length > 0 && (
            <p>
              {text('Уже удалены', 'Шығарылғандар')}: {withdrawnIds.map(name).join('; ')}
            </p>
          )}
          <label>
            {text('Спортсмен', 'Спортшы')}
            <select
              value={entryId}
              disabled={disabled || busy || storageError}
              onChange={(e) => {
                setEntryId(e.target.value);
                setImpact(null);
              }}
            >
              <option value="">{text('Выберите участника', 'Қатысушыны таңдаңыз')}</option>
              {entries
                .filter((e) => !withdrawnIds.includes(e.id))
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {name(e.id)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            {text('Причина', 'Себебі')}
            <textarea
              value={reason}
              maxLength={500}
              disabled={disabled || busy}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button
            disabled={disabled || busy || !entryId || !restored || storageError}
            onClick={preview}
          >
            {text('Проверить последствия', 'Салдарды тексеру')}
          </button>
          {impact && (
            <div>
              <strong>{name(impact.entryId)}</strong>
              <p>
                {text('Автоматических исходов сейчас', 'Қазір автоматты нәтижелер')}:{' '}
                {impact.walkovers.length}.{' '}
                {text(
                  'Будущие пары обработаются по мере определения соперников.',
                  'Келесі жұптар қарсыластар анықталған сайын өңделеді.',
                )}
              </p>
              {impact.blocked && (
                <p role="alert">
                  {text(
                    'Остановите таймер и удержание; автономный журнал требует сверки. Начатые зависимости автоматически не переписываются.',
                    'Таймер мен ұстап тұруды тоқтатыңыз; автономды журналды тексеру қажет. Басталған тәуелді белдесулер автоматты өзгермейді.',
                  )}
                </p>
              )}
              <button
                disabled={disabled || busy || impact.blocked || reason.trim().length < 3}
                onClick={approve}
              >
                {text(
                  'Удалить и передать победы соперникам',
                  'Шығарып, жеңістерді қарсыластарға беру',
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
