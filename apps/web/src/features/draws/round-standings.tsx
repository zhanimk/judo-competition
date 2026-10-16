'use client';
import { poolStandings, drawProgress, type Draw } from '@judo/engine/draw';
import type { Entry } from '../tournaments/types';
import type { ResultContest } from '../live/results-table';
import { useLanguage } from '../../shared/i18n/provider';
import './match-list.css';
export function RoundStandings({
  draw,
  entries,
  contests,
  poolId,
}: {
  draw: Draw;
  entries: Entry[];
  contests: ResultContest[];
  poolId?: string;
}) {
  const { text } = useLanguage();
  const members = poolId
    ? (draw.pools?.find((p) => p.id === poolId)?.entries ?? [])
    : draw.positions.flatMap((e) => (e ? [e.id] : []));
  const matches = draw.matches.filter((m) => !poolId || m.pool === poolId);
  const matchKeys = new Set(matches.map((m) => m.id));
  const confirmed = contests.filter((c) => c.status === 'CONFIRMED' && matchKeys.has(c.key));
  const winners = Object.fromEntries(
    confirmed.filter((c) => c.winnerEntryId).map((c) => [c.key, c.winnerEntryId!]),
  );
  const final = poolStandings(draw, winners, poolId);
  const awaitingReview = drawProgress(draw, winners).pendingReviews.some(
    (review) => review.pool === poolId,
  );
  const order = final?.map((r) => r.entryId) ?? members;
  return (
    <section className="round-standings">
      <div className="round-section-heading">
        <h3>{text('Таблица участников', 'Қатысушылар кестесі')}</h3>
        <span>
          {confirmed.length} / {matches.length} {text('схваток', 'белдесу')}
        </span>
      </div>
      <p className="field-note">
        {final
          ? text(
              'Все встречи подтверждены. Места определены по регламенту категории.',
              'Барлық белдесулер расталды. Орындар санат ережесі бойынша анықталды.',
            )
          : awaitingReview
            ? text(
                'Основной круг завершён. Места ожидают утверждённой процедуры при равенстве.',
                'Негізгі айналым аяқталды. Теңдік кезіндегі бекітілген рәсім аяқталғанша орындар анықталмайды.',
              )
            : text(
                'Пока идут встречи, участники показаны по номеру жребия. Итоговые места появятся после подтверждения всех результатов.',
                'Белдесулер өтіп жатқанда қатысушылар жеребе нөмірімен көрсетіледі. Қорытынды орындар барлық нәтижелер расталғаннан кейін пайда болады.',
              )}
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{text('Место', 'Орын')}</th>
              <th>{text('Участник / клуб', 'Қатысушы / клуб')}</th>
              <th>{text('Жребий', 'Жеребе')}</th>
              <th>{text('Завершено', 'Аяқталған')}</th>
              <th>
                {draw.tieRanking === 'WINS_ONLY'
                  ? text('Победы в основном круге', 'Негізгі айналымдағы жеңістер')
                  : text('Победы', 'Жеңістер')}
              </th>
              <th>{text('Поражения', 'Жеңілістер')}</th>
              <th>{text('Осталось', 'Қалғаны')}</th>
            </tr>
          </thead>
          <tbody>
            {order.map((id, index) => {
              const e = entries.find((e) => e.id === id);
              const played = confirmed.filter(
                (c) => c.whiteEntryId === id || c.blueEntryId === id,
              ).length;
              const wins = confirmed.filter(
                (c) =>
                  c.winnerEntryId === id &&
                  (draw.tieRanking !== 'WINS_ONLY' ||
                    !matches.find((match) => match.id === c.key)?.tieBreakRound),
              ).length;
              const additionalWins = confirmed.filter(
                (c) =>
                  c.winnerEntryId === id &&
                  matches.find((match) => match.id === c.key)?.tieBreakRound,
              ).length;
              const allWins = confirmed.filter((c) => c.winnerEntryId === id).length;
              const total = matches.filter(
                (m) =>
                  ('entryId' in m.white && m.white.entryId === id) ||
                  ('entryId' in m.blue && m.blue.entryId === id),
              ).length;
              return (
                <tr key={id}>
                  <td>
                    <b className="standing-place">
                      {final && !draw.withdrawnEntryIds?.includes(id) ? index + 1 : '—'}
                    </b>
                  </td>
                  <td>
                    <strong>
                      {e?.lastName} {e?.firstName}
                    </strong>
                    {draw.withdrawnEntryIds?.includes(id) && (
                      <small>
                        {text('Удалён из дальнейших встреч', 'Келесі белдесулерден шығарылған')}
                      </small>
                    )}
                    <small>{e?.club}</small>
                  </td>
                  <td>{members.indexOf(id) + 1}</td>
                  <td>
                    {played} / {total}
                  </td>
                  <td>
                    <b className="standing-wins">{wins}</b>
                    {draw.tieRanking === 'WINS_ONLY' && additionalWins > 0 && (
                      <small>
                        {text('Дополнительные', 'Қосымша')}: {additionalWins}
                      </small>
                    )}
                  </td>
                  <td>{played - allWins}</td>
                  <td>{total - played}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
