'use client';
import { LiveBoard } from '../live/live-board';
import { QueueView, type QueueItem } from './queue-view';
import { Invitations } from '../auth/invitations';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, request } from '../tournaments/api';
import { useLanguage, LanguageSwitch } from '../../shared/i18n/provider';
import { pollSnapshots } from '../../shared/live/snapshot-poller';
type Tatami = {
  id: string;
  number: number;
  status: string;
  tournamentId: string;
  tournament: { name: string; city: string };
  controlAvailable: boolean;
  queue: QueueItem[];
};
export function TatamiPanel({
  tournamentId,
  tatamiId,
  display = false,
}: {
  tournamentId: string;
  tatamiId: string;
  display?: boolean;
}) {
  const { text } = useLanguage();
  const [data, setData] = useState<Tatami | null>(null),
    [error, setError] = useState(false),
    [copied, setCopied] = useState(false);
  useEffect(() => {
    setData(null);
    setError(false);
    const poller = pollSnapshots(
      () => request<Tatami>(`/tournaments/${tournamentId}/tatamis/${tatamiId}`),
      (v) => {
        setData(v);
        setError(false);
      },
      (error) => {
        if (error instanceof ApiError && [401, 403, 404].includes(error.status)) setData(null);
        setError(true);
      },
      5000,
    );
    void poller.refresh();
    return () => poller.stop();
  }, [tournamentId, tatamiId]);
  const url = `/tournaments/${tournamentId}/tatamis/${tatamiId}/display`;
  async function copy() {
    try {
      await navigator.clipboard.writeText(new URL(url, window.location.origin).href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  if (error && !data)
    return (
      <div className="panel state-box" role="alert">
        {text(
          'Татами не найдено или сервер недоступен.',
          'Татами табылмады немесе сервер қолжетімсіз.',
        )}
      </div>
    );
  if (!data)
    return <div className="panel state-box">{text('Загружаем татами…', 'Татами жүктелуде…')}</div>;
  return (
    <section className={display ? 'tatami-display' : 'tatami-manage'}>
      {error && (
        <p className="error-box" role="alert">
          {text(
            'Нет связи — показаны последние полученные данные. Повторяем подключение.',
            'Байланыс жоқ — соңғы алынған деректер көрсетілген. Қайта қосылудамыз.',
          )}
        </p>
      )}
      {!display && (
        <Link className="back-link" href={`/tournaments/${tournamentId}`}>
          ← {text('К турниру', 'Турнирге оралу')}
        </Link>
      )}
      <div className="page-heading">
        <div>
          <p className="kicker">{data.tournament.name}</p>
          <h1>
            {text('Татами', 'Татами')} {data.number}
          </h1>
          <p>{data.tournament.city}</p>
        </div>
        {display && <LanguageSwitch />}
      </div>
      {!display && (
        <Link className="solid-link" href={`/operator/${tatamiId}`}>
          {text('Открыть пульт судьи', 'Төреші пультін ашу')} →
        </Link>
      )}
      {display && <LiveBoard key={tatamiId} tatamiId={tatamiId} />}
      {!display && (
        <div className="tatami-access-grid">
          <section className="panel form-panel">
            <h2>{text('Зрительский экран', 'Көрермен экраны')}</h2>
            <p className="field-note">
              {text(
                'Ссылка открывает только просмотр этого татами. Управлять счётом по ней нельзя. Сейчас доступна на этом компьютере.',
                'Сілтеме тек осы татамиді көруге арналған. Ол арқылы есепті басқару мүмкін емес. Қазір тек осы компьютерде қолжетімді.',
              )}
            </p>
            <div className="button-row">
              <Link className="solid-link" href={url}>
                {text('Открыть экран', 'Экранды ашу')} ↗
              </Link>
              <button style={{ marginLeft: 8 }} onClick={copy}>
                {copied
                  ? text('Скопировано', 'Көшірілді')
                  : text('Скопировать ссылку', 'Сілтемені көшіру')}
              </button>
            </div>
          </section>
          <Invitations tatamiId={tatamiId} />
        </div>
      )}
      <QueueView items={data.queue} />
    </section>
  );
}
