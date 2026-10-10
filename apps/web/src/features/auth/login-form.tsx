'use client';
import { Brand } from '../../components/layout/brand';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { request } from '../tournaments/api';
import { useLanguage, LanguageSwitch } from '../../shared/i18n/provider';
import { authMessage } from './messages';
import '../../components/layout/platform.css';
export function LoginForm() {
  const { text, locale } = useLanguage();
  const router = useRouter();
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await request('/auth/login', { email, password });
      const me = await request<{ role: string; tatamiId: string | null }>('/auth/me');
      const target = new URLSearchParams(window.location.search).get('next');
      router.replace(
        me.role === 'OPERATOR'
          ? '/operator/' + me.tatamiId
          : target?.startsWith('/') && !target.startsWith('//') && !target.includes('\\')
            ? target
            : '/',
      );
    } catch (e) {
      setError(authMessage((e as Error).message, locale === 'kk'));
      setBusy(false);
    }
  }
  return (
    <div
      className="platform"
      style={{ justifyContent: 'center', alignItems: 'center', padding: 24 }}
    >
      <form className="panel form-panel" style={{ width: '100%', maxWidth: 460 }} onSubmit={submit}>
        <div className="login-brand-row">
          <Brand />
          <LanguageSwitch />
        </div>
        <h1>{text('Вход в систему', 'Жүйеге кіру')}</h1>
        <p className="field-note">
          {text(
            'Администратор управляет турниром и выдаёт судье доступ к табло назначенного татами.',
            'Әкімші турнирді басқарып, төрешіге тағайындалған татами таблосына рұқсат береді.',
          )}
        </p>
        <label>
          Email
          <input
            type="email"
            required
            maxLength={200}
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          {text('Пароль', 'Құпиясөз')}
          <input
            type="password"
            required
            minLength={1}
            maxLength={128}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="error-box">
            {error}
          </p>
        )}
        <button className="solid-button" disabled={busy} style={{ width: '100%' }}>
          {busy ? text('Подождите…', 'Күтіңіз…') : text('Войти', 'Кіру')}
        </button>
      </form>
    </div>
  );
}
