'use client';
import { ResultsTable, type ResultContest } from '../live/results-table';
import { subscribeTournament } from '../../shared/live/subscribe';
import { pollSnapshots } from '../../shared/live/snapshot-poller';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { drawFormat, type Draw, type Slot } from '@judo/engine/draw';
import { formatLabel } from './format-label';
import { protocolDrawView } from './protocol-view';
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
    [error, setError] = useState(false);
  const pollerRef = useRef<ReturnType<typeof pollSnapshots<Data>> | null>(null);
  useEffect(() => {
    setError(false);
    setData(null);
    const poller = pollSnapshots(
      async () => {
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
        return { tournament: t, draws: Object.fromEntries(rows) };
      },
      (value) => {
        setData(value);
        setError(false);
      },
      () => setError(true),
      5000,
    );
    pollerRef.current = poller;
    void poller.refresh();
    const unsubscribe = subscribeTournament(tournamentId, (event) => {
      if (event.kind !== 'state') void poller.refresh();
    });
    return () => {
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
      unsubscribe();
    };
  }, [tournamentId]);
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
          <button disabled={!data || error} onClick={() => window.print()}>
            {text('Печать / сохранить PDF', 'Басып шығару / PDF сақтау')}
          </button>
        </div>
        {error ? (
          <div className="error-box" role="alert">
            {text('Не удалось загрузить протокол.', 'Хаттаманы жүктеу мүмкін болмады.')}{' '}
            <button onClick={() => void pollerRef.current?.refresh()}>
              {text('Повторить', 'Қайталау')}
            </button>
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
              const view =
                d && d.status !== 'STALE'
                  ? protocolDrawView(d.snapshot, d.status, d.contests ?? [])
                  : null;
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
                  <p>{formatLabel(d ? drawFormat(d.snapshot) : c.format, locale)}</p>
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
                  {!d || d.status === 'STALE' ? (
                    <p className="protocol-notice">
                      {d?.status === 'STALE'
                        ? text(
                            'Состав изменился. Повторите жеребьёвку перед выпуском сетки.',
                            'Құрам өзгерді. Торды шығармай тұрып жеребені қайталаңыз.',
                          )
                        : text('Жеребьёвка ещё не проведена.', 'Жеребе әлі өткізілмеген.')}
                    </p>
                  ) : (
                    <>
                      <ResultsTable entries={entries} contests={d.contests ?? []} printAll />
                      {!!view?.pendingReviews.length && (
                        <p className="protocol-notice" role="status">
                          {text(
                            'Равенство трёх и более участников: требуется решение администратора. Итоговые места и выход из групп ожидают завершения дополнительной процедуры.',
                            'Үш не одан көп қатысушының көрсеткіші тең: әкімшінің шешімі қажет. Қорытынды орындар мен топтан шығу қосымша рәсім аяқталғаннан кейін анықталады.',
                          )}
                        </p>
                      )}
                      {view?.places && (
                        <>
                          <h3>{text('Итоговые места', 'Қорытынды орындар')}</h3>
                          <table>
                            <thead>
                              <tr>
                                <th>{text('Место', 'Орын')}</th>
                                <th>{text('Спортсмен', 'Спортшы')}</th>
                                <th>{text('Клуб', 'Клуб')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {view.places.map((place) => {
                                const entry = entries.find((e) => e.id === place.entryId);
                                return (
                                  <tr key={place.entryId}>
                                    <td>{place.place}</td>
                                    <td>
                                      {entry
                                        ? `${entry.lastName} ${entry.firstName}`
                                        : text('Нет данных', 'Дерек жоқ')}
                                    </td>
                                    <td>{entry?.club ?? '—'}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </>
                      )}
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
                          {view?.matches.map((m) => {
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
