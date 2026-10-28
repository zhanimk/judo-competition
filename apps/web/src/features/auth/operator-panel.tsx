'use client';
import { useEffect, useState } from 'react';
import { LiveBoard } from '../live/live-board';
import { QueueView, type QueueItem } from '../tatamis/queue-view';
import Link from 'next/link';
import { readJournal } from '../offline/storage';
import { request, ApiError } from '../tournaments/api';
import { useLanguage, LanguageSwitch } from '../../shared/i18n/provider';
import '../../components/layout/platform.css';
import './operator-panel.css';
import { logoutSession } from './logout';
type Control = {
  tournamentId: string;
  role: string;
  workRole: 'ADMIN' | 'JUDGE';
  number: number;
  tournamentName: string;
  operatorName: string;
  matchCommandsAvailable: boolean;
  queue: QueueItem[];
};
export function OperatorPanel({ tatamiId }: { tatamiId: string }) {
  const { text } = useLanguage();
  const [data, setData] = useState<Control | null>(null),
    [denied, setDenied] = useState(false),
    [local, setLocal] = useState(false),
    [failed, setFailed] = useState(false),
    [logoutError, setLogoutError] = useState(false),
    [loggingOut, setLoggingOut] = useState(false);
  useEffect(() => {
    let active = true;
    let checking = false;
    setData(null);
    setDenied(false);
    setFailed(false);
    setLocal(false);
    async function check() {
      if (checking) return;
      checking = true;
      try {
        const saved = await readJournal('active:' + tatamiId).catch(() => null);
        if (active) setLocal(!!saved);
        const v = await request<Control>(`/auth/tatamis/${tatamiId}/control`);
        if (active) {
          setData(v);
          setDenied(false);
          setFailed(false);
        }
      } catch (e) {
        if (active) {
          if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
            setDenied(true);
            setFailed(false);
          } else setFailed(true);
        }
      } finally {
        checking = false;
      }
    }
    void check();
    const timer = setInterval(check, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [tatamiId]);
  return (
    <div className="platform">
      <div className="platform-content operator-content">
        <div className="form-actions">
          <LanguageSwitch />
          {data && ['SUPER_ADMIN', 'ORGANIZER'].includes(data.role) && (
            <Link className="outline-link" href={`/tournaments/${data.tournamentId}/control`}>
              ← {text('Все татами', 'Барлық татами')}
            </Link>
          )}
        </div>
        {failed && !local && (
          <p className="error-box" role="alert">
            {text(
              'Нет связи с сервером. Повторяем проверку доступа.',
              'Сервермен байланыс жоқ. Рұқсат қайта тексерілуде.',
            )}
          </p>
        )}
        {logoutError && (
          <p className="error-box" role="alert">
            {text('Выход не выполнен. Повторите.', 'Жүйеден шығу орындалмады. Қайталаңыз.')}
          </p>
        )}
        {denied && !local ? (
          <section className="panel empty-state">
            <h1>{text('Доступ закрыт', 'Рұқсат жабық')}</h1>
            <p>
              {text(
                'Сессия истекла, отозвана или не относится к этому татами.',
                'Сессия мерзімі аяқталған, күші жойылған немесе бұл татамиге қатысы жоқ.',
              )}
            </p>
            <Link href="/login">{text('Войти', 'Кіру')}</Link>
          </section>
        ) : data || local ? (
          <>
            <div className="page-heading operator-heading">
              <div>
                <p className="kicker">{data?.tournamentName}</p>
                <p>
                  {data?.workRole === 'ADMIN'
                    ? text('Администратор', 'Әкімші')
                    : text('Судья табло', 'Табло төрешісі')}
                  :{' '}
                  {data?.operatorName ??
                    text('Локальное восстановление', 'Жергілікті қалпына келтіру')}
                </p>
              </div>
              <details className="operator-account">
                <summary>{text('Аккаунт', 'Аккаунт')}</summary>
                <button
                  disabled={local || loggingOut}
                  onClick={async () => {
                    setLoggingOut(true);
                    setLogoutError(false);
                    try {
                      await logoutSession();
                      location.href = '/login';
                    } catch {
                      setLogoutError(true);
                      setLoggingOut(false);
                    }
                  }}
                >
                  {text('Выйти из аккаунта', 'Аккаунттан шығу')}
                </button>
              </details>
            </div>
            <LiveBoard key={tatamiId} tatamiId={tatamiId} operator />
            {data && !local && <QueueView items={data.queue} />}
          </>
        ) : (
          <p>{text('Проверяем доступ…', 'Рұқсат тексерілуде…')}</p>
        )}
      </div>
    </div>
  );
}
