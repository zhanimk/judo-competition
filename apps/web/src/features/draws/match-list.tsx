'use client';
import { SpectatorMatches } from './spectator-matches';
import { useState } from 'react';
import type { Draw, Slot } from '@judo/engine/draw';
import type { Entry } from '../tournaments/types';
import { ScoreSummary, type ResultContest } from '../live/results-table';
import { resultReasonLabel } from '../live/labels';
import { useLanguage } from '../../shared/i18n/provider';
import './match-list.css';
export function MatchList({
  draw,
  entries,
  contests,
  tatamis,
  busy,
  canAssign,
  onAssign,
  readOnly = false,
  compact = false,
  stageLabel,
  slotLabels = {},
}: {
  draw: Draw;
  entries: Entry[];
  contests: (ResultContest & { tatamiId: string | null })[];
  tatamis: { id: string; number: number }[];
  busy: boolean;
  canAssign: boolean;
  onAssign: (id: string) => void;
  readOnly?: boolean;
  compact?: boolean;
  stageLabel?: string;
  slotLabels?: Readonly<Record<string, string>>;
}) {
  const { text, locale } = useLanguage();
  const contestByKey = new Map(contests.map((c) => [c.key, c]));
  const [chosenRound, setRound] = useState<number | null>(null);
  const rounds = [...new Set(draw.matches.map((m) => m.round))].sort((a, b) => a - b);
  const round =
    chosenRound !== null && rounds.includes(chosenRound)
      ? chosenRound
      : (rounds.find((r) =>
          draw.matches.some((m) => m.round === r && contestByKey.get(m.id)?.status !== 'CONFIRMED'),
        ) ?? rounds[0]);
  const visible = draw.matches.filter((m) => m.round === round);
  const roundRobin =
    draw.algorithm === 'custom-round-robin-v1' || draw.matches.every((m) => m.stage === 'POOL');
  const members = new Set(
    draw.matches.flatMap((m) =>
      [m.white, m.blue].flatMap((s) => ('entryId' in s ? [s.entryId] : [])),
    ),
  );
  const playing = new Set(
    visible.flatMap((m) => [m.white, m.blue].flatMap((s) => ('entryId' in s ? [s.entryId] : []))),
  );
  const resting = roundRobin ? entries.filter((e) => members.has(e.id) && !playing.has(e.id)) : [];
  const athlete = (slot: Slot, winner: boolean, side: 'WHITE' | 'BLUE', c?: ResultContest) => {
    const e = 'entryId' in slot ? entries.find((e) => e.id === slot.entryId) : null;
    const fallback =
      'winnerOf' in slot
        ? (slotLabels[`winner:${slot.winnerOf}`] ??
          text('Победитель ', 'Жеңімпаз ') + slot.winnerOf)
        : 'loserOf' in slot
          ? (slotLabels[`loser:${slot.loserOf}`] ??
            text('Проигравший ', 'Жеңілген ') + slot.loserOf)
          : 'pool' in slot
            ? text('Группа ', 'Топ ') + slot.pool + ' · ' + slot.place
            : text('Ожидаем участника', 'Қатысушыны күтеміз');
    return (
      <div className={`pair-athlete ${side.toLowerCase()} ${winner ? 'winner' : ''}`}>
        <span className="pair-side">
          {side === 'WHITE' ? text('БЕЛЫЙ', 'АҚ') : text('СИНИЙ', 'КӨК')}
        </span>
        <div className="pair-identity">
          <strong>{e ? `${e.lastName} ${e.firstName}` : fallback}</strong>
          <small>{e?.club}</small>
          {winner && <span className="pair-winner">✓ {text('Победитель', 'Жеңімпаз')}</span>}
        </div>
        {c?.status === 'CONFIRMED' &&
          (roundRobin ? (
            <details className="pair-score-details">
              <summary>{text('Оценки', 'Бағалар')}</summary>
              <ScoreSummary state={c.state} side={side} />
            </details>
          ) : (
            <ScoreSummary state={c.state} side={side} />
          ))}
      </div>
    );
  };
  if (readOnly && roundRobin)
    return <SpectatorMatches draw={draw} entries={entries} contests={contests} tatamis={tatamis} />;
  return (
    <section className={`match-schedule ${roundRobin ? 'round-robin-schedule' : ''}`}>
      {!compact && (
        <>
          <div className="round-section-heading">
            <h3>
              {draw.size === 2
                ? text('Финальная схватка', 'Финалдық белдесу')
                : text('Встречи по турам', 'Айналымдар бойынша белдесулер')}
            </h3>
            <span>
              {draw.matches.length} {text('схваток', 'белдесу')}
            </span>
          </div>
          <details className="pair-explanation">
            <summary>{text('О формате', 'Формат туралы')}</summary>
            <p className="field-note">
              {draw.size === 2
                ? text(
                    'Два участника — одна встреча за первое место.',
                    'Екі қатысушы — бірінші орын үшін бір белдесу.',
                  )
                : roundRobin
                  ? text(
                      'Основной круг: каждый с каждым, включая одноклубников. При равенстве могут назначаться дополнительные встречи.',
                      'Негізгі айналым: клубтастарды қоса, әрқайсысы әрқайсысымен. Көрсеткіштер тең болса, қосымша белдесулер тағайындалуы мүмкін.',
                    )
                  : text(
                      'Следующие пары заполняются после подтверждения результатов.',
                      'Келесі жұптар нәтижелер расталғаннан кейін толтырылады.',
                    )}
            </p>
          </details>
        </>
      )}
      {rounds.length > 1 && (
        <nav className="round-tabs" aria-label={text('Туры', 'Айналымдар')}>
          {rounds.map((r) => {
            const matches = draw.matches.filter((m) => m.round === r);
            const done = matches.filter(
              (m) => contestByKey.get(m.id)?.status === 'CONFIRMED',
            ).length;
            return (
              <button
                key={r}
                aria-pressed={r === round}
                className={r === round ? 'selected' : ''}
                onClick={() => setRound(r)}
              >
                {text('Тур', 'Айналым')} {r}
                <small>
                  {done} / {matches.length} {text('готово', 'аяқталды')}
                </small>
              </button>
            );
          })}
        </nav>
      )}
      {resting.length > 0 && (
        <p className="round-rest">
          {text('Отдых в этом туре', 'Осы айналымда демалады')}:{' '}
          <strong>{resting.map((e) => `${e.lastName} ${e.firstName}`).join(', ')}</strong>
        </p>
      )}
      <div className="pair-grid">
        {visible.map((m) => {
          const c = contestByKey.get(m.id);
          const mat = tatamis.find((t) => t.id === c?.tatamiId);
          const done = c?.status === 'CONFIRMED';
          const white = c?.whiteEntryId ? { entryId: c.whiteEntryId } : m.white;
          const blue = c?.blueEntryId ? { entryId: c.blueEntryId } : m.blue;
          return (
            <article className="pair-card" key={m.id}>
              <header>
                <strong>
                  {roundRobin ? (
                    m.tieBreakRound ? (
                      text('Дополнительная', 'Қосымша')
                    ) : (
                      `№ ${draw.matches.findIndex((match) => match.id === m.id) + 1}`
                    )
                  ) : (
                    <>
                      {(m.tieBreakRound
                        ? text('Дополнительная встреча', 'Қосымша белдесу')
                        : stageLabel) ??
                        (draw.size === 2
                          ? text('Финал', 'Финал')
                          : `${text('Тур', 'Айналым')} ${m.round}`)}{' '}
                      <small>· {m.id}</small>
                    </>
                  )}
                </strong>
                <span
                  className={`match-badge ${done ? 'done' : c?.status === 'ACTIVE' ? 'active' : ''}`}
                >
                  {done
                    ? text('Завершена', 'Аяқталды')
                    : c?.status === 'ACTIVE'
                      ? text('На табло', 'Таблода')
                      : c?.status === 'READY'
                        ? text('Готова', 'Дайын')
                        : text('Ожидание', 'Күту')}
                </span>
              </header>
              {athlete(
                white,
                done && 'entryId' in white && white.entryId === c.winnerEntryId,
                'WHITE',
                c,
              )}
              {athlete(
                blue,
                done && 'entryId' in blue && blue.entryId === c.winnerEntryId,
                'BLUE',
                c,
              )}
              <footer>
                <span>
                  {mat
                    ? `Татами ${mat.number}`
                    : roundRobin
                      ? '—'
                      : text('Татами не назначено', 'Татами тағайындалмаған')}
                </span>
                {done ? (
                  <strong>{resultReasonLabel(c.resultReason, locale)}</strong>
                ) : !readOnly && !mat && c?.status === 'READY' ? (
                  <button disabled={busy || !canAssign} onClick={() => onAssign(c.id)}>
                    {text('В очередь', 'Кезекке')} ↗
                  </button>
                ) : null}
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}
