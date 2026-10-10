'use client';
import { useEffect, useRef, useState } from 'react';
import { request } from './api';
import { useLanguage } from '../../shared/i18n/provider';
import {
  clearAdministrationPending,
  deliverAdministrationPending,
  readAdministrationPending,
  saveAdministrationPending,
  type AdministrationOperation,
  type AdministrationPending,
} from './administration-command';
export function useAdministrationCommand(
  scope: string,
  onSuccess: (
    command: AdministrationPending,
    receipt: Record<string, unknown>,
  ) => Promise<void> | void,
) {
  const { text } = useLanguage();
  const [pending, setPending] = useState<AdministrationPending | null>(null),
    [ready, setReady] = useState(false),
    [storageError, setStorageError] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const pendingRef = useRef<AdministrationPending | null>(null),
    lock = useRef(false),
    onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;
  useEffect(() => {
    setReady(false);
    try {
      const value = readAdministrationPending(sessionStorage, scope);
      pendingRef.current = value;
      setPending(value);
      setStorageError(false);
      setReady(true);
    } catch {
      setStorageError(true);
    }
  }, [scope]);
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [!!pending]);
  async function deliver(value: AdministrationPending) {
    if (lock.current || pendingRef.current?.payload.id !== value.payload.id) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await deliverAdministrationPending(value, request<Record<string, unknown>>);
      if (result.kind === 'retry')
        setError(
          text(
            'Ответ не получен. Действие могло сохраниться; повторите исходную команду.',
            'Жауап алынбады. Әрекет сақталған болуы мүмкін; бастапқы команданы қайталаңыз.',
          ),
        );
      else {
        clearAdministrationPending(sessionStorage, value);
        pendingRef.current = null;
        setPending(null);
        if (result.kind === 'success') await onSuccessRef.current(value, result.receipt);
        else
          setError(
            text(
              'Действие отклонено. Обновите данные и проверьте действие заново: ',
              'Әрекет қабылданбады. Деректерді жаңартып, әрекетті қайта тексеріңіз: ',
            ) + (result.error instanceof Error ? result.error.message : ''),
          );
      }
    } catch {
      setError(
        text(
          'Не удалось завершить сверку. Проверьте сохранённую команду и обновите страницу.',
          'Тексеруді аяқтау мүмкін болмады. Сақталған команданы тексеріп, бетті жаңартыңыз.',
        ),
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function send(
    operation: AdministrationOperation,
    payload: Omit<AdministrationPending['payload'], 'id'>,
  ) {
    if (lock.current || pendingRef.current || !ready || storageError) return;
    const value: AdministrationPending = {
      scope,
      operation,
      payload: { ...payload, id: crypto.randomUUID() },
    };
    try {
      saveAdministrationPending(sessionStorage, value);
      pendingRef.current = value;
      setPending(value);
    } catch {
      setStorageError(true);
      return;
    }
    await deliver(value);
  }
  const notice = (
    <>
      {storageError && (
        <p role="alert" className="error-box">
          {text(
            'Хранилище команд недоступно или повреждено. Новые изменения заблокированы; восстановите доступ и перезагрузите страницу.',
            'Команда қоймасы қолжетімсіз немесе бүлінген. Жаңа өзгерістер бұғатталды; қолжетімділікті қалпына келтіріп, бетті қайта жүктеңіз.',
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="error-box">
          {error}
        </p>
      )}
      {pending && (
        <div className="info-note" role="status">
          <p>
            {text(
              'Есть сохранённая команда, результат которой нужно проверить.',
              'Нәтижесін тексеру қажет сақталған команда бар.',
            )}
          </p>
          <button disabled={busy} onClick={() => deliver(pending)}>
            {text('Повторить сохранённую команду', 'Сақталған команданы қайталау')}
          </button>
          <button
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([JSON.stringify(pending, null, 2)], { type: 'application/json' }),
              );
              const link = document.createElement('a');
              link.href = url;
              link.download = `administration-${pending.payload.id}.json`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            {text('Скачать команду для сверки', 'Тексеру үшін команданы жүктеу')}
          </button>
        </div>
      )}
    </>
  );
  return {
    send,
    notice,
    blocked: !ready || storageError || busy || !!pending,
    busy,
    pending,
    error,
  };
}
