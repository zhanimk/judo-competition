'use client';
import { useEffect, useState } from 'react';
import { request } from '../tournaments/api';
import { useLanguage } from '../../shared/i18n/provider';
import { authMessage } from './messages';
type User = { id: string; email: string | null; name: string; role: string };
export function UsersPanel() {
  const { text, locale } = useLanguage();
  const [users, setUsers] = useState<User[]>([]);
  const [allowed, setAllowed] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    request<User[]>('/auth/users')
      .then((v) => {
        setUsers(v);
        setAllowed(true);
      })
      .catch((e) => setError(authMessage(e.message, locale === 'kk')))
      .finally(() => setLoading(false));
  }, [locale]);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    setDone(false);
    try {
      await request('/auth/users', {
        name: data.get('name'),
        email: data.get('email'),
        password: data.get('password'),
      });
      form.reset();
      setUsers(await request<User[]>('/auth/users'));
      setDone(true);
    } catch (e) {
      setError(authMessage((e as Error).message, locale === 'kk'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="kicker">{text('УПРАВЛЕНИЕ ДОСТУПОМ', 'РҰҚСАТТАРДЫ БАСҚАРУ')}</p>
          <h1>{text('Пользователи', 'Пайдаланушылар')}</h1>
          <p>
            {text(
              'Администраторы управляют турнирами и доступом. Судьи табло входят по приглашению на назначенное татами.',
              'Әкімшілер турнирлер мен рұқсаттарды басқарады. Табло төрешілері тағайындалған татамиге шақыру арқылы кіреді.',
            )}
          </p>
        </div>
      </div>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <p className="state-box" role="status">
          {text('Загружаем пользователей…', 'Пайдаланушылар жүктелуде…')}
        </p>
      )}
      {allowed && (
        <div className="users-grid">
          <form className="panel form-panel" onSubmit={submit}>
            <h2>{text('Новый администратор', 'Жаңа әкімші')}</h2>
            <label>
              {text('Имя', 'Аты')}
              <input name="name" required minLength={2} maxLength={80} />
            </label>
            <label>
              Email
              <input name="email" type="email" required maxLength={200} />
            </label>
            <label>
              {text('Пароль — минимум 12 символов', 'Құпиясөз — кемінде 12 таңба')}
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                maxLength={128}
              />
            </label>
            <button className="solid-button" disabled={busy}>
              {text('Создать администратора', 'Әкімшіні құру')}
            </button>
            {done && (
              <p role="status">
                {text(
                  'Учётная запись создана. Передайте данные администратору.',
                  'Тіркелгі құрылды. Деректерді әкімшіге беріңіз.',
                )}
              </p>
            )}
          </form>
          <section className="panel">
            <div className="panel-heading">
              <h2>{text('Все пользователи', 'Барлық пайдаланушылар')}</h2>
              <span>{users.length}</span>
            </div>
            {users.map((u) => (
              <p className="user-row" key={u.id}>
                <strong>{u.name}</strong> · {u.email ?? text('По приглашению', 'Шақыру арқылы')} ·{' '}
                {u.role === 'SUPER_ADMIN'
                  ? text('Администратор', 'Әкімші')
                  : u.role === 'ORGANIZER'
                    ? text('Администратор', 'Әкімші')
                    : text('Судья табло', 'Табло төрешісі')}
              </p>
            ))}
          </section>
        </div>
      )}
    </>
  );
}
