'use client';
import type { ComponentProps } from 'react';
import type { Slot } from '@judo/engine/draw';
import type { TournamentBracket } from './tournament-bracket';
import { useLanguage } from '../../shared/i18n/provider';
import { resultReasonLabel } from '../live/labels';

type Props = Pick<ComponentProps<typeof TournamentBracket>, 'draw' | 'entries' | 'contests'>;

/** Supplementary administration reference; sporting actions stay in the bracket and tatami. */
export function MatchTextList({ draw, entries, contests }: Props) {
  const { text, locale } = useLanguage();
  const names = new Map(entries.map((entry) => [entry.id, `${entry.lastName} ${entry.firstName}`]));
  const results = new Map(contests.map((contest) => [contest.key, contest]));
  function name(slot: Slot, resolved?: string | null): string {
    if (resolved) return names.get(resolved) ?? text('Участник', 'Қатысушы');
    if ('entryId' in slot) return names.get(slot.entryId) ?? text('Участник', 'Қатысушы');
    if ('winnerOf' in slot) return `${text('Победитель', 'Жеңімпаз')} ${slot.winnerOf}`;
    if ('loserOf' in slot) return `${text('Проигравший', 'Жеңілген')} ${slot.loserOf}`;
    return `${text('Группа', 'Топ')} ${slot.pool} · ${slot.place}`;
  }
  return (
    <section className="draw-text-list">
      <h3>{text('Схватки · дополнительно', 'Белдесулер · қосымша')}</h3>
      <ol>
        {draw.matches.map((match) => {
          const contest = results.get(match.id);
          return (
            <li key={match.id}>
              {text('Тур', 'Айналым')} {match.round} · {match.id}:{' '}
              {name(match.white, contest?.whiteEntryId)} — {name(match.blue, contest?.blueEntryId)}
              {contest?.status === 'CONFIRMED' && (
                <>
                  {' '}
                  ·{' '}
                  {contest.winnerEntryId
                    ? `${text('Победитель', 'Жеңімпаз')}: ${names.get(contest.winnerEntryId) ?? '—'}`
                    : text('Без победителя', 'Жеңімпазсыз')}{' '}
                  · {resultReasonLabel(contest.resultReason, locale)}
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
