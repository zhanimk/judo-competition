'use client';
import { ResultsTable, type ResultContest } from '../live/results-table';
import { subscribeTournament } from '../../shared/live/subscribe';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import type { Draw, Slot } from '@judo/engine/draw';
import { ProtocolDownload } from './protocol-download';
import { AuthGate } from '../auth/auth-gate';
import { request } from '../tournaments/api';
import type { Tournament, Category } from '../tournaments/types';
import { useLanguage, LanguageSwitch } from '../../shared/i18n/provider';
import '../../components/layout/platform.css';
import './protocol.css';
type RecordDraw = {
  id: string;
  version: number;
  status: string;
  confirmedAt: string | null;
  snapshot: Draw;
  contests: ResultContest[];
};
type Data = { tournament: Tournament; draws: Record<string, RecordDraw | null> };
function ProtocolContent({ tournamentId }: { tournamentId: string }) {
  const { text, locale } = useLanguage();
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0);
  useEffect(
    () =>
      subscribeTournament(tournamentId, (e) => {
        if (e.kind === 'result') setRetry((v) => v + 1);
      }),
    [tournamentId],
  );
  useEffect(() => {
    let active = true;
    setError(false);
    setData(null);
    async function load() {
      try {
        const t = await request<Tournament>(`/tournaments/${tournamentId}`);
        const rows = await Promise.all(
          t.categories.map(
            async (c) =>
              [
                c.id,
                (await request<{ draw: RecordDraw | null }>(`/categories/${c.id}/draw`)).draw,
              ] as const,
          ),
        );
        if (active) setData({ tournament: t, draws: Object.fromEntries(rows) });
      } catch {
        if (active) setError(true);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [tournamentId, retry]);
  const name = (c: Category, slot: Slot) => {
    if ('winnerOf' in slot) return text('Победитель ', 'Жеңімпаз ') + slot.winnerOf;
    if ('loserOf' in slot) return text('Проигравший ', 'Жеңілген ') + slot.loserOf;
    if ('pool' in slot) return text('Группа ', 'Топ ') + slot.pool + ' · ' + slot.place;
    const e = c.entries?.find((e) => e.id === slot.entryId);
    return e ? `${e.lastName} ${e.firstName} · ${e.club}` : text('Нет данных', 'Дерек жоқ');
  };
  return (
    <div className="platform protocol-shell">
      <div className="protocol-document">
        <div className="protocol-tools">
          <Link href={`/tournaments/${tournamentId}`}>← {text('К турниру', 'Турнирге')}</Link>
          <LanguageSwitch />
          <ProtocolDownload tournamentId={tournamentId} />
          <button disabled={!data} onClick={() => window.print()}>
            {text('Печать / сохранить PDF', 'Басып шығару / PDF сақтау')}
          </button>
        </div>
        {error ? (
          <div className="error-box" role="alert">
            {text('Не удалось загрузить протокол.', 'Хаттаманы жүктеу мүмкін болмады.')}{' '}
            <button onClick={() => setRetry((v) => v + 1)}>{text('Повторить', 'Қайталау')}</button>
          </div>
        ) : !data ? (
          <p role="status">{text('Готовим протокол…', 'Хаттама дайындалуда…')}</p>
        ) : (
          <>
            <header className="protocol-title">
              <p>Judo Child League</p>
              <h1>{text('Протокол турнира', 'Турнир хаттамасы')}</h1>
              <h2>{data.tournament.name}</h2>
              <p>
                {data.tournament.city} · {data.tournament.venue}
                <br />
                {data.tournament.startDate} — {data.tournament.endDate}
              </p>
              <p>
                {data.tournament.categories.reduce((n, c) => n + (c.entries?.length ?? 0), 0)}{' '}
                {text('участников', 'қатысушы')} · {data.tournament.categories.length}{' '}
                {text('категорий', 'санат')}
              </p>
              <p className="protocol-notice">
                {text(
                  'Пользовательский регламент, не подтверждённый профиль IJF. Подтверждённые результаты добавляются автоматически.',
                  'Бапталатын ережелер, IJF профилі расталмаған. Расталған нәтижелер автоматты түрде қосылады.',
                )}
              </p>
            </header>
            {data.tournament.categories.map((c) => {
              const d = data.draws[c.id],
                entries = c.entries ?? [];
              const club = (slot: Slot) =>
                'entryId' in slot
                  ? entries
                      .find((e) => e.id === slot.entryId)
                      ?.club.normalize('NFKC')
                      .trim()
                      .replace(/\s+/g, ' ')
                      .toLocaleLowerCase()
                  : undefined;
              return (
                <section className="protocol-category" key={c.id}>
                  <h2>{c.name}</h2>
                  <div className="protocol-tools">
                    <ProtocolDownload tournamentId={tournamentId} categoryId={c.id} />
                  </div>
                  <p>
                    {c.format === 'ROUND_ROBIN'
                      ? text('Круговая — каждый с каждым', 'Айналмалы — әрқайсысы әрқайсысымен')
                      : text('Выбывание без утешения', 'Жұбаныш белдесулерінсіз шығару')}
                  </p>
                  <p>
                    {c.birthYearFrom}–{c.birthYearTo} ·{' '}
                    {c.maxWeightGrams === null
                      ? `+${(c.minWeightGrams ?? 0) / 1000}`
                      : `−${c.maxWeightGrams / 1000}`}{' '}
                    {text('кг', 'кг')} · {c.durationSeconds} {text('секунд', 'секунд')} ·{' '}
                    {entries.length} {text('участников', 'қатысушы')}
                  </p>
                  <h3>{text('Состав категории', 'Санат құрамы')}</h3>
                  <table>
                    <thead>
                      <tr>
                        <th>№</th>
                        <th>{text('Спортсмен', 'Спортшы')}</th>
                        <th>{text('Год рождения', 'Туған жылы')}</th>
                        <th>{text('Клуб', 'Клуб')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e, i) => (
                        <tr key={e.id}>
                          <td>{i + 1}</td>
                          <td>
                            {e.lastName} {e.firstName}
                          </td>
                          <td>{e.birthYear}</td>
                          <td>{e.club}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!d ? (
                    <p className="protocol-notice">
                      {text('Жеребьёвка ещё не проведена.', 'Жеребе әлі өткізілмеген.')}
                    </p>
                  ) : (
                    <>
                      <ResultsTable entries={entries} contests={d.contests ?? []} />
                      <h3>{text('Пары по раундам', 'Айналымдар бойынша жұптар')}</h3>
                      <p>
                        {d.status === 'CONFIRMED'
                          ? text('Подтверждено', 'Расталған')
                          : text(
                              'ПРЕДВАРИТЕЛЬНО — не подтверждено',
                              'АЛДЫН АЛА — расталмаған',
                            )}{' '}
                        · {text('Версия', 'Нұсқа')} {d.version} · BYE{' '}
                        {d.snapshot.positions.filter((p) => !p).length}
                        {d.confirmedAt
                          ? ' · ' +
                            new Intl.DateTimeFormat(locale === 'kk' ? 'kk-KZ' : 'ru-RU', {
                              dateStyle: 'short',
                              timeStyle: 'short',
                              timeZone: 'Asia/Almaty',
                            }).format(new Date(d.confirmedAt)) +
                            ' (Asia/Almaty)'
                          : ''}
                      </p>
                      <table>
                        <thead>
                          <tr>
                            <th>{text('Схватка', 'Белдесу')}</th>
                            <th>{text('Белый', 'Ақ')}</th>
                            <th>{text('Синий', 'Көк')}</th>
                            <th>{text('Примечание', 'Ескертпе')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {d.snapshot.matches.map((m) => {
                            const same = club(m.white) && club(m.white) === club(m.blue);
                            return (
                              <tr key={m.id}>
                                <td>{m.id}</td>
                                <td>{name(c, m.white)}</td>
                                <td>{name(c, m.blue)}</td>
                                <td>{same ? text('Один клуб', 'Бір клуб') : '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {d.snapshot.positions.some((p) => !p) && (
                        <>
                          <h3>
                            {text(
                              'Свободный проход первого круга (BYE)',
                              'Бірінші айналымнан белдесусіз өту (BYE)',
                            )}
                          </h3>
                          <ul>
                            {d.snapshot.positions.flatMap((p, i) =>
                              p && !d.snapshot.positions[i ^ 1]
                                ? [<li key={p.id}>{name(c, { entryId: p.id })}</li>]
                                : [],
                            )}
                          </ul>
                        </>
                      )}
                      <p>
                        {text(
                          'Одноклубных пар первого круга',
                          'Бірінші айналымдағы бір клуб жұптары',
                        )}
                        : {d.snapshot.firstRoundClubPairs}.{' '}
                        {text(
                          c.format === 'ROUND_ROBIN'
                            ? 'Встречаются все пары, включая одноклубников.'
                            : 'Разведение клубов — эвристика; при преобладании одного клуба встречи могут быть неизбежны.',
                          c.format === 'ROUND_ROBIN'
                            ? 'Клубтастарды қоса барлық жұптар кездеседі.'
                            : 'Клубтарды бөлу — эвристика; бір клуб басым болғанда кездесулерді болдырмау мүмкін емес.',
                        )}
                      </p>
                    </>
                  )}
                </section>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
export function DrawProtocol({ tournamentId }: { tournamentId: string }) {
  return (
    <AuthGate>
      <ProtocolContent tournamentId={tournamentId} />
    </AuthGate>
  );
}
