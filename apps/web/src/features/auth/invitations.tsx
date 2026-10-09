'use client';
import { useEffect, useState } from 'react';
import { request } from '../tournaments/api';
import { useLanguage } from '../../shared/i18n/provider';
import { authMessage } from './messages';
type Invite = {
  id: string;
  label: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
};
export function Invitations({ tatamiId }: { tatamiId: string }) {
  const { text, locale } = useLanguage();
  const [items, setItems] = useState<Invite[]>([]),
    [label, setLabel] = useState(''),
    [hours, setHours] = useState(8),
    [link, setLink] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  async function load() {
    try {
      setItems(await request<Invite[]>(`/auth/tatamis/${tatamiId}/invitations`));
    } catch (e) {
      setError(authMessage((e as Error).message, locale === 'kk'));
    }
  }
  useEffect(() => {
    void load();
  }, [tatamiId]);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await request<{ token: string }>(`/auth/tatamis/${tatamiId}/invitations`, {
        label,
        hours,
      });
      setLink(new URL('/invite', location.origin).href + '#' + result.token);
      await load();
    } catch (e) {
      setError(authMessage((e as Error).message, locale === 'kk'));
    } finally {
      setBusy(false);
    }
  }
  async function revoke(id: string) {
    setBusy(true);
    try {
      await request(`/auth/invitations/${id}/revoke`, {});
      setLink('');
      await load();
    } catch (e) {
      setError(authMessage((e as Error).message, locale === 'kk'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel form-panel">
      <h2>{text('Доступ оператора', 'Операторға рұқсат')}</h2>
      <p className="field-note">
        {text(
          'Одноразовая ссылка только на это татами. Сессия действует 8 часов. Отзыв приглашения сразу закрывает доступ.',
          'Тек осы татамиге арналған бір реттік сілтеме. Сессия 8 сағат жарамды. Шақырудың күшін жою рұқсатты дереу жабады.',
        )}
      </p>
      <form onSubmit={create}>
        <label>
          {text('Кому выдаётся ссылка', 'Сілтеме кімге беріледі')}
          <input
            required
            minLength={2}
            maxLength={80}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          {text('Срок активации, часов', 'Белсендіру мерзімі, сағат')}
          <input
            type="number"
            min={1}
            max={48}
            value={hours}
            onChange={(e) => setHours(+e.target.value)}
          />
        </label>
        <button className="solid-button" disabled={busy}>
          {text('Создать приглашение', 'Шақыру жасау')}
        </button>
      </form>
      {link && (
        <label style={{ marginTop: 18 }}>
          {text(
            'Скопируйте ссылку — повторно она не показывается',
            'Сілтемені көшіріңіз — ол қайта көрсетілмейді',
          )}
          <input readOnly value={link} onFocus={(e) => e.target.select()} />
        </label>
      )}
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      <ul style={{ padding: 0, listStyle: 'none' }}>
        {items.map((i) => (
          <li key={i.id} style={{ padding: '14px 0', borderTop: '1px solid #ddd' }}>
            <strong>{i.label}</strong>
            <p className="field-note">
              {i.revokedAt
                ? text('Отозвано', 'Күші жойылған')
                : i.usedAt
                  ? text('Активировано', 'Белсендірілген')
                  : new Date(i.expiresAt) < new Date()
                    ? text('Срок истёк', 'Мерзімі аяқталған')
                    : text('Ожидает активации', 'Белсендіруді күтуде')}{' '}
              · {new Date(i.expiresAt).toLocaleString(locale === 'kk' ? 'kk-KZ' : 'ru-RU')}
            </p>
            {!i.revokedAt && (
              <button disabled={busy} onClick={() => void revoke(i.id)}>
                {text('Отозвать доступ', 'Рұқсаттың күшін жою')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="field-note">
        {text(
          'Сейчас ссылки работают на этом компьютере. Для устройств в зале потребуется сетевое развёртывание с HTTPS.',
          'Қазір сілтемелер осы компьютерде жұмыс істейді. Залдағы құрылғылар үшін HTTPS арқылы желіге орналастыру қажет.',
        )}
      </p>
    </section>
  );
}
