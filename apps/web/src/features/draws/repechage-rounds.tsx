'use client';
import type { ComponentProps } from 'react';
import type { Draw } from '@judo/engine/draw';
import { MatchList } from './match-list';
import { useLanguage } from '../../shared/i18n/provider';
import './repechage-rounds.css';
type Props = ComponentProps<typeof MatchList>;

export function medalRounds(draw: Draw) {
  const main = draw.matches.filter((m) => !m.stage || m.stage === 'MAIN');
  const final = main.at(-1);
  const semis = final ? main.filter((m) => m.round === final.round - 1) : [];
  const quarters = final ? main.filter((m) => m.round === final.round - 2) : [];
  const branches = draw.matches
    .filter((m) => m.stage === 'REPECHAGE')
    .map((repechage) => ({
      repechage,
      bronze: draw.matches.find(
        (m) =>
          m.stage === 'BRONZE' &&
          [m.white, m.blue].some((s) => 'winnerOf' in s && s.winnerOf === repechage.id),
      ),
    }));
  const directBronzes = draw.matches.filter(
    (m) => m.stage === 'BRONZE' && !branches.some((b) => b.bronze?.id === m.id),
  );
  return { final, semis, quarters, branches, directBronzes };
}
export function RepechageFinal(props: Props) {
  const { text } = useLanguage();
  const { final } = medalRounds(props.draw);
  if (!final) return null;
  return (
    <section className="medal-final" aria-label={text('Финальная схватка', 'Финалдық белдесу')}>
      <h3>{text('Финал · за 1-е место', 'Финал · 1-орын үшін')}</h3>
      <MatchList
        {...props}
        draw={{ ...props.draw, matches: [final] }}
        compact
        stageLabel={text('Финал', 'Финал')}
      />
    </section>
  );
}
export function RepechageRounds(props: Props) {
  const { text } = useLanguage();
  const { branches, semis, quarters, directBronzes } = medalRounds(props.draw);
  const labels: Record<string, string> = {};
  for (const [i, m] of quarters.entries())
    labels[`loser:${m.id}`] =
      text('Проигравший четвертьфинала ', 'Ширек финалда жеңілген ') + (i + 1);
  for (const [i, m] of semis.entries())
    labels[`loser:${m.id}`] =
      text('Проигравший полуфинала ', 'Жартылай финалда жеңілген ') + (i + 1);
  for (const [i, b] of branches.entries())
    labels[`winner:${b.repechage.id}`] =
      text('Победитель утешения ', 'Жұбаныш жеңімпазы ') + (i + 1);
  return (
    <section
      className="medal-rounds"
      aria-label={text('Утешение и схватки за 3-е место', 'Жұбаныш және 3-орын үшін белдесулер')}
    >
      <div className="medal-rounds-heading">
        <h3>
          {branches.length
            ? text('Утешительные встречи и бронза', 'Жұбаныш белдесулері және қола')
            : text('Схватки за бронзу', 'Қола үшін белдесулер')}
        </h3>
        <span>{text('Две встречи — два третьих места', 'Екі белдесу — екі үшінші орын')}</span>
      </div>
      {directBronzes.map((match, i) => (
        <section className="medal-bronze" key={match.id}>
          <h4>
            {text('За 3-е место', '3-орын үшін')} · {branches.length + i + 1}
          </h4>
          <MatchList
            {...props}
            draw={{ ...props.draw, matches: [match] }}
            compact
            stageLabel={text('За 3-е место', '3-орын үшін')}
            slotLabels={labels}
          />
        </section>
      ))}
      {branches.map((b, i) => (
        <div className="medal-branch" key={b.repechage.id}>
          <section>
            <h4>
              {text('Утешительная встреча', 'Жұбаныш белдесуі')} {i + 1}
            </h4>
            <p>{text('Проигравшие четвертьфиналов', 'Ширек финалда жеңілгендер')}</p>
            <MatchList
              {...props}
              draw={{ ...props.draw, matches: [b.repechage] }}
              compact
              stageLabel={text('Утешение', 'Жұбаныш')}
              slotLabels={labels}
            />
          </section>
          <span className="medal-connector" aria-hidden="true">
            →
          </span>
          {b.bronze && (
            <section className="medal-bronze">
              <h4>
                {text('За 3-е место', '3-орын үшін')} · {i + 1}
              </h4>
              <p>
                {text(
                  'Победитель утешения + проигравший полуфинала',
                  'Жұбаныш жеңімпазы + жартылай финалда жеңілген',
                )}
              </p>
              <MatchList
                {...props}
                draw={{ ...props.draw, matches: [b.bronze] }}
                compact
                stageLabel={text('За 3-е место', '3-орын үшін')}
                slotLabels={labels}
              />
            </section>
          )}
        </div>
      ))}
    </section>
  );
}
