'use client';
import { TournamentBracket } from './tournament-bracket';
import { MatchTextList } from './match-text-list';
import { useLanguage } from '../../shared/i18n/provider';
import { ResultPlaces } from './result-places';
import { RoundStandings } from './round-standings';
import { placements, bronzeMedalCount, drawProgress } from '@judo/engine/draw';
import type { ComponentProps } from 'react';
type Props = ComponentProps<typeof TournamentBracket>;
export function CompetitionDraw(props: Props) {
  const { text } = useLanguage();
  const { draw, entries, contests } = props;
  const round = draw.algorithm === 'custom-round-robin-v1';
  const mixed = draw.algorithm === 'custom-pools-knockout-v1';
  const winners = Object.fromEntries(
    contests
      .filter((c) => c.status === 'CONFIRMED' && c.winnerEntryId)
      .map((c) => [c.key, c.winnerEntryId!]),
  );
  const places = placements(draw, winners);
  const progress = drawProgress(draw, winners);
  const groups = mixed && (
    <details className="draw-bottom-section" open>
      <summary>
        {props.readOnly
          ? text('Группы', 'Топтар')
          : text('Группы: пары и таблицы', 'Топтар: жұптар мен кестелер')}
      </summary>
      {draw.pools?.map((pool) => (
        <section className="draw-stage" key={pool.id}>
          <h3>
            {text('Группа', 'Топ')} {pool.id} · {pool.entries.length}{' '}
            {text('участников', 'қатысушы')}
          </h3>
          <RoundStandings draw={draw} entries={entries} contests={contests} poolId={pool.id} />
        </section>
      ))}
    </details>
  );
  return (
    <>
      {round ? (
        <RoundStandings draw={draw} entries={entries} contests={contests} />
      ) : (
        <TournamentBracket {...props} />
      )}
      {groups}
      {progress.pendingReviews.length > 0 && (
        <p className="info-note" role="status">
          {text(
            'Равенство: ожидается решение администратора.',
            'Теңдік: әкімшінің шешімі күтілуде.',
          )}
        </p>
      )}
      {(round || mixed) && !props.readOnly && (
        <details className="draw-bottom-section">
          <summary>{text('Как определяются места', 'Орындар қалай анықталады')}</summary>
          <p className="field-note">
            {draw.tieRanking === 'WINS_ONLY'
              ? text(
                  'Основной круг ранжируется только по числу побед. Двое с равным числом побед проводят новую схватку независимо от личной встречи. Для трёх и более администратор утверждает дополнительную процедуру; до её завершения места и выход из групп не определяются.',
                  'Негізгі айналымда тек жеңістер саны есептеледі. Жеңістері тең екеуі бұрынғы өзара кездесуіне қарамастан қайта белдеседі. Үш не одан көп қатысушы үшін әкімші қосымша рәсімді бекітеді; ол аяқталғанша орындар мен топтан шығу анықталмайды.',
                )
              : draw.tieBreak === 'REMATCH'
                ? text(
                    'Число побед → личные встречи → дополнительные встречи между участниками с равенством. Места и выход из группы ожидают их завершения.',
                    'Жеңістер саны → өзара кездесулер → көрсеткіштері тең қатысушылардың қосымша белдесулері. Орындар мен топтан шығу олар аяқталғаннан кейін анықталады.',
                  )
                : text(
                    'Число побед → победы между участниками с равным числом побед → номер жребия, опубликованный до начала. Пользовательский профиль, соответствие IJF не проверено.',
                    'Жеңістер саны → жеңістері тең қатысушылар арасындағы жеңістер → басталғанға дейін жарияланған жеребе нөмірі. Бапталатын профиль, IJF сәйкестігі тексерілмеген.',
                  )}
          </p>
        </details>
      )}
      <ResultPlaces places={places} entries={entries} bronzeSlots={bronzeMedalCount(draw)} />
      {!props.readOnly && <MatchTextList {...props} />}
    </>
  );
}
