'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, request } from '../tournaments/api';
import { useLanguage } from '../../shared/i18n/provider';
import { authMessage } from './messages';
import './operator-panel.css';
import { isRevision, retainUncertainCommand } from './control-model';
import {
  invitationToken,
  restoreInvitationPending,
  validateInvitationReceipt,
  type InvitationPending,
} from './invitation-model';
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
    [revision, setRevision] = useState<number | null>(null);
  const [label, setLabel] = useState(''),
    [hours, setHours] = useState(8);
  const [issued, setIssued] = useState<{ id: string; token: string } | null>(null);
  const [reason, setReason] = useState(''),
    [revoking, setRevoking] = useState<string | null>(null);
  const [pending, setPending] = useState<InvitationPending | null>(null),
    [corrupt, setCorrupt] = useState(false);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [connected, setConnected] = useState(false);
  const currentRevision = useRef<number | null>(null),
    writing = useRef(false),
    reading = useRef(false);
  const pendingRef = useRef<InvitationPending | null>(null),
    generation = useRef(0);
  const completedRead = useRef<Promise<void>>(Promise.resolve()),
    finishRead = useRef(() => {});
  const key = 'judo.invitation.pending.' + tatamiId;
  const load = useCallback(async () => {
    if (reading.current) return null;
    reading.current = true;
    completedRead.current = new Promise<void>((resolve) => {
      finishRead.current = resolve;
    });
    const gen = generation.current;
    try {
      const [rows, access] = await Promise.all([
        request<Invite[]>('/auth/tatamis/' + tatamiId + '/invitations'),
        request<{ accessRevision: number }>('/auth/tatamis/' + tatamiId + '/control'),
      ]);
      if (!isRevision(access.accessRevision)) throw new Error('INVALID_CONTROL_RECEIPT');
      if (gen !== generation.current) return null;
      if (currentRevision.current === null || access.accessRevision >= currentRevision.current) {
        currentRevision.current = access.accessRevision;
        setRevision(access.accessRevision);
        setItems(rows);
      }
      setIssued((old) =>
        old &&
        rows.some(
          (i) =>
            i.id === old.id &&
            !i.usedAt &&
            !i.revokedAt &&
            new Date(i.expiresAt).getTime() > Date.now(),
        )
          ? old
          : null,
      );
      setConnected(true);
      return rows;
    } catch (e) {
      if (gen === generation.current) {
        setConnected(false);
        setError(e instanceof Error ? e.message : 'LOAD_FAILED');
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) {
          setIssued(null);
          setItems([]);
        }
      }
      return null;
    } finally {
      reading.current = false;
      finishRead.current();
    }
  }, [tatamiId]);
  useEffect(() => {
    generation.current++;
    currentRevision.current = null;
    setRevision(null);
    setItems([]);
    setIssued(null);
    pendingRef.current = null;
    setPending(null);
    setCorrupt(false);
    setError('');
    try {
      const raw = sessionStorage.getItem(key);
      if (raw) {
        const p = restoreInvitationPending(raw, tatamiId);
        pendingRef.current = p;
        setPending(p);
      }
    } catch {
      setCorrupt(true);
      setError('SAVED_INVITATION_INVALID');
    }
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [key, load, tatamiId]);
  function remember(value: InvitationPending | null) {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
    pendingRef.current = value;
    setPending(value);
  }
  async function execute(value: InvitationPending) {
    if (writing.current || corrupt) return;
    writing.current = true;
    setBusy(true);
    setError('');
    try {
      if (pendingRef.current && JSON.stringify(pendingRef.current) !== JSON.stringify(value))
        throw new Error('INVITATION_PENDING');
      remember(structuredClone(value));
      generation.current++;
      const response = validateInvitationReceipt(
        value,
        await request(
          value.kind === 'CREATE'
            ? '/auth/tatamis/' + tatamiId + '/invitations'
            : '/auth/invitations/' + value.invitationId + '/revoke',
          value.body,
        ),
      );
      if (currentRevision.current === null || response.revision! >= currentRevision.current) {
        currentRevision.current = response.revision!;
        setRevision(response.revision!);
      }
      setRevoking(null);
      setReason('');
      await completedRead.current;
      const rows = await load();
      if (value.kind === 'CREATE' && !rows) throw new Error('INVITATION_STATUS_UNKNOWN');
      remember(null);
      if (
        value.kind === 'CREATE' &&
        rows?.some(
          (i) =>
            i.id === response.id &&
            !i.usedAt &&
            !i.revokedAt &&
            new Date(i.expiresAt).getTime() > Date.now(),
        )
      )
        setIssued({ id: response.id!, token: value.body.token });
      else setIssued(null);
    } catch (e) {
      if (e instanceof ApiError && !retainUncertainCommand(e.status, e.message)) remember(null);
      setError(e instanceof Error ? e.message : 'INVITATION_FAILED');
      await load();
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  const disabled = busy || !!pending || corrupt || revision === null || !connected;
  return (
    <section className="panel form-panel">
      <h2>{text('Доступ судьи табло', 'Табло төрешісіне рұқсат')}</h2>
      <p className="field-note">
        {text(
          'Одноразовая ссылка только на это татами. Доступ заканчивается по сроку приглашения, не позднее 8 часов после активации. Отзыв закрывает доступ; управление передаёт администратор.',
          'Тек осы татамиге арналған бір реттік сілтеме. Рұқсат шақыру мерзімімен, белсендірілгеннен кейін ең көбі 8 сағатпен шектеледі. Күшін жою рұқсатты жабады; басқаруды әкімші береді.',
        )}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (disabled) return;
          void execute({
            kind: 'CREATE',
            tatamiId,
            body: {
              id: crypto.randomUUID(),
              expectedRevision: revision!,
              label: label.trim(),
              hours,
              token: invitationToken(),
            },
          });
        }}
      >
        <label>
          {text('Кому выдаётся ссылка', 'Сілтеме кімге беріледі')}
          <input
            required
            minLength={2}
            maxLength={80}
            disabled={disabled}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label>
          {text('Срок приглашения, часов', 'Шақыру мерзімі, сағат')}
          <input
            type="number"
            min={1}
            max={48}
            disabled={disabled}
            value={hours}
            onChange={(e) => setHours(+e.target.value)}
          />
        </label>
        <button className="solid-button" disabled={disabled}>
          {text('Создать приглашение', 'Шақыру жасау')}
        </button>
      </form>
      {issued && (
        <label style={{ marginTop: 18 }}>
          {text(
            'Скопируйте ссылку — повторно она не показывается',
            'Сілтемені көшіріңіз — ол қайта көрсетілмейді',
          )}
          <input
            readOnly
            value={new URL('/invite', location.origin).href + '#' + issued.token}
            onFocus={(e) => e.target.select()}
          />
        </label>
      )}
      {error && (
        <p className="error-box" role="alert">
          {authMessage(error, locale === 'kk')}
        </p>
      )}
      {(pending || corrupt) && (
        <div className="control-pending">
          <p>
            {text(
              'Исход команды доступа не установлен. Повтор отправит ту же команду; новая ссылка не создаётся.',
              'Рұқсат командасының нәтижесі анықталмады. Қайталау сол команданы жібереді; жаңа сілтеме жасалмайды.',
            )}
          </p>
          {pending && (
            <button disabled={busy || !connected} onClick={() => void execute(pending)}>
              {text('Повторить ту же команду', 'Сол команданы қайталау')}
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  text(
                    'Сохранить команду в локальном архиве для сверки? Это не отменяет приглашение или отзыв на сервере.',
                    'Команданы тексеру үшін жергілікті мұрағатта сақтайсыз ба? Бұл сервердегі шақыруды немесе күшін жоюды өзгертпейді.',
                  ),
                )
              )
                return;
              try {
                const raw = sessionStorage.getItem(key);
                if (raw) sessionStorage.setItem(key + '.archive.' + crypto.randomUUID(), raw);
                remember(null);
                setCorrupt(false);
                setError('');
                void load();
              } catch {
                setError('DEVICE_STORAGE_INVALID');
              }
            }}
          >
            {text('Архивировать для сверки', 'Тексеру үшін мұрағаттау')}
          </button>
        </div>
      )}
      <ul style={{ padding: 0, listStyle: 'none' }}>
        {items.map((i) => (
          <li key={i.id} style={{ padding: '14px 0', borderTop: '1px solid #ddd' }}>
            <strong>{i.label}</strong>
            <p className="field-note">
              {i.revokedAt
                ? text('Отозвано', 'Күші жойылған')
                : new Date(i.expiresAt) < new Date()
                  ? text('Срок истёк', 'Мерзімі аяқталған')
                  : i.usedAt
                    ? text('Активировано', 'Белсендірілген')
                    : text('Ожидает активации', 'Белсендіруді күтуде')}{' '}
              · {new Date(i.expiresAt).toLocaleString(locale === 'kk' ? 'kk-KZ' : 'ru-RU')}
            </p>
            {!i.revokedAt && (
              <button
                disabled={disabled}
                onClick={() => {
                  setRevoking(i.id);
                  setReason('');
                }}
              >
                {text('Отозвать доступ', 'Рұқсаттың күшін жою')}
              </button>
            )}
            {revoking === i.id && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (disabled) return;
                  void execute({
                    kind: 'REVOKE',
                    tatamiId,
                    invitationId: i.id,
                    body: {
                      id: crypto.randomUUID(),
                      expectedRevision: revision!,
                      reason: reason.trim(),
                    },
                  });
                }}
              >
                <label>
                  {text('Причина отзыва', 'Күшін жою себебі')}
                  <textarea
                    required
                    minLength={3}
                    maxLength={500}
                    disabled={disabled}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <button disabled={disabled || reason.trim().length < 3}>
                  {text('Подтвердить отзыв', 'Күшін жоюды растау')}
                </button>
                <button type="button" disabled={busy} onClick={() => setRevoking(null)}>
                  {text('Отмена', 'Болдырмау')}
                </button>
              </form>
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
