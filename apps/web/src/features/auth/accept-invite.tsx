'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { request } from '../tournaments/api';
import { useLanguage, LanguageSwitch } from '../../shared/i18n/provider';
import { authMessage } from './messages';
import '../../components/layout/platform.css';
export function AcceptInvite() {
  const { text, locale } = useLanguage();
  const router = useRouter();
  const [token, setToken] = useState(''),
    [name, setName] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const incomingToken = window.location.hash.slice(1);
    if (incomingToken) setToken(incomingToken);
    history.replaceState(null, '', '/invite');
  }, []);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await request<{ tatamiId: string }>('/auth/invitations/accept', {
        token,
        name,
      });
      router.replace('/operator/' + result.tatamiId);
    } catch (e) {
      setError(authMessage((e as Error).message, locale === 'kk'));
      setBusy(false);
    }
  }
  return (
    <div
      className="platform"
      style={{ alignItems: 'center', justifyContent: 'center', padding: 24 }}
    >
      <form className="panel form-panel" style={{ maxWidth: 480, width: '100%' }} onSubmit={submit}>
        <LanguageSwitch />
        <h1 style={{ marginTop: 24 }}>{text('Приглашение оператора', 'Операторды шақыру')}</h1>
        <p className="field-note">
          {text(
            'Ссылка одноразовая. Активация заменит текущую сессию во всех вкладках этого браузера.',
            'Сілтеме бір рет қолданылады. Белсендіру осы браузердің барлық қойындыларындағы ағымдағы сессияны ауыстырады.',
          )}
        </p>
        <label>
          {text('Ваше имя', 'Атыңыз')}
          <input
            required
            minLength={2}
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {!token && (
          <p>
            {text(
              'Откройте полную ссылку, полученную от организатора.',
              'Ұйымдастырушы жіберген толық сілтемені ашыңыз.',
            )}
          </p>
        )}
        {error && (
          <p className="error-box" role="alert">
            {error}
          </p>
        )}
        <button className="solid-button" disabled={!token || busy}>
          {text('Принять приглашение', 'Шақыруды қабылдау')}
        </button>
      </form>
    </div>
  );
}
