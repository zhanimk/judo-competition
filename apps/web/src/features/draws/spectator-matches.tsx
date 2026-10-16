'use client';
import type { Draw } from '@judo/engine/draw';
import type { Entry } from '../tournaments/types';
import { ScoreSummary, type ResultContest } from '../live/results-table';
import { resultReasonLabel } from '../live/labels';
import { useLanguage } from '../../shared/i18n/provider';
import './spectator-matches.css';

export function SpectatorMatches({
  draw,
  entries,
  contests,
  tatamis,
}: {
  draw: Draw;
  entries: Entry[];
  contests: (ResultContest & { tatamiId: string | null })[];
  tatamis: { id: string; number: number }[];
}) {
  const { text, locale } = useLanguage();
  const people = new Map(entries.map((entry) => [entry.id, entry]));
  const results = new Map(contests.map((contest) => [contest.key, contest]));
  const rows = draw.matches.flatMap((match) => {
    const contest = results.get(match.id);
    const white = people.get(
      contest?.whiteEntryId ?? ('entryId' in match.white ? match.white.entryId : ''),
    );
    const blue = people.get(
      contest?.blueEntryId ?? ('entryId' in match.blue ? match.blue.entryId : ''),
    );
    // Future pairs appear when both participants are known. No empty bracket placeholders.
    return white && blue ? [{ match, contest, white, blue }] : [];
  });
  const rounds = [...new Set(rows.map((row) => row.match.round))].sort((a, b) => a - b);
  const name = (entry: Entry) => `${entry.lastName} ${entry.firstName}`;
  if (!rows.length) return null;
  return (
    <div className="spectator-match-list">
      {rounds.map((round) => (
        <section key={round}>
          <h3>
            {draw.matches.every((match) => match.stage === 'REPECHAGE' || match.stage === 'BRONZE')
              ? text('Утешение и бронза', 'Жұбаныш және қола')
              : `${text('Тур', 'Айналым')} ${round}`}
          </h3>
          <div className="spectator-round-pairs">
            {rows
              .filter((row) => row.match.round === round)
              .map(({ match, contest, white, blue }) => {
                const confirmed = contest?.status === 'CONFIRMED';
                const winner =
                  confirmed && contest.winnerEntryId ? people.get(contest.winnerEntryId) : null;
                const mat = tatamis.find((mat) => mat.id === contest?.tatamiId);
                return (
                  <details className="spectator-match-row" key={match.id}>
                    <summary>
                      <span className="spectator-pair-heading">
                        <span>№ {draw.matches.findIndex((item) => item.id === match.id) + 1}</span>
                        {contest?.status === 'ACTIVE' && (
                          <span className="spectator-live-badge">
                            {text('Идёт схватка', 'Белдесу жүріп жатыр')}
                          </span>
                        )}
                        {confirmed && !winner && (
                          <span>{text('Без победителя', 'Жеңімпаз жоқ')}</span>
                        )}
                        <span className="spectator-pair-expand" aria-hidden="true">
                          ⌄
                        </span>
                      </span>
                      {(
                        [
                          ['WHITE', white],
                          ['BLUE', blue],
                        ] as const
                      ).map(([side, entry]) => (
                        <span
                          key={side}
                          className={`spectator-pair-athlete ${side.toLowerCase()} ${winner?.id === entry.id ? 'is-winner' : ''}`}
                        >
                          <span className="spectator-pair-side">
                            {side === 'WHITE' ? text('Б', 'АҚ') : text('С', 'КӨК')}
                          </span>
                          <strong>{name(entry)}</strong>
                          {winner?.id === entry.id && (
                            <span className="spectator-pair-victory">
                              ✓ <span>{text('Победитель', 'Жеңімпаз')}</span>
                            </span>
                          )}
                        </span>
                      ))}
                    </summary>
                    <div className="spectator-match-detail">
                      <div>
                        <h4>
                          {text('Белый', 'Ақ')} · {name(white)}
                        </h4>
                        <p>{white.club}</p>
                        <ScoreSummary state={contest?.state} side="WHITE" />
                      </div>
                      <div>
                        <h4>
                          {text('Синий', 'Көк')} · {name(blue)}
                        </h4>
                        <p>{blue.club}</p>
                        <ScoreSummary state={contest?.state} side="BLUE" />
                      </div>
                      <p className="spectator-match-meta">
                        {mat
                          ? `Татами ${mat.number}`
                          : text('Татами ещё не назначено', 'Татами әлі тағайындалмаған')}
                        {confirmed && ` · ${resultReasonLabel(contest.resultReason, locale)}`}
                        {match.tieBreakRound
                          ? ` · ${text('Дополнительная встреча', 'Қосымша белдесу')}`
                          : ''}
                      </p>
                    </div>
                  </details>
                );
              })}
          </div>
        </section>
      ))}
    </div>
  );
}
