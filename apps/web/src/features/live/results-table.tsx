'use client';
import { resultReasonLabel } from './labels';
import type { MatchState } from '@judo/engine/match';
import { scoreboardScores } from '@judo/engine/match';
import type { Entry } from '../tournaments/types';
import '../draws/match-list.css';
import { useLanguage } from '../../shared/i18n/provider';
export type ResultContest = {
  id: string;
  key: string;
  status: string;
  whiteEntryId?: string | null;
  blueEntryId?: string | null;
  winnerEntryId?: string | null;
  resultReason?: string | null;
  state?: MatchState | null;
};
export function ScoreSummary({
  state,
  side,
}: {
  state?: MatchState | null;
  side: 'WHITE' | 'BLUE';
}) {
  if (!state) return null;
  const score = scoreboardScores(state, side);
  return (
    <div className="result-score-chips">
      {(['IPPON', 'WAZA_ARI', 'YUKO', 'SHIDO'] as const).map((k) => (
        <span className={k.toLowerCase()} key={k}>
          <small>{k.replace('_', '-')}</small>
          <b>{score[k]}</b>
        </span>
      ))}
    </div>
  );
}
export function ResultsTable({
  entries,
  contests,
}: {
  entries: Entry[];
  contests: ResultContest[];
}) {
  const { text, locale } = useLanguage();
  const rows = contests.filter((c) => c.status === 'CONFIRMED');
  if (!rows.length) return null;
  const name = (id?: string | null) => {
    const e = entries.find((e) => e.id === id);
    return e ? `${e.lastName} ${e.firstName}` : '—';
  };
  return (
    <section className="results-table">
      <h3>{text('Подтверждённые результаты', 'Расталған нәтижелер')}</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{text('Схватка', 'Белдесу')}</th>
              <th>{text('Белый', 'Ақ')}</th>
              <th>{text('Синий', 'Көк')}</th>
              <th>{text('Победитель', 'Жеңімпаз')}</th>
              <th>{text('Основание', 'Негіздеме')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td data-label={text('Схватка', 'Белдесу')}>{c.key}</td>
                {(['WHITE', 'BLUE'] as const).map((side) => {
                  return (
                    <td
                      key={side}
                      data-label={side === 'WHITE' ? text('Белый', 'Ақ') : text('Синий', 'Көк')}
                    >
                      {name(side === 'WHITE' ? c.whiteEntryId : c.blueEntryId)}
                      <ScoreSummary state={c.state} side={side} />
                    </td>
                  );
                })}
                <td data-label={text('Победитель', 'Жеңімпаз')}>
                  <strong>{name(c.winnerEntryId)}</strong>
                </td>
                <td data-label={text('Основание', 'Негіздеме')}>
                  {resultReasonLabel(c.resultReason, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
