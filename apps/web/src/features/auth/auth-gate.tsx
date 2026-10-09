'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { request, ApiError } from '../tournaments/api';
import { useLanguage } from '../../shared/i18n/provider';
export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter(),
    path = usePathname();
  const { text } = useLanguage();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setReady(false);
    setFailed(false);
    request<{ role: string; tatamiId: string | null }>('/auth/me')
      .then((user) => {
        if (!active) return;
        if (user.role === 'OPERATOR' && user.tatamiId) {
          router.replace('/operator/' + user.tatamiId);
          return;
        }
        setReady(true);
      })
      .catch((e) => {
        if (!active) return;
        if (e instanceof ApiError && e.status === 401)
          router.replace('/login?next=' + encodeURIComponent(path));
        else setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [path, router, retry]);
  if (failed)
    return (
      <div className="platform access-state">
        <section className="panel form-panel" role="alert">
          <h1>{text('Нет связи с сервером', 'Сервермен байланыс жоқ')}</h1>
          <p>
            {text(
              'Проверьте подключение и повторите проверку доступа.',
              'Қосылымды тексеріп, рұқсатты қайта тексеріңіз.',
            )}
          </p>
          <button onClick={() => setRetry((v) => v + 1)}>{text('Повторить', 'Қайталау')}</button>
        </section>
      </div>
    );
  return ready ? (
    children
  ) : (
    <div style={{ padding: 40 }}>{text('Проверяем доступ…', 'Рұқсат тексерілуде…')}</div>
  );
}
